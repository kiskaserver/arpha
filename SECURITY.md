# Security policy

Please report vulnerabilities privately via
[GitHub Security Advisories](https://github.com/kiskaserver/arpha/security/advisories/new), not in public issues.
We aim to respond within 72 hours.

## Secrets

`TG_SESSION` grants full access to a Telegram account. It, `ANTHROPIC_API_KEY`, `ALERTS_IN_UA_TOKEN`
and `VAPID_PRIVATE_KEY` must only ever live in environment variables. CI runs gitleaks on every push.
If a session leaks: Telegram → Settings → Devices → terminate the session, then run `pnpm tg:login` again.

## Hardening in place

- Strict CSP, `frame-ancestors 'none'`, HSTS, nosniff, Permissions-Policy, body size limits,
  zod validation of all inputs, non-root container user, no third-party scripts.
- Real client IP behind Cloudflare (`CF-Connecting-IP`, then the first `X-Forwarded-For` hop) — `GET /api/ip`
  shows what the server sees.
- CSRF: state-changing endpoints require `Content-Type: application/json` and an `Origin` that is the
  request's own host or listed in `PUBLIC_ORIGINS`; cross-site `Sec-Fetch-Site` is rejected.
- Per-IP rate limits (API 240/min, push 20/min) and at most 8 concurrent SSE streams per IP.

## Supply chain

- Node 26 LTS, pnpm 12, `pnpm audit` clean.
- `minimumReleaseAge: 1440` — no dependency release younger than 24 h is installed; exceptions are listed
  explicitly in `pnpm-workspace.yaml` with a reason.
- Install scripts run only for packages in `allowBuilds`; extra permissions requested by packages are not approved.
- Vulnerable transitive versions are pinned away with `overrides`; Dependabot watches npm, Docker and Actions.
