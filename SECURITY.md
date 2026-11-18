# Security

VNetCore is a local-first static application. It does not transmit project data, but the browser stores network details as plain text in `localStorage`.

## Sensitive data

- Do not store passwords, private keys, tokens, or device credentials.
- Use a dedicated HTTPS origin rather than sharing an origin with unrelated applications.
- Anyone with access to the browser profile may be able to read the stored inventory.
- Export JSON backups regularly and protect those files according to their sensitivity.

## Deployment

Run `npm run dist` and publish only the generated `dist/` folder. It contains the browser files and nothing else, so `node_modules/`, tests and tooling are never exposed.

The included `netlify.toml` builds `dist/` and sends a restrictive Content Security Policy (including `frame-ancestors 'none'`, which a `<meta>` CSP cannot express), HSTS, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` and `Cross-Origin-Opener-Policy`. Configure equivalent headers when another static host is used.

## Data recovery

If stored data cannot be read at startup, VNetCore copies the unreadable text to `vnetcore.recovery.v1` (last three incidents) before any save, and never rotates unreadable data into the backup slot.

## Third-party requests

None. The IBM Plex fonts are self-hosted from `assets/fonts/`, and the CSP allows only the app's own origin.

## Reporting

Report security issues privately to the project owner. Include reproduction steps and avoid attaching real infrastructure data.
