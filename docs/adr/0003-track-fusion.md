# ADR 0003 — Track fusion with a constant-velocity Kalman filter

- Status: accepted · 2026-11-25

## Context

Reports are sparse (every 2–10 min), name the nearest village rather than the object, and several channels
describe the same group. We need speed, heading, ETA and smooth motion — never "jumping" icons.

## Decision

- Association order: explicit `track_id` from the model → tracks of the replied-to post → spatial gating
  (`20 km + 3σ` around the predicted position), compatible types only, never two events of one post onto one track.
- 4-state CV Kalman filter in a local tangent plane (km, km/min). Measurement noise from place kind/precision.
  Course hints (compass heading, from→to, toward target) enter as **velocity pseudo-measurements**.
- Per-type profiles: typical/max speed, TTL, extrapolation horizon, process noise. KABs, ballistic, aircraft are
  stationary; target-only threats (ballistic warnings) have no position.
- Gross inconsistency (Mahalanobis² > 16 and > 40 km) re-seeds the filter.
- Client: dead reckoning with the same `predictPosition`, corrections eased over 1.5 s (`MotionModel`).

## Consequences

Deterministic and unit-testable; tests assert bounded per-frame displacement and filter convergence.
