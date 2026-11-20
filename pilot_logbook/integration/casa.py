"""Keeps a CASA (Excel Pilot Logbook, Australia) workbook in step with the flights in Home Assistant.

You upload your own workbook once (the "template"). Every time flights change, a copy is rebuilt:
  * rows already in the template stay exactly as they are, except 737-family aircraft types are
    corrected from the fleet rules (and your per-tail choices);
  * every flight dated after the template's last flight is written as a new row in the CASA
    column order (A..AJ), with the workbook's own formulas in AK..AM.

The workbook is edited at the XML level, cell by cell, so everything else in it (formulas, formats,
dashboards, charts) is left exactly as it was. Nothing here is uploaded anywhere: the template and
the rebuilt workbook live only in <config>/pilot_logbook/.
"""
from __future__ import annotations

import datetime as dt
import io
import re
import zipfile
from xml.sax.saxutils import escape

TEMPLATE_NAME = "casa_template.xlsx"
OUTPUT_NAME = "CASA-Logbook.xlsx"
SHEET_NAME = "Logbook"
TABLE_NAME = "Entries"
FIRST_DATA_ROW = 6          # row 5 is the brought-forward ("Imported Paper Logbooks") line
RETYPE_FROM = "2017-12-01"  # only correct aircraft types from the 737 era onwards
EXCEL_EPOCH = dt.date(1899, 12, 30)

