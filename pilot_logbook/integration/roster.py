"""Upcoming rostered flights, sent by the Roster Manager add-on, for pre-filling new logbook entries.

Each sector arrives with its planned departure/arrival as airport-local (or UTC) times plus the
airport's time zone. Here they're turned into UTC, and the planned flight time is split into day
and night (CASA night: sun more than 6 degrees below the horizon, i.e. between the end of evening
civil twilight and the start of morning civil twilight) along the straight-line route.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

KEEP_PAST = timedelta(days=3)
KEEP_FUTURE = timedelta(days=21)

# Airport positions (degrees, south / west negative) for the day/night split.
# An airport missing here just means the flight time is offered as all day.
AIRPORTS = {
    "MEL": (-37.673, 144.843), "AVV": (-38.039, 144.469), "MQL": (-34.229, 142.086),
    "SYD": (-33.946, 151.177), "WSI": (-33.893, 150.718), "CBR": (-35.307, 149.195), "NTL": (-32.795, 151.834),
    "CFS": (-30.320, 153.116), "PQQ": (-31.436, 152.863), "BNK": (-28.834, 153.562), "ABX": (-36.068, 146.958),
    "WGA": (-35.165, 147.466), "TMW": (-31.084, 150.847), "ARM": (-30.528, 151.617), "DBO": (-32.217, 148.575),
    "OAG": (-33.381, 149.133), "MYA": (-35.898, 150.144), "LDH": (-31.538, 159.077),
    "BNE": (-27.384, 153.117), "OOL": (-28.164, 153.505), "MCY": (-26.603, 153.091), "CNS": (-16.886, 145.755),
    "TSV": (-19.252, 146.765), "MKY": (-21.172, 149.180), "PPP": (-20.495, 148.552), "HTI": (-20.358, 148.952),
    "ROK": (-23.382, 150.475), "GLT": (-23.870, 151.223), "BDB": (-24.904, 152.319), "HVB": (-25.319, 152.880),
    "EMD": (-23.567, 148.179), "ISA": (-20.664, 139.489),
    "HBA": (-42.836, 147.510), "LST": (-41.545, 147.214), "DPO": (-41.170, 146.430),
    "ADL": (-34.945, 138.531), "PLO": (-34.605, 135.880),
    "DRW": (-12.415, 130.877), "ASP": (-23.807, 133.902), "AYQ": (-25.186, 130.976),
    "PER": (-31.940, 115.967), "BME": (-17.945, 122.232), "KTA": (-20.712, 116.773), "PHE": (-20.378, 118.626),
    "KGI": (-30.789, 121.462), "KNX": (-15.778, 128.708),
    "AKL": (-37.008, 174.792), "WLG": (-41.327, 174.805), "CHC": (-43.489, 172.532), "ZQN": (-45.021, 168.739),
    "DUD": (-45.928, 170.198),
    "NAN": (-17.755, 177.443), "APW": (-13.830, -172.008), "RAR": (-21.203, -159.806), "VLI": (-17.699, 168.320),
    "NOU": (-22.015, 166.213), "TBU": (-21.241, -175.150), "POM": (-9.443, 147.220), "HIR": (-9.428, 160.055),
    "DPS": (-8.748, 115.167), "DIL": (-8.546, 125.525), "HND": (35.549, 139.780), "NRT": (35.765, 140.386),
    "KIX": (34.427, 135.244), "HKG": (22.308, 113.918), "SIN": (1.364, 103.991), "DOH": (25.273, 51.608),
    "LAX": (33.942, -118.408),
}


class RosterError(ValueError):
    pass


def _utc(stamp: dict) -> datetime:
    try:
        local = datetime.fromisoformat(str(stamp["dt"])[:16])
        zone = timezone.utc if stamp.get("basis") == "utc" else ZoneInfo(str(stamp["tz"]))
    except Exception as err:  # noqa: BLE001
        raise RosterError(f"bad time {stamp!r}: {err}") from err
    return local.replace(tzinfo=zone).astimezone(timezone.utc)


def _minutes(hhmm: str) -> int | None:
    try:
        h, m = str(hhmm).strip().split(":")
        return int(h) * 60 + int(m)
    except (ValueError, AttributeError):
        return None


def sun_elevation(when: datetime, lat: float, lon: float) -> float:
    """Sun's elevation in degrees (NOAA approximation, good to a fraction of a degree)."""
    t = when.astimezone(timezone.utc)
    doy = t.timetuple().tm_yday
    hours = t.hour + t.minute / 60 + t.second / 3600
    g = 2 * math.pi / 365 * (doy - 1 + (hours - 12) / 24)
    eqt = 229.18 * (0.000075 + 0.001868 * math.cos(g) - 0.032077 * math.sin(g)
                    - 0.014615 * math.cos(2 * g) - 0.040849 * math.sin(2 * g))
    decl = (0.006918 - 0.399912 * math.cos(g) + 0.070257 * math.sin(g) - 0.006758 * math.cos(2 * g)
            + 0.000907 * math.sin(2 * g) - 0.002697 * math.cos(3 * g) + 0.00148 * math.sin(3 * g))
    solar_min = hours * 60 + eqt + 4 * lon
    ha = math.radians(solar_min / 4 - 180)
    la = math.radians(lat)
    s = math.sin(la) * math.sin(decl) + math.cos(la) * math.cos(decl) * math.cos(ha)
    return math.degrees(math.asin(max(-1.0, min(1.0, s))))


