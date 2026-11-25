# ADR 0007 — Runtime, Telegram client and supply chain

- Status: accepted · 2026-11-25

## Context

The service runs unattended on a public URL and holds a Telegram user session, so an outdated runtime or a
compromised dependency is the most likely way in. Three things were end-of-line at once: Node 22 (maintenance
LTS), GramJS (`telegram` — archived) and Railway Config as Code (`railway.json`, ignored after 2026-12-01).

## Decision

- **Node 26 LTS** everywhere: `.nvmrc`, `engines`, Docker `node:26-slim`, tsdown target `node26`, `@types/node@26`.
  `node:sqlite` is no longer experimental, so no warning flags are needed.
- **pnpm 12**, pinned by `packageManager`. Node 26 has no corepack, so the Dockerfile installs exactly that
  version with `npm i -g`; CI uses `pnpm/action-setup`, which reads the same field.
- **Supply chain**: `minimumReleaseAge: 1440` (24 h) with an explicit, commented exclude list for reviewed
  security releases; `allowBuilds` whitelist for install scripts; `overrides` for vulnerable transitive deps.
- **teleproto** replaces GramJS: the archived package names it as its maintained, API-compatible fork, and it
  ships proper `exports`, so no deep `.js` imports. `test/esm-imports.test.ts` still loads every external
  import under plain Node ESM.
- **No `railway.json`**: build and deploy settings (Dockerfile path, health check, restart policy, region,
  limits) are stored on the Railway service itself; the Dockerfile at the repo root is the build definition.

## Consequences

Brand-new releases arrive a day late unless explicitly excluded. Developers need Node 26 and pnpm 12 locally.
Railway settings are no longer reviewed in PRs; they are documented in the README deploy section instead.
