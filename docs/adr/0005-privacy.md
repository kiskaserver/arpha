# ADR 0005 — Privacy

- Status: accepted · 2026-11-25

- The user's point is stored in `localStorage` only. ETA is computed on the device.
- Web Push needs server-side matching, so the subscription stores the point **rounded to 0.01° (~1 km)**.
- No analytics, no third-party scripts. The only third-party origin is the tile server.
- Telegram session and API keys live only in environment variables; gitleaks runs in CI.
