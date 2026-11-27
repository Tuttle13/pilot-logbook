"""Pilot Logbook: keeps flight records in Home Assistant and serves an iPad web app.

Web app:  https://<ha>/pilot_logbook/index.html   (static, no data in it)
API:      GET  /api/pilot_logbook/flights          -> {"flights": [...], "server_time": ms}
          POST /api/pilot_logbook/flights          -> save up to 500 flights {"flights": [...]}
          PUT  /api/pilot_logbook/flights/{id}     -> save one flight (last write wins on "updated")
          GET  /api/pilot_logbook/casa              -> CASA workbook status
          PUT  /api/pilot_logbook/casa/template     -> upload your CASA Excel workbook (admin only)
          GET  /api/pilot_logbook/casa.xlsx         -> the CASA workbook, rebuilt with every flight
          GET  /api/pilot_logbook/roster            -> upcoming rostered flights (for pre-filling new entries)
          POST /api/pilot_logbook/roster            -> replace them (sent by the Roster Manager add-on; admin only)
All API routes need a normal Home Assistant access token.
Flights live in <config>/.storage/pilot_logbook.flights and the CASA files in <config>/pilot_logbook/,
so HA backups include them.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from pathlib import Path

from aiohttp import web

from homeassistant.components import frontend
from homeassistant.components.http import HomeAssistantView, StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.event import async_call_later
from homeassistant.helpers.storage import Store

from . import casa
from . import roster

try:
    from homeassistant.helpers.http import KEY_HASS
except ImportError:  # older cores
    KEY_HASS = "hass"

from .const import (
    DOMAIN,
    EVENT_FLIGHT_SAVED,
    PANEL_URL,
    STATIC_URL,
    STORAGE_KEY,
    STORAGE_VERSION,
)

_LOGGER = logging.getLogger(__name__)

ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
MAX_BODY = 128 * 1024  # one flight record; generous
MAX_BATCH = 500
MAX_BATCH_BODY = 8 * 1024 * 1024
MAX_WORKBOOK = 20 * 1024 * 1024
CFG_TAILS = "cfg-tailtypes"
REBUILD_DELAY = 5  # seconds after the last change
_HTTP_DONE = f"{DOMAIN}_http_registered"


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    store: Store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
    data = await store.async_load()
    if not isinstance(data, dict) or not isinstance(data.get("flights"), dict):
        data = {"flights": {}}

    roster_store: Store = Store(hass, 1, f"{DOMAIN}.roster")
    roster_data = await roster_store.async_load()
    if not isinstance(roster_data, dict) or not isinstance(roster_data.get("sectors"), list):
        roster_data = {"received": None, "sectors": []}

    hass.data[DOMAIN] = {"store": store, "data": data, "lock": asyncio.Lock(),
                         "casa": {"summary": None, "error": None, "pending": None, "building": False},
                         "roster_store": roster_store, "roster": roster_data}

    # HTTP routes cannot be removed again, so only register them once per HA run.
    if not hass.data.get(_HTTP_DONE):
        await hass.http.async_register_static_paths(
            [StaticPathConfig(STATIC_URL, str(Path(__file__).parent / "www"), False)]
        )
        hass.http.register_view(FlightsView())
        hass.http.register_view(FlightView())
        hass.http.register_view(CasaInfoView())
        hass.http.register_view(CasaTemplateView())
        hass.http.register_view(CasaFileView())
        hass.http.register_view(RosterView())
        hass.data[_HTTP_DONE] = True

    frontend.async_register_built_in_panel(
        hass,
        component_name="iframe",
        sidebar_title="Pilot Log",
        sidebar_icon="mdi:airplane",
        frontend_url_path=PANEL_URL,
        config={"url": f"{STATIC_URL}/index.html"},
        require_admin=False,
    )
    _LOGGER.info("Pilot Logbook ready with %d flights", len(data["flights"]))
    if Path(_casa_path(hass, casa.TEMPLATE_NAME)).exists():
        _schedule_casa(hass, 1)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    frontend.async_remove_panel(hass, PANEL_URL)
    hass.data.pop(DOMAIN, None)
    return True


def _state(request):
    hass = request.app[KEY_HASS]
    return hass, hass.data.get(DOMAIN)


class FlightsView(HomeAssistantView):
    """List all flights (including deleted tombstones so other devices can drop them)."""

    url = "/api/pilot_logbook/flights"
    name = "api:pilot_logbook:flights"
    requires_auth = True

    async def get(self, request):
        _hass, st = _state(request)
        if st is None:
            return self.json_message("Pilot Logbook is not loaded", 503)
        since = request.query.get("since")
        flights = list(st["data"]["flights"].values())
        if since:
            try:
                cutoff = float(since)
            except ValueError:
                return self.json_message("bad 'since'", 400)
            flights = [f for f in flights if f.get("updated", 0) > cutoff]
        return self.json({"flights": flights, "server_time": int(time.time() * 1000)})

    async def post(self, request):
        """Save many flights at once: {"flights": [...]} -> {"results": [{id, accepted, flight?}]}.

        Used by the app's sync so a big logbook import uploads in a few requests.
        """
        hass, st = _state(request)
        if st is None:
            return self.json_message("Pilot Logbook is not loaded", 503)
        raw = await request.read()
        if len(raw) > MAX_BATCH_BODY:
            return self.json_message("batch too large", 413)
        try:
            body = json.loads(raw)
        except ValueError:
            return self.json_message("invalid JSON", 400)
        batch = body.get("flights") if isinstance(body, dict) else None
        if not isinstance(batch, list) or len(batch) > MAX_BATCH:
            return self.json_message(f"'flights' must be a list of at most {MAX_BATCH}", 400)

        results, saved = [], []
        async with st["lock"]:
            flights = st["data"]["flights"]
            for flight in batch:
                err = _check_flight(flight)
                if err:
                    results.append({"id": flight.get("id") if isinstance(flight, dict) else None, "accepted": False, "error": err})
                    continue
                fid = flight["id"]
                flight.pop("_dirty", None)
                current = flights.get(fid)
                if current and current.get("updated", 0) > flight["updated"]:
                    results.append({"id": fid, "accepted": False, "flight": current})
                    continue
                flights[fid] = flight
                saved.append(flight)
                results.append({"id": fid, "accepted": True})
            if saved:
                await st["store"].async_save(st["data"])

        if saved:
            _schedule_casa(hass)
        if 0 < len(saved) <= 5:
            for flight in saved:
                _fire_saved(hass, flight)
        elif saved:
            hass.bus.async_fire(EVENT_FLIGHT_SAVED, {"count": len(saved)})
        return self.json({"results": results})


class FlightView(HomeAssistantView):
    """Create / update / soft-delete one flight."""

    url = "/api/pilot_logbook/flights/{flight_id}"
    name = "api:pilot_logbook:flight"
    requires_auth = True

    async def put(self, request, flight_id):
        hass, st = _state(request)
        if st is None:
            return self.json_message("Pilot Logbook is not loaded", 503)
        if not ID_RE.match(flight_id):
            return self.json_message("bad flight id", 400)
        if request.content_length and request.content_length > MAX_BODY:
            return self.json_message("record too large", 413)
        raw = await request.read()
        if len(raw) > MAX_BODY:
            return self.json_message("record too large", 413)
        try:
            flight = json.loads(raw)
        except ValueError:
            return self.json_message("invalid JSON", 400)
        if not isinstance(flight, dict):
            return self.json_message("flight must be an object", 400)
        updated = flight.get("updated")
        if not isinstance(updated, (int, float)) or isinstance(updated, bool):
            return self.json_message("'updated' timestamp required", 400)

        flight["id"] = flight_id
        flight.pop("_dirty", None)

        async with st["lock"]:
            flights = st["data"]["flights"]
            current = flights.get(flight_id)
            if current and current.get("updated", 0) > updated:
                # Server already has a newer copy; hand it back to the client.
                return self.json({"accepted": False, "flight": current})
            flights[flight_id] = flight
            await st["store"].async_save(st["data"])

        _fire_saved(hass, flight)
        _schedule_casa(hass)
        return self.json({"accepted": True, "flight": flight})


# ---------------------------------------------------------------- CASA workbook
def _casa_path(hass: HomeAssistant, name: str) -> str:
    return hass.config.path(DOMAIN, name)


@callback
def _schedule_casa(hass: HomeAssistant, delay: float = REBUILD_DELAY) -> None:
    """Rebuild the CASA workbook a few seconds after the last change (changes come in bursts)."""
    st = hass.data.get(DOMAIN)
    if not st or not Path(_casa_path(hass, casa.TEMPLATE_NAME)).exists():
        return
    if st["casa"]["pending"]:
        st["casa"]["pending"]()

    @callback
    def _go(_now):
        st["casa"]["pending"] = None
        hass.async_create_task(_rebuild_casa(hass))

    st["casa"]["pending"] = async_call_later(hass, delay, _go)


def _build_to_disk(template_path: str, out_path: str, flights: list, overrides: dict) -> dict:
    with open(template_path, "rb") as fh:
        template = fh.read()
    data, summary = casa.build(template, flights, overrides)
    tmp = out_path + ".tmp"
    with open(tmp, "wb") as fh:
        fh.write(data)
    Path(tmp).replace(out_path)
    return summary


async def _rebuild_casa(hass: HomeAssistant) -> dict | None:
    st = hass.data.get(DOMAIN)
    if not st:
        return None
    if st["casa"]["building"]:          # one at a time; try again shortly
        _schedule_casa(hass, 2)
        return st["casa"]["summary"]
    st["casa"]["building"] = True
    try:
        flights = [dict(f) for f in st["data"]["flights"].values()]
        cfg = st["data"]["flights"].get(CFG_TAILS) or {}
        overrides = cfg.get("map", {}) if not cfg.get("deleted") else {}
        summary = await hass.async_add_executor_job(
            _build_to_disk, _casa_path(hass, casa.TEMPLATE_NAME), _casa_path(hass, casa.OUTPUT_NAME), flights, overrides)
        st["casa"]["summary"], st["casa"]["error"] = summary, None
        _LOGGER.info("CASA logbook rebuilt: %s new flights after %s", summary["new_flights"], summary["cutoff"])
        return summary
    except Exception as err:  # noqa: BLE001 - keep the logbook working whatever the workbook does
        st["casa"]["error"] = str(err)
        _LOGGER.error("Could not rebuild the CASA logbook: %s", err)
        return None
    finally:
        st["casa"]["building"] = False


class CasaInfoView(HomeAssistantView):
    url = "/api/pilot_logbook/casa"
    name = "api:pilot_logbook:casa"
    requires_auth = True

    async def get(self, request):
        hass, st = _state(request)
        if st is None:
            return self.json_message("Pilot Logbook is not loaded", 503)
        has = Path(_casa_path(hass, casa.TEMPLATE_NAME)).exists()
        if has and not st["casa"]["summary"] and not st["casa"]["error"]:
            await _rebuild_casa(hass)
        return self.json({"has_template": has, "summary": st["casa"]["summary"], "error": st["casa"]["error"]})


class CasaTemplateView(HomeAssistantView):
    url = "/api/pilot_logbook/casa/template"
    name = "api:pilot_logbook:casa_template"
    requires_auth = True

    async def put(self, request):
        hass, st = _state(request)
        if st is None:
            return self.json_message("Pilot Logbook is not loaded", 503)
        user = request.get("hass_user")
        if user is not None and not user.is_admin:
            return self.json_message("Only an administrator can replace the CASA workbook", 403)
        raw = await request.read()
        if not raw or len(raw) > MAX_WORKBOOK:
            return self.json_message("workbook missing or too large", 413)
        try:
            info = await hass.async_add_executor_job(casa.inspect_template, raw)
        except casa.CasaError as err:
            return self.json_message(str(err), 400)

        def _save():
            Path(_casa_path(hass, "")).mkdir(parents=True, exist_ok=True)
            tmp = _casa_path(hass, casa.TEMPLATE_NAME + ".tmp")
            with open(tmp, "wb") as fh:
                fh.write(raw)
            Path(tmp).replace(_casa_path(hass, casa.TEMPLATE_NAME))

        await hass.async_add_executor_job(_save)
        summary = await _rebuild_casa(hass)
        return self.json({"template": info, "summary": summary, "error": st["casa"]["error"]})


class CasaFileView(HomeAssistantView):
    url = "/api/pilot_logbook/casa.xlsx"
    name = "api:pilot_logbook:casa_file"
    requires_auth = True

    async def get(self, request):
        hass, st = _state(request)
        if st is None:
            return self.json_message("Pilot Logbook is not loaded", 503)
        if not Path(_casa_path(hass, casa.TEMPLATE_NAME)).exists():
            return self.json_message("No CASA workbook uploaded yet", 404)
        stale = st["casa"]["pending"] or not st["casa"]["summary"] or not Path(_casa_path(hass, casa.OUTPUT_NAME)).exists()
        if stale:
            if st["casa"]["pending"]:
                st["casa"]["pending"]()
                st["casa"]["pending"] = None
            await _rebuild_casa(hass)
        path = _casa_path(hass, casa.OUTPUT_NAME)
        if not Path(path).exists():
            return self.json_message(st["casa"]["error"] or "Could not build the CASA workbook", 500)
        data = await hass.async_add_executor_job(Path(path).read_bytes)
        return web.Response(body=data, headers={
            "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": 'attachment; filename="CASA-Logbook.xlsx"',
            "Cache-Control": "no-store",
        })


def _check_flight(flight) -> str | None:
    if not isinstance(flight, dict):
        return "flight must be an object"
    if not isinstance(flight.get("id"), str) or not ID_RE.match(flight["id"]):
        return "bad flight id"
    updated = flight.get("updated")
    if not isinstance(updated, (int, float)) or isinstance(updated, bool):
        return "'updated' timestamp required"
    if len(json.dumps(flight)) > MAX_BODY:
        return "record too large"
    return None


def _fire_saved(hass: HomeAssistant, flight: dict) -> None:
    hass.bus.async_fire(
        EVENT_FLIGHT_SAVED,
        {
            "id": flight.get("id"),
            "deleted": bool(flight.get("deleted")),
            "date": flight.get("date"),
            "aircraft": flight.get("aircraft"),
            "route": flight.get("route"),
            "role": flight.get("role"),
            "total": flight.get("total"),
        },
    )


# ---------------------------------------------------------------- rostered flights
class RosterView(HomeAssistantView):
    """Upcoming rostered flights. Roster Manager POSTs them; the app GETs them on every sync."""

    url = "/api/pilot_logbook/roster"
    name = "api:pilot_logbook:roster"
    requires_auth = True

    async def get(self, request):
        _hass, st = _state(request)
        if st is None:
            return self.json_message("Pilot Logbook is not loaded", 503)
        now = time.time() * 1000
        keep = [s for s in st["roster"]["sectors"] if s["arr"] > now - 2 * 86400e3 and s["dep"] < now + 15 * 86400e3]
        return self.json({"received": st["roster"].get("received"), "sectors": keep})

    async def post(self, request):
        hass, st = _state(request)
        if st is None:
            return self.json_message("Pilot Logbook is not loaded", 503)
        user = request.get("hass_user")
        if user is not None and not user.is_admin:
            return self.json_message("Only an administrator can replace the roster", 403)
        raw = await request.read()
        if len(raw) > MAX_BODY * 8:
            return self.json_message("roster too large", 413)
        try:
            body = json.loads(raw)
        except ValueError:
            return self.json_message("invalid JSON", 400)
        sectors = body.get("sectors") if isinstance(body, dict) else None
        if not isinstance(sectors, list) or len(sectors) > 400:
            return self.json_message("'sectors' must be a list", 400)
        clean = await hass.async_add_executor_job(roster.normalize, sectors)
        st["roster"] = {"received": int(time.time() * 1000), "source": str(body.get("source", ""))[:40], "sectors": clean}
        await st["roster_store"].async_save(st["roster"])
        return self.json({"accepted": len(clean)})
