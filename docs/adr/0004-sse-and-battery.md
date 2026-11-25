# ADR 0004 — SSE transport and battery-aware rendering

- Status: accepted · 2026-11-25

## Decision

- Server → client over **Server-Sent Events**: snapshot on connect, then `track` / `track_removed` / `alerts`
  deltas; 25 s heartbeats for proxies; client watchdog reconnects silent streams (mobile half-open sockets).
- Render loop runs only while something moves. Frame interval = time for the fastest icon to move ½ px at the
  current zoom, clamped to 33–1000 ms: ≈1 fps at oblast zoom, smooth when zoomed in. Paused when hidden.
- Device pixel ratio capped at 2; no map rotation/pitch; `fadeDuration: 0`.
