import { destination, type LatLon } from './geo'
import { isExtrapolating, predictPosition, type Track } from './model'
import { THREAT_PROFILES } from './threats'

/**
 * Reach cone: the area the object can plausibly cover within its prediction
 * horizon, given its course and how sharply that type can turn. Computed on the
 * client from the smoothed pose so it travels with the icon. Ring of [lon, lat].
 */
export function reachCone(
  pose: LatLon,
  headingDeg: number,
  speedKmh: number,
  horizonMin: number,
  halfAngleDeg: number,
  steps = 12,
): number[][] {
  const reach = (speedKmh / 60) * horizonMin
  const ring: number[][] = [[pose.lon, pose.lat]]
  for (let i = 0; i <= steps; i++) {
    const b = headingDeg - halfAngleDeg + (2 * halfAngleDeg * i) / steps
    // Turning costs distance: the arc edges are a little shorter than straight ahead.
    const off = Math.abs(b - headingDeg) / Math.max(halfAngleDeg, 1)
    const p = destination(pose, b, reach * (1 - 0.25 * off * off))
    ring.push([p.lon, p.lat])
  }
  ring.push([pose.lon, pose.lat])
  return ring
}

/** Cone for a track at `now`, or null when it isn't moving predictably. */
export function trackCone(track: Track, now: number, pose?: LatLon & { heading: number | null }) {
  const profile = THREAT_PROFILES[track.type]
  if (!isExtrapolating(track, now) || !track.speedKmh || profile.coneHalfAngleDeg <= 0) return null
  const at = pose ?? predictPosition(track, now)
  const heading = pose?.heading ?? track.headingDeg
  if (!at || heading === null) return null
  return reachCone(at, heading, track.speedKmh, profile.predictHorizonMin, profile.coneHalfAngleDeg)
}
