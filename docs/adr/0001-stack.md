# ADR 0001 — One TypeScript service: Hono + Svelte 5 + MapLibre

- Status: accepted · 2026-11-25

## Context

Single maintainer, deploy on Railway, must run on low-end phones, PWA-installable.

## Decision

- One Node 26 LTS process serves the API, the SSE stream and the built PWA (no separate CDN/backend).
- **Hono** for HTTP (tiny, standards-based `Request/Response`, easy to test with `app.request`).
- **Svelte 5** for UI: compiled, ~15 KB runtime; runes give fine-grained updates without a VDOM.
- **MapLibre GL v6** with OpenFreeMap vector tiles: GPU rendering keeps animation cheap; tiles are cached by the SW.
- **pnpm workspace** with `packages/shared` so the server and the client compute ETA/positions identically.
- **node:sqlite** instead of better-sqlite3: no native build step in Docker.

## Consequences

MapLibre is ~300 KB gz; it is lazy-loaded after the shell paints and cached forever (hashed chunk).