COLS = [  # A..AJ (36 columns) - the cells this module writes
    "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T",
    "U", "V", "W", "X", "Y", "Z", "AA", "AB", "AC", "AD", "AE", "AF", "AG", "AH", "AI", "AJ",
]
# Cell styles used by the workbook for a flight row (taken from its own rows).
STYLE = {"A": "386", "D": "561", "E": "237", "G": "221", "H": "227", "I": "223",
         **{c: "227" for c in ("J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "V", "AB", "AC")},
         **{c: "229" for c in ("W", "X", "Y", "Z")}, "AA": "223", "AD": "221",
         **{c: "228" for c in ("AE", "AF", "AG", "AH")}, "AI": "112", "AJ": "112"}


class CasaError(Exception):
    """The uploaded file is not a workbook this module understands."""


# ---------------------------------------------------------------- fleet rules (same as the app)
def tail_rule_type(tail: str) -> str:
    t = (tail or "").upper().strip()
    if not re.fullmatch(r"[A-Z0-9]{3}", t):
        return ""
    if t in ("VBY", "VBZ") or "NBP" <= t <= "NVW":
        return "B737"
    if t in ("REX", "RQP") or re.match(r"(VO|VU|YF|YQ|YW|YI|YV)", t) or "IJQ" <= t <= "IXK":
        return "B738"
    if t[0] == "8":
        return "B38M"
    return ""


# ---------------------------------------------------------------- workbook plumbing
def _sheet_path(z: zipfile.ZipFile) -> str:
    wb = z.read("xl/workbook.xml").decode("utf-8")
    m = re.search(r'<sheet [^>]*name="%s"[^>]*r:id="([^"]+)"' % SHEET_NAME, wb)
    if not m:
        raise CasaError(f'No "{SHEET_NAME}" sheet in this workbook')
    rels = z.read("xl/_rels/workbook.xml.rels").decode("utf-8")
    t = re.search(r'<Relationship [^>]*Id="%s"[^>]*Target="([^"]+)"' % re.escape(m.group(1)), rels) or \
        re.search(r'<Relationship [^>]*Target="([^"]+)"[^>]*Id="%s"' % re.escape(m.group(1)), rels)
    if not t:
        raise CasaError("Workbook is missing its sheet links")
    target = t.group(1).lstrip("/")
    return target if target.startswith("xl/") else "xl/" + target


def _table_path(z: zipfile.ZipFile) -> str:
    for name in z.namelist():
        if name.startswith("xl/tables/") and name.endswith(".xml"):
            if re.search(r'<table [^>]*name="%s"' % TABLE_NAME, z.read(name).decode("utf-8")):
                return name
    raise CasaError(f'No "{TABLE_NAME}" table in this workbook')


def _shared_strings(z: zipfile.ZipFile) -> list[str]:
    try:
        xml = z.read("xl/sharedStrings.xml").decode("utf-8")
    except KeyError:
        return []
    out = []
    for si in re.findall(r"<si>(.*?)</si>", xml, re.S):
        out.append("".join(re.findall(r"<t[^>]*>(.*?)</t>", si, re.S)))
    return out


def _cell_text(cell: str, strings: list[str]) -> str:
    v = re.search(r"<v>(.*?)</v>", cell, re.S)
    if 't="s"' in cell and v:
        i = int(v.group(1))
        return strings[i] if i < len(strings) else ""
    t = re.search(r"<t[^>]*>(.*?)</t>", cell, re.S)
    if t:
        return t.group(1)
    return v.group(1) if v else ""


ROW_RE = re.compile(r'<row r="(\d+)"[^>]*?(?:/>|>.*?</row>)', re.S)
CELL_RE = re.compile(r'<c r="([A-Z]+)(\d+)"[^>]*?(?:/>|>.*?</c>)', re.S)


def inspect_template(data: bytes) -> dict:
    """Check an uploaded workbook and return its last flight date and row."""
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as err:
        raise CasaError("That file is not an Excel workbook (.xlsx)") from err
    sheet = z.read(_sheet_path(z)).decode("utf-8")
    _table_path(z)
    last_row, last_serial = 0, 0
    for m in ROW_RE.finditer(sheet):
        r = int(m.group(1))
        if r < FIRST_DATA_ROW:
            continue
        a = re.search(r'<c r="A%d"[^>]*>(?:<v>([\d.]+)</v>)' % r, m.group(0))
        if a:
            last_row, last_serial = r, int(float(a.group(1)))
    if not last_row:
        raise CasaError("Could not find any dated flights in the Logbook sheet")
    cutoff = EXCEL_EPOCH + dt.timedelta(days=last_serial)
    return {"last_row": last_row, "cutoff": cutoff.isoformat()}


# ---------------------------------------------------------------- one flight -> CASA cells
def _num(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def casa_values(f: dict) -> dict:
    """Same mapping as the app's 'CASA' export: returns {column: value} for one flight."""
    r1 = lambda x: round(_num(x) + 1e-9, 1)
    c: dict = {}
    c["A"] = f.get("date", "")
    c["B"] = f.get("type") or ""
    c["C"] = f.get("aircraft") or ""
    c["F"] = f.get("route") or ""
    me = _num(f.get("me")) > 0 or not _num(f.get("se")) > 0
    pic_d, pic_n, sic_d, sic_n = (_num(f.get(k)) for k in ("picDay", "picNight", "sicDay", "sicNight"))
    pic = (not me) or f.get("role") == "PIC" or (not (sic_d or sic_n) and (pic_d or pic_n))
    c["D"] = "Self" if pic else (f.get("picName") or "")
    c["E"] = ((f.get("sicName") or "") if me else "") if pic else "Self"
    if not (pic_d or pic_n or sic_d or sic_n):
        if pic:
            pic_d, pic_n = _num(f.get("fltDay")), _num(f.get("fltNight"))
        else:
            sic_d, sic_n = _num(f.get("fltDay")), _num(f.get("fltNight"))
    if me:
        c["Q"], c["R"] = r1(pic_d), r1(pic_n)      # ME command
        c["S"], c["T"] = r1(sic_d), r1(sic_n)      # ME co-pilot
    else:
        c["K"], c["L"] = r1(pic_d + sic_d), r1(pic_n + sic_n)   # SE command
    c["U"] = r1(f.get("actual"))                   # instrument in flight
    return {k: v for k, v in c.items() if v not in ("", 0, 0.0, None)}


def _cell_xml(col: str, row: int, value) -> str:
    s = f' s="{STYLE[col]}"' if col in STYLE else ""
    ref = f"{col}{row}"
    if value in (None, ""):
        return f'<c r="{ref}"{s}/>'
    if col == "A":
        serial = (dt.date.fromisoformat(value) - EXCEL_EPOCH).days
        return f'<c r="{ref}"{s}><v>{serial}</v></c>'
    if isinstance(value, (int, float)):
        return f'<c r="{ref}"{s}><v>{value:g}</v></c>'
    return f'<c r="{ref}"{s} t="inlineStr"><is><t>{escape(str(value))}</t></is></c>'


def _new_row(row: int, values: dict) -> str:
    cells = "".join(_cell_xml(col, row, values.get(col)) for col in COLS)
    cells += (f'<c r="AK{row}" s="202" t="str"><f>IF(AJ{row}="","",MOD(AJ{row}-AI{row},1))</f></c>'
              f'<c r="AL{row}" s="206"><f>SUM(G{row}:T{row})</f></c>'
              f'<c r="AM{row}" s="182" t="str"><f>IF(SUM(U{row}:Z{row})&gt;0,$A{row},"")</f></c>')
    return f'<row r="{row}" spans="1:39" ht="17" customHeight="1">{cells}</row>'


def _fill_existing_row(row_xml: str, row: int, values: dict) -> str:
    """Replace cells A..AJ of a prepared empty row, keeping its formula cells (AK..) untouched."""
    keep = [m.group(0) for m in CELL_RE.finditer(row_xml) if m.group(1) not in COLS]
    head = re.match(r"<row [^>]*?>", row_xml).group(0)
    if head.endswith("/>"):
        head = head[:-2] + ">"
    cells = "".join(_cell_xml(col, row, values.get(col)) for col in COLS)
    return f"{head}{cells}{''.join(keep)}</row>"


def _retype_cell(cell: str, new_type: str) -> str:
    m = re.match(r'<c r="(B\d+)"([^>]*?)(?:/>|>.*?</c>)', cell, re.S)
    attrs = re.sub(r'\s*t="[^"]*"', "", m.group(2)).rstrip("/")
    return f'<c r="{m.group(1)}"{attrs} t="inlineStr"><is><t>{escape(new_type)}</t></is></c>'


# ---------------------------------------------------------------- build
def build(template: bytes, flights: list[dict], overrides: dict | None = None) -> tuple[bytes, dict]:
    """Return (workbook bytes, summary). `flights` are the app's flight records."""
    overrides = {k.upper(): v for k, v in (overrides or {}).items()}
    info = inspect_template(template)
    cutoff, last_row = info["cutoff"], info["last_row"]
    zin = zipfile.ZipFile(io.BytesIO(template))
    sheet_path, table_path = _sheet_path(zin), _table_path(zin)
    strings = _shared_strings(zin)
    sheet = zin.read(sheet_path).decode("utf-8")

    # 1) correct 737-family types in rows already in the workbook
    retyped = []

    def fix_row(m):
        r = int(m.group(1))
        row_xml = m.group(0)
        if r < FIRST_DATA_ROW or r > last_row:
            return row_xml
        a = re.search(r'<c r="A%d"[^>]*><v>([\d.]+)</v>' % r, row_xml)
        if not a:
            return row_xml
        date = (EXCEL_EPOCH + dt.timedelta(days=int(float(a.group(1))))).isoformat()
        if date < RETYPE_FROM:
            return row_xml
        cells = {cm.group(1): cm.group(0) for cm in CELL_RE.finditer(row_xml)}
        tail = _cell_text(cells.get("C", ""), strings).upper().strip()
        have = _cell_text(cells.get("B", ""), strings).strip()
        want = overrides.get(tail) or tail_rule_type(tail)
        if want and have != want and "B" in cells:
            retyped.append({"row": r, "date": date, "tail": tail, "from": have, "to": want})
            return row_xml.replace(cells["B"], _retype_cell(cells["B"], want), 1)
        return row_xml

    sheet = ROW_RE.sub(fix_row, sheet)

    # 2) write every flight after the workbook's last date as a new row
    new = sorted((f for f in flights if f.get("date", "") > cutoff and not f.get("deleted") and not f.get("kind")),
                 key=lambda f: (f.get("date", ""), f.get("time") or "", f.get("created") or 0))
    rows = {int(m.group(1)): m for m in ROW_RE.finditer(sheet)}
    pieces, appended, row_no = [], [], last_row
    replace = {}
    for f in new:
        row_no += 1
        vals = casa_values(f)
        if row_no in rows:
            replace[row_no] = _fill_existing_row(rows[row_no].group(0), row_no, vals)
        else:
            appended.append(_new_row(row_no, vals))
    if replace:
        sheet = ROW_RE.sub(lambda m: replace.get(int(m.group(1)), m.group(0)), sheet)
    if appended:
        sheet = sheet.replace("</sheetData>", "".join(appended) + "</sheetData>", 1)

    # 3) grow the table, the sheet's used range and recalc on open
    table = zin.read(table_path).decode("utf-8")
    tref = re.search(r'<table [^>]*\bref="([A-Z]+)(\d+):([A-Z]+)(\d+)"', table)
    end = max(int(tref.group(4)), row_no)
    table = table.replace(tref.group(0), tref.group(0).replace(
        f'ref="{tref.group(1)}{tref.group(2)}:{tref.group(3)}{tref.group(4)}"',
        f'ref="{tref.group(1)}{tref.group(2)}:{tref.group(3)}{end}"'), 1)
    table = re.sub(r'(<autoFilter [^>]*\bref="[A-Z]+\d+:[A-Z]+)(\d+)"', lambda m: f'{m.group(1)}{end}"', table, 1)
    dim = re.search(r'<dimension ref="([A-Z]+\d+):([A-Z]+)(\d+)"/>', sheet)
    if dim and int(dim.group(3)) < end:
        sheet = sheet.replace(dim.group(0), f'<dimension ref="{dim.group(1)}:{dim.group(2)}{end}"/>', 1)

    workbook = zin.read("xl/workbook.xml").decode("utf-8")
    if "fullCalcOnLoad" not in workbook:
        workbook = re.sub(r"<calcPr([^>]*?)/>", r'<calcPr\1 fullCalcOnLoad="1"/>', workbook, 1)
    rels = zin.read("xl/_rels/workbook.xml.rels").decode("utf-8")
    rels = re.sub(r'<Relationship [^>]*calcChain[^>]*/>', "", rels)
    ctypes = zin.read("[Content_Types].xml").decode("utf-8")
    ctypes = re.sub(r'<Override [^>]*calcChain[^>]*/>', "", ctypes)

    changed = {sheet_path: sheet, table_path: table, "xl/workbook.xml": workbook,
               "xl/_rels/workbook.xml.rels": rels, "[Content_Types].xml": ctypes}
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            if item.filename == "xl/calcChain.xml":
                continue              # Excel rebuilds it; stale entries would trip it up
            data = changed[item.filename].encode("utf-8") if item.filename in changed else zin.read(item.filename)
            zout.writestr(item, data)
    summary = {
        "cutoff": cutoff,
        "template_last_row": last_row,
        "new_flights": len(new),
        "last_row": row_no,
        "new_hours": round(sum(_num(f.get("total")) for f in new), 1),
        "retyped": retyped,
        "built": dt.datetime.now().isoformat(timespec="seconds"),
    }
    return out.getvalue(), summary
