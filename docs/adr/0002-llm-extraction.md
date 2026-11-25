# ADR 0002 — LLM extraction with forced tool use; coordinates only from the gazetteer

- Status: accepted · 2026-11-25

## Context

Channels write in free form (UA/RU, slang: «мопед», «мінус», emoji), formats change, and many posts are
replies to earlier ones. Regex templates do not scale to an unlimited channel list.

## Decision

- Claude Haiku 4.5 with a **forced tool call** (`report_threats`) and a JSON schema; output validated with zod
  that degrades unknown enum values to safe defaults instead of failing.
- The prompt includes the **reply chain** (up to 3 parents, with the track ids they produced) and a brief of
  **active tracks**, so the model can link follow-ups (`track_id`).
- The model returns **place names** (Ukrainian nominative); **coordinates come only from the gazetteer**.
  The model cannot hallucinate positions.
- Results are cached per `(channel, message, edit_date)`; edits re-run extraction and keep their tracks.
- Quality is measured by `pnpm eval` on a labelled golden set (`data/golden`).

## Consequences

~0.1–0.3 ¢ per message. If the API is down, messages fail and are retried by the next poll sweep.
