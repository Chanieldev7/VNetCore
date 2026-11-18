# VNetCore

A static web app for documenting the devices, ports and connections of a network infrastructure. It runs entirely in the browser with no backend. A small React island renders the Sonner notifications; the rest of the app is plain JavaScript.

## Run locally

Serve the project over a local HTTP server. Opening `index.html` directly with `file://` is not supported.

```powershell
npm install
npm run dev
```

Then open the URL that the command prints.

`npm run build` generates `assets/notifications.js`, `assets/notifications.css`, `assets/fonts.css` and the self-hosted IBM Plex fonts in `assets/fonts/`. The generated files are committed so the site can be published without Node.js on the server.

## Data and backups

- Data is stored locally in the browser under `vnetcore.workspace.v1` and `vnetcore.project.v9`.
- Before each write, the previous version of the active project is kept in `vnetcore.project.v9.backup`.
- Data from `vnetcore.project.v7` and `vnetcore.project.v8` is migrated automatically.
- A read error never replaces the original data: unreadable content is copied to `vnetcore.recovery.v1` before any save.
- Deleting a device, clearing the inventory or reducing port counts also removes the links on those ports, so no orphan links remain.
- JSON is the recommended format for complete backups.
- Imports are validated and show a summary before they replace the active project.
- Each imported file can have at most 5 MB, 500 devices and 512 ports per device.

Do not store passwords, private keys or tokens. See `SECURITY.md` for privacy and deployment notes.

## Features

- Add, edit, duplicate, delete and reorder devices.
- Change LAN and WAN port counts without recreating the device.
- Optional inventory details per device: manufacturer, serial number, MAC address, management IP, firmware/OS and notes. Duplicating a device does not copy its serial number, MAC address or management IP.
- Search by device, location, VLAN, address, connection, notes or inventory details.
- Selecting a port scrolls its editor into view; **Back to ports** returns to the port map.
- **Clear port** resets a port to Available and removes its link, with undo.
- Move a port's data to an Available port of the same device, either with **Move this port's data to** in Port details or by dragging one port onto another in the map. The two ports swap their data, so nothing is lost, and the link moves with it.
- **Review date:** records the day the project was last reviewed and is shown on the project card ("Reviewed on …"). It is a record only and never raises alerts.
- **Duplicate inventory alerts:** the same serial number, MAC address (in any notation) or management IP on two devices is reported.
- **Bulk edit:** in Interface map, **Select multiple ports** (Shift+click selects a range) and set status, VLAN or type on all of them at once.
- **Rack view:** a front view of each rack in mounting order, with rails, numbered units and each device drawn as hardware (switch and patch panel jacks show the documented port status). Drag a device to another unit or rack, or drag one from _Not placed in a rack_ onto a rack; with the keyboard, focus a device and press Up or Down to move it to the next free position. Rack, Position (U) and Height (U) can also be set in a device's Inventory details. **Rack size** in Project information sets the rack height (10–50U in steps of 5, plus the standard 42U; default 42U). Overlapping devices, and devices above the chosen size, are flagged.
- **Works offline:** the build generates a service worker; once loaded, the app opens without a connection and offers a reload when a new version is deployed.
- Undo history for the last ten structural changes.
- Visible save status and an emergency recovery export.
- Versioned JSON/CSV import and export, with an in-app format guide and downloadable templates (**Import → Format guide & templates**).
- Printable PDF report with every port field and device details.
- Keyboard navigation, ARIA controls and reduced-motion support.
- Collapsible side panel and responsive layout.
- Combined port filters by status and VLAN that never change the data.
- Documentation alerts: possible duplicate IPv4/IPv6 addresses, missing destinations, incomplete links and inconsistent statuses.
- Connection map with device selection, highlighting of both ends and a neighbors view.
- Sonner notifications for success, info, warnings and errors, with actions to undo or recover data.
- Delete confirmations focus Cancel first; cancelling or pressing Escape makes no changes.

### Network tools

- In **Interface map**, combine a status with a VLAN ID or name. Searching `10` does not match VLAN `100`. The legend counters still show the device totals.
- Filters never delete ports or drafts. Opening a port from an alert or a link resets the filters to show it.
- **Network alerts** checks saved data, not drafts or live connectivity. A repeated IP is a warning to review: it may be valid on separate networks, or describe the same device.
- Local links with stale references are kept for review; **Remove broken link** asks for confirmation and can be undone. Imported files are still validated strictly.
- In **Connection map**, select a device or a link. The two buttons of the selected link open its ports; **Linked port** in the form documents new connections.
- The map includes devices without links. Parallel links are bundled visually and stay separate in the keyboard-accessible list.
- Alerts and connections are listed twenty at a time. Dense maps draw up to 300 link bundles plus the selected one; the list covers all of them.

## File formats

The full specification, with examples and templates, is in the app under **Import → Format guide & templates**. In short:

- **JSON** is a project object with a required `devices` array and an optional `connections` array. Devices hold `ports`; connections reference two existing ports by `firstDeviceId`/`firstPortId` and `secondDeviceId`/`secondPortId`.
- **CSV** has a header row and one record per row, set by `recordType`: `PROJECT`, `DEVICE` or `PORT`. Columns are matched by name, so their order does not matter. Links are written as `linkedDeviceId`/`linkedPortId` on a PORT row. The flat CSV produced by older versions is still accepted.

On export, CSV values that a spreadsheet could run as a formula (starting with `=`, `+`, `-` or `@`) get a leading apostrophe. VNetCore removes it again on import, so values survive a round trip.

## Quality

Node.js 18 or later is required to build and run the development checks:

```powershell
npm test
```

The tests cover normalization, validation, migrations, CSV, filters, alerts, maps, notifications, data integrity, port tools and accessibility names. The build keeps Sonner's styles in an external file to respect the Content Security Policy, without enabling inline styles or scripts.

Run `npm run format` to apply the Prettier formatting that continuous integration checks.

## Deployment

Run `npm ci` and `npm run dist`, then publish only the `dist/` folder over HTTPS. `dist/` has two parts: the landing page at `/` (built from `landing.html`) and the application at `/app/`, each with its own copy of the fonts and images it uses. The service worker is generated inside `/app/`, so offline caching never reaches the landing page. `dist/` excludes `node_modules/`, tests and tooling.

The intended setup is a dedicated subdomain, for example `vnetcore.cjotasolutions.net` for the landing page and `vnetcore.cjotasolutions.net/app/` for the app. `vercel.json` and `netlify.toml` both run the build, publish `dist/` and apply the security headers; on Vercel the `/app` to `/app/` redirect is in `vercel.json`. Keep the CSP defined in `index.html` and `landing.html`, and configure equivalent headers on other hosts.

The app makes no third-party requests: fonts are self-hosted.

Target browsers: current Chrome, Edge, Firefox and Safari with support for `dialog`, basic web modules and `localStorage`.
