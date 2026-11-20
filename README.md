# Pilot Logbook for iPad + Home Assistant

A simple pilot logbook, laid out like ZuluLog's logbook, in two pieces:

- **A Home Assistant integration.** It stores your flights on your Home Assistant server and hosts the app.
- **An iPad web app** that you add to your Home Screen. It saves flights on the iPad first, so it works with no signal, then syncs them to Home Assistant.

Your flight data never leaves your Home Assistant server. This repository only holds the app's code.

## 1. Install on Home Assistant (Add-on Store)

1. In Home Assistant, go to **Settings → Add-ons → Add-on Store**.
2. Tap **⋮ (top right) → Repositories**, paste `https://github.com/Tuttle13/pilot-logbook`, tap **Add**, then **Close**.
3. Find **Pilot Logbook** in the store (refresh the page if it isn't there yet), open it and tap **Install**. The first install takes a minute or two.
4. Tap **Start**. A notification appears saying Pilot Logbook was installed.
5. Restart Home Assistant (**Settings → System → Restart**).
6. Go to **Settings → Devices & services → Add integration**, search for **Pilot Logbook**, then click **Submit**.

A **Pilot Log** item now appears in the Home Assistant sidebar, so you can also use the logbook from a PC.

**How it works:** the add-on copies the logbook into Home Assistant's `custom_components` folder, then sits idle. The logbook itself runs inside Home Assistant, so your flights are kept even if you stop or uninstall the add-on.

**Updates:** when a new version is published here, Home Assistant shows it under **Settings → Updates**. Install the update, restart Home Assistant when the notification asks you to, then fully close and reopen the app on the iPad. If you turn on the add-on's **auto_restart** option, it restarts Home Assistant for you after an update.

## 2. Install on the iPad

1. In **Safari** on the iPad, open `https://<your-home-assistant-address>/pilot_logbook/index.html`
2. Tap **Share → Add to Home Screen**. A "Logbook" icon appears.
3. Open the Logbook icon, go to **Settings**, then tap **Sign in with Home Assistant** and log in with your normal HA user.

The sync button at the top right shows the status. A green dot means everything is on the server. Flights you log offline show "not synced" and upload by themselves when you're back online.

## Entering a flight

Tap **+ New flight**. Everything is on one page:

- **Flt Date/Time:** starts at now.
- **Aircraft ID:** pick from aircraft you've flown before. The type (e.g. B738) fills in from your earlier flights in that aircraft.
- **Route:** for example `MEL SYD`.
- **IFR / VFR:** start the same as your last flight.
- **Role:** **SIC** by default, or **PIC**.
- **Flt Time, Act Inst, SIC Time:** Day and Night boxes with −/+ buttons that step by 0.1, and a total on the right. You can also type `1.3` or `1:18`.
  - While Role is **SIC**, SIC Time copies Flt Time as you type.
  - Switching to **PIC** swaps the SIC Time row for a **PIC Time** row, and Flt Time is copied into PIC Time instead. You can still adjust either row by hand.

**Save** returns you to the logbook. **Save & next sector** starts a new flight with the same date, aircraft and role, and the route starting at the last destination.

The logbook list shows each flight like ZuluLog does: date, flight time, type/rego, route, role and AI. **Totals** gives Flt Time, Day, Night, SIC, PIC, Act Inst and IFR counts over all time, the last 7/28/90/365 days and this year, plus totals by aircraft type.

## Bringing in your existing ZuluLog flights

1. Sign in to your ZuluLog Web account on a computer and export your logbook as CSV.
2. Get the file onto the iPad, for example with AirDrop, iCloud Drive or email.
3. In the Logbook app, go to **Settings → Import CSV from ZuluLog** and pick the file.
4. Check the **Goes into** column. ZuluLog's columns are matched for you: Flt Date/Time, Aircraft ID and type, Route, IFR, VFR, Role, and Day/Night Flt Time, Act Inst, SIC and PIC. Change anything that's wrong; the preview updates as you go.
5. Tap **Import**. All the flights upload to Home Assistant in batches of 250, which takes seconds even for a few thousand flights.

Imported flights and flights you enter afterwards live in the same logbook. Flights already in the logbook (same date, aircraft, route and flight time) are skipped, so you can re-import a newer ZuluLog export later and only the missing flights are added.

## Your CASA (Excel Pilot Logbook) workbook

Your CASA workbook is kept on your Home Assistant server, in `config/pilot_logbook/`. It is never uploaded anywhere else, and it is not part of this repository.

- **Rebuilt automatically:** every time a flight is saved, the server rebuilds `CASA-Logbook.xlsx`. Your original rows stay exactly as they were, apart from 737-family aircraft types, which are corrected from the fleet rules. Every later flight is added in the CASA columns: date, type, reg., captain (from PIC Name), "Self", route, ME co-pilot / command (or SE) day and night, and instrument. The workbook's own formulas, dashboards and reports carry on.
- **To get a copy:** in the app, go to **Settings → CASA logbook → Download CASA logbook**.
- **To change the workbook:** use **Replace CASA workbook** (administrators only). Flights after its last row are added automatically.

## Re-importing a full ZuluLog export

Import it under **Settings → Import CSV from ZuluLog** and choose **Match this file exactly**. Flights are added, updated or removed so the app matches the file. Flights you entered in the app itself are never touched. Aircraft types follow your fleet rules (B737 / B738 / B38M by tail).

## Where the data lives

Flights are stored in `config/.storage/pilot_logbook.flights` on your Home Assistant server, so they are included in your normal Home Assistant backups.

Each time a flight is saved, Home Assistant fires a `pilot_logbook_flight_saved` event. You can use it in automations if you want.

## Troubleshooting

- **"Pilot Logbook integration not found"**: the integration isn't installed, or Home Assistant hasn't been restarted since you installed it (step 1).
- **The app doesn't show your latest changes:** Cloudflare may be caching the old `app.js`. Use *Caching → Purge Everything* in the Cloudflare dashboard, or add a Cache Rule that bypasses caching for `/pilot_logbook/*`.
- **Cloudflare Access login page:** if you put Cloudflare Zero Trust in front of HA, sign in to it once in the Home Screen app.
- **Sign-in won't work:** under Settings, open *Use a long-lived access token instead*. Paste a token you created in HA under **Profile → Security**.
