# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please report it by emailing the maintainer directly rather than opening a public issue.

## Known Considerations

- The Cesium Ion access token in `app.js` is a **free-tier token** scoped to World Terrain only. It is intentionally public.
- The conversion services should be run behind a reverse proxy (Cloudflare Tunnel or similar) and not exposed directly to the internet.
- Uploaded 3D model files are processed in temporary directories and cleaned up after conversion.
- The SKP converter runs SketchUp 8 under Wine in a Docker container with an unprivileged user.
