import { type LatLon, predictPosition, type Track } from '@arpha/shared'

/** How long a correction takes to blend in. Long enough to look smooth, short enough to stay honest. */
export const BLEND_MS = 1500

interface MotionEntry {
  track: Track
  /** Offset (displayed − predicted) at the moment a new server state arrived. */
  dLat: number
  dLon: number
  dHeading: number
  since: number
}

export interface Pose extends LatLon {
  /** Icon rotation; null for non-directional objects. */
  heading: number | null
}

const easeOutCubic = (x: number) => 1 - (1 - x) ** 3
const angleDiff = (a: number, b: number) => ((a - b + 540) % 360) - 180

/**
 * Turns discrete server states into continuous motion. Between reports the icon
 * dead-reckons along its course; when a report corrects the course, the
 * difference is eased out over BLEND_MS instead of teleporting the icon.
 */
export class MotionModel {
  readonly #entries = new Map<string, MotionEntry>()

  upsert(track: Track, now: number): void {
    const prev = this.#entries.get(track.id)
    const next = predictPosition(track, now)
    if (!prev || !next) {
      this.#entries.set(track.id, { track, dLat: 0, dLon: 0, dHeading: 0, since: now })
      return
    }
    const shown = this.pose(track.id, now)
    const offset =
      shown && prev.track.position
        ? { dLat: shown.lat - next.lat, dLon: shown.lon - next.lon }
        : { dLat: 0, dLon: 0 }
    const dHeading =
      shown?.heading != null && track.headingDeg !== null
        ? angleDiff(shown.heading, track.headingDeg)
        : 0
    this.#entries.set(track.id, { track, ...offset, dHeading, since: now })
  }

  remove(id: string): void {
    this.#entries.delete(id)
  }

  /** Drop entries whose tracks are gone. */
  retain(ids: Set<string>): void {
    for (const id of this.#entries.keys()) if (!ids.has(id)) this.#entries.delete(id)
  }

  pose(id: string, now: number): Pose | null {
    const e = this.#entries.get(id)
    if (!e) return null
    const base = predictPosition(e.track, now)
    if (!base) return null
    const k = 1 - easeOutCubic(Math.min(1, Math.max(0, (now - e.since) / BLEND_MS)))
    const heading =
      e.track.headingDeg === null ? null : (e.track.headingDeg + e.dHeading * k + 360) % 360
    return { lat: base.lat + e.dLat * k, lon: base.lon + e.dLon * k, heading }
  }

  /** True while any correction is still blending — the render loop must keep running. */
  isBlending(now: number): boolean {
    for (const e of this.#entries.values()) {
      if (now - e.since < BLEND_MS && (e.dLat !== 0 || e.dLon !== 0 || e.dHeading !== 0))
        return true
    }
    return false
  }

  get size(): number {
    return this.#entries.size
  }
}
