#!/usr/bin/with-contenv bashio
# Installs/updates the Pilot Logbook integration into Home Assistant's config folder,
# then stays idle so that updating this add-on re-runs the install.
set -e

SRC=/integration/pilot_logbook
DEST_DIR=/homeassistant/custom_components
DEST="$DEST_DIR/pilot_logbook"

mkdir -p "$DEST_DIR"

# Fingerprint of the bundled files; compared with the one saved at the last install.
HASH=$(cd "$SRC" && find . -type f | sort | xargs sha1sum | sha1sum | cut -d' ' -f1)

if [ -d "$DEST" ] && [ "$(cat "$DEST/.addon_hash" 2>/dev/null)" = "$HASH" ]; then
  bashio::log.info "Pilot Logbook is installed and up to date."
else
  if [ -d "$DEST" ]; then WHAT="updated"; else WHAT="installed"; fi
  rm -rf "$DEST.new"
  cp -r "$SRC" "$DEST.new"
  echo "$HASH" > "$DEST.new/.addon_hash"
  rm -rf "$DEST"
  mv "$DEST.new" "$DEST"
  VERSION=$(jq -r '.version' "$SRC/manifest.json")
  bashio::log.info "Pilot Logbook $VERSION $WHAT in custom_components/pilot_logbook."

  if bashio::config.true 'auto_restart'; then
    bashio::log.info "Restarting Home Assistant to load it..."
    curl -fsS -X POST -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" \
      http://supervisor/core/api/services/homeassistant/restart >/dev/null \
      || bashio::log.warning "Could not restart Home Assistant - please restart it yourself."
  else
    if [ "$WHAT" = "installed" ]; then
      MSG="Pilot Logbook was installed. Restart Home Assistant (Settings → System → Restart), then add it under Settings → Devices & services → Add integration → Pilot Logbook."
    else
      MSG="Pilot Logbook was updated to $VERSION. Restart Home Assistant (Settings → System → Restart) to load the new version, then close and reopen the app on your iPad."
    fi
    jq -n --arg m "$MSG" '{title: "Pilot Logbook", message: $m, notification_id: "pilot_logbook_install"}' |
      curl -fsS -X POST -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" -H "Content-Type: application/json" \
        -d @- http://supervisor/core/api/services/persistent_notification/create >/dev/null \
      || bashio::log.warning "$MSG"
  fi
fi

# Nothing else to do; stay running so an add-on update restarts this script.
exec sleep infinity
