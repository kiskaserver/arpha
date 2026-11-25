# Security policy

Please report vulnerabilities privately via
[GitHub Security Advisories](https://github.com/kiskaserver/arpha/security/advisories/new), not in public issues.
We aim to respond within 72 hours.

## Secrets

`TG_SESSION` grants full access to a Telegram account. It, `ANTHROPIC_API_KEY`, `ALERTS_IN_UA_TOKEN`
and `VAPID_PRIVATE_KEY` must only ever live in environment variables. CI runs gitleaks on every push.
If a session leaks: Telegram → Settings → Devices → terminate the session, then run `pnpm tg:login` again.

## Hardening in place

Strict CSP, `frame-ancestors 'none'`, nosniff, body size limits, zod validation of all inputs,
non-root container user, no third-party scripts.
