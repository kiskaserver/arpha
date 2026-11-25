# Contributing

1. `pnpm install` (Node ≥ 22.13, pnpm 9). Husky installs git hooks.
2. Work on a branch; commits follow [Conventional Commits](https://www.conventionalcommits.org) (enforced by commitlint).
3. Before a PR: `pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm build && pnpm test:e2e`.
4. UI text is **Ukrainian only** and lives in `apps/web/src/lib/i18n.ts`.
5. Extraction prompt changes must keep `pnpm eval` ≥ 90 %; add the failing posts to `data/golden/`.
6. Architectural changes get an ADR in `docs/adr/`.

Useful commands: `DEMO_MODE=true pnpm dev`, `pnpm data:gazetteer`, `pnpm data:boundaries`, `pnpm tg:dump`.