def _along(a, b, f):
    """Point a fraction f of the way along the great circle from a to b."""
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    d = 2 * math.asin(math.sqrt(math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2))
    if d < 1e-9:
        return a
    A, B = math.sin((1 - f) * d) / math.sin(d), math.sin(f * d) / math.sin(d)
    x = A * math.cos(la1) * math.cos(lo1) + B * math.cos(la2) * math.cos(lo2)
    y = A * math.cos(la1) * math.sin(lo1) + B * math.cos(la2) * math.sin(lo2)
    z = A * math.sin(la1) + B * math.sin(la2)
    return math.degrees(math.atan2(z, math.hypot(x, y))), math.degrees(math.atan2(y, x))


def night_fraction(dep: datetime, arr: datetime, frm: str, to: str) -> float | None:
    """Share of the flight flown at night, checked once a minute along the route. None if a port is unknown."""
    a, b = AIRPORTS.get(frm), AIRPORTS.get(to)
    span = (arr - dep).total_seconds() / 60
    if not a or not b or span <= 0:
        return None
    steps = max(1, int(round(span)))
    night = 0
    for i in range(steps):
        f = (i + 0.5) / steps
        lat, lon = _along(a, b, f)
        if sun_elevation(dep + timedelta(minutes=span * f), lat, lon) < -6:
            night += 1
    return night / steps


def normalize(sectors: list, now: datetime | None = None) -> list[dict]:
    """Sector list from Roster Manager -> what the app needs, keeping roughly the next three weeks."""
    now = now or datetime.now(timezone.utc)
    out = []
    for s in sectors:
        if not isinstance(s, dict):
            continue
        try:
            dep, arr = _utc(s["dep"]), _utc(s["arr"])
        except (RosterError, KeyError, TypeError):
            continue
        if arr <= dep or arr < now - KEEP_PAST or dep > now + KEEP_FUTURE:
            continue
        frm, to = str(s.get("from", "")).upper()[:4], str(s.get("to", "")).upper()[:4]
        block = int(round((arr - dep).total_seconds() / 60))
        ft = _minutes(s.get("flightTime")) or block
        frac = night_fraction(dep, arr, frm, to)
        night = None if frac is None else int(round(ft * frac))
        out.append({
            "date": str(s.get("date", ""))[:10], "flight": str(s.get("flight", ""))[:12], "pax": bool(s.get("pax")),
            "from": frm, "to": to, "dep": int(dep.timestamp() * 1000), "arr": int(arr.timestamp() * 1000),
            "aircraft": str(s.get("aircraft", ""))[:8], "ftMin": ft, "nightMin": night,
        })
    out.sort(key=lambda x: x["dep"])
    return out
