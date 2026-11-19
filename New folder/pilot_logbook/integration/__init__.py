"""Pilot Logbook: keeps flight records in Home Assistant and serves an iPad web app.

Web app:  https://<ha>/pilot_logbook/index.html   (static, no data in it)
API:      GET  /api/pilot_logbook/flights          -> {"flights": [...], "server_time": ms}
          POST /api/pilot_logbook/flights          -> save up to 500 flights {"flights": [...]}
          PUT  /api/pilot_logbook/flights/{id}     -> save one flight (last write wins on "updated")
Both API routes need a normal Home Assistant access token.
Flights live in <config>/.storage/pilot_logbook.flights, so HA backups include them.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from pathlib import Path

from homeassistant.components import frontend
from homeassistant.components.http import HomeAssistantView, StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

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
_HTTP_DONE = f"{DOMAIN}_http_registered"


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    store: Store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
    data = await store.async_load()
    if not isinstance(data, dict) or not isinstance(data.get("flights"), dict):
        data = {"flights": {}}

    hass.data[DOMAIN] = {"store": store, "data": data, "lock": asyncio.Lock()}

    # HTTP routes cannot be removed again, so only register them once per HA run.
    if not hass.data.get(_HTTP_DONE):
        await hass.http.async_register_static_paths(
            [StaticPathConfig(STATIC_URL, str(Path(__file__).parent / "www"), False)]
        )
        hass.http.register_view(FlightsView())
        hass.http.register_view(FlightView())
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
        return self.json({"accepted": True, "flight": flight})


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
