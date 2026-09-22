# Security

VNetCore is a local-first static application. It does not transmit project data, but the browser stores network details as plain text in `localStorage`.

## Sensitive data

- Do not store passwords, private keys, tokens, or device credentials.
- Use a dedicated HTTPS origin rather than sharing an origin with unrelated applications.
- Anyone with access to the browser profile may be able to read the stored inventory.
- Export JSON backups regularly and protect those files according to their sensitivity.

## Deployment

The included `netlify.toml` defines a restrictive Content Security Policy and other defensive headers. Equivalent headers must be configured when another static host is used.

## Reporting

Report security issues privately to the project owner. Include reproduction steps and avoid attaching real infrastructure data.
