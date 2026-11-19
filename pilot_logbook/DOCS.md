# Pilot Logbook

An iPad pilot logbook that saves your flights in Home Assistant.

## After installing

1. **Start** this add-on. It copies the Pilot Logbook integration into your `custom_components` folder and posts a notification.
2. Restart Home Assistant (**Settings → System → Restart**).
3. Go to **Settings → Devices & services → Add integration → Pilot Logbook**.
4. On your iPad, open `https://<your-home-assistant-address>/pilot_logbook/index.html` in Safari, tap **Share → Add to Home Screen**, then open it and use **Settings → Sign in with Home Assistant**.

## Options

- **auto_restart** (default off): when the add-on installs a new version of the logbook, restart Home Assistant automatically instead of showing a notification.

## Your data

Flights are stored by Home Assistant in `.storage/pilot_logbook.flights` and are included in Home Assistant backups. Stopping or uninstalling this add-on does not delete them.
