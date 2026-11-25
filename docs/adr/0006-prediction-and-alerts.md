# ADR 0006 — Impact prediction and polite alerts polling

- Status: accepted · 2026-11-25

## Prediction

For every active track the server computes a forecast attached to the wire `Track`:

- **Reach cone** (shared, computed on the client from the smoothed pose): heading ± a per-type turn angle,
  radius = speed × horizon, edges shortened (turning costs distance).
- **Likely targets**: every gazetteer place inside the cone scored as
  `exp(-(Δθ/σ)²) × reach × importance(kind, population) × (1 + ln(1 + hits₃₀ᵈ)) × (3 if named by a source)`
  and normalised over the top three. `hits₃₀ᵈ` comes from the `observations` table — routes and KAB impact
  areas repeat, so history is a strong prior. A destination named by a source is always kept.
- **Impact zone**: KAB 3 km, ballistic 6 km around the target (or reported spot); for drones around the top
  candidate when its probability ≥ 40 %. "Впали каби"/a missile that is "lost" over a place becomes an
  `explosion` marker (an observed impact).

This is deliberately transparent (every factor is explainable in the UI) rather than a black-box model.

## alerts.in.ua

The token may be shared with another project and the API blocks abusers (8–10 req/min soft limit per IP).
We poll `/v1/alerts/active.json` every 30 s ± 15 % jitter with `If-Modified-Since`, honour `Retry-After` on
429 (2 min otherwise), pause 15 min on 401/403, and back off exponentially on errors. All alert types and the
`threats[]` sub-types are used; new threats on an existing alert (e.g. ballistic added) trigger notifications.
