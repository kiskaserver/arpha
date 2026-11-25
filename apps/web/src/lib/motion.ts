import { type LatLon, predictPosition, type Track } from '@arpha/shared'

/**
 * Time constant of the correction, seconds. A report that moves the estimate by
 * a few kilometres is flown over in ~3τ instead of appearing as a jump.
 */
export const FOLLOW_TAU_S = 2.5
/** Corrections larger than this (wrong association, very old state) are snapped, not flown. */
const SNAP_KM = 40
const SUBSTEP_S = 0.05
const SETTLED_KM = 0.02
const KM_PER_DEG = 111.2

interface Entry {
  track: Track
  /** Display offset from the dead-reckoned position, degrees, and its rate (deg/s). */
  eLat: number
  eLon: number
  vLat: number
  vLon: number
  heading: number | null
  /** Last advance time, ms. */
  t: number
}

export interface Pose extends LatLon {
  /** Icon rotation; null for non-directional objects. */
  heading: number | null
}

const angleDiff = (a: number, b: number) => ((a - b + 540) % 360) - 180

/** Dead-reckoned position and its velocity (deg/s) at `t`. */
function reckon(track: Track, t: number) {
  const p = predictPosition(track, t)
  const q = predictPosition(track, t + 1000)
  if (!p || !q) return null
  return { lat: p.lat, lon: p.lon, vLat: q.lat - p.lat, vLon: q.lon - p.lon }
}

function offsetKm(e: Entry): number {
  const cos = Math.cos((e.track.position?.lat ?? 47.8) * (Math.PI / 180))
  return Math.hypot(e.eLat * KM_PER_DEG, e.eLon * KM_PER_DEG * cos)
}

/**
 * Turns sparse, noisy server states into continuous flight. The icon rides the
 * dead-reckoned course exactly (no lag); when a report corrects the course, the
 * difference becomes an offset that a critically damped spring brings back to
 * zero — no overshoot, no teleport, and the icon's velocity stays continuous.
 */
export class MotionModel {
  readonly #entries = new Map<string, Entry>()

  upsert(track: Track, now: number): void {
    const prev = this.#entries.get(track.id)
    const next = reckon(track, now)
    if (prev?.track.position && next) {
      const old = reckon(prev.track, now)
      if (old) {
        // Keep the displayed position and velocity continuous across the correction.
        prev.eLat += old.lat - next.lat
        prev.eLon += old.lon - next.lon
        prev.vLat += old.vLat - next.vLat
        prev.vLon += old.vLon - next.vLon
      }
      prev.track = track
      if (offsetKm(prev) > SNAP_KM) Object.assign(prev, { eLat: 0, eLon: 0, vLat: 0, vLon: 0 })
      return
    }
    this.#entries.set(track.id, {
      track,
      eLat: 0,
      eLon: 0,
      vLat: 0,
      vLon: 0,
      heading: track.headingDeg,
      t: now,
    })
  }

  remove(id: string): void {
    this.#entries.delete(id)
  }

  /** Drop entries whose tracks are gone. */
  retain(ids: Set<string>): void {
    for (const id of this.#entries.keys()) if (!ids.has(id)) this.#entries.delete(id)
  }

  /** Integrate every correction up to `now`. Call once per rendered frame. */
  advance(now: number): void {
    const ω = 2 / FOLLOW_TAU_S
    for (const e of this.#entries.values()) {
      let dt = Math.max(0, (now - e.t) / 1000)
      e.t = now
      if (dt > 10) {
        // Tab was asleep: just show where it is now.
        Object.assign(e, { eLat: 0, eLon: 0, vLat: 0, vLon: 0, heading: e.track.headingDeg })
        continue
      }
      while (dt > 0) {
        const h = Math.min(dt, SUBSTEP_S)
        dt -= h
        e.vLat += (-ω * ω * e.eLat - 2 * ω * e.vLat) * h
        e.vLon += (-ω * ω * e.eLon - 2 * ω * e.vLon) * h
        e.eLat += e.vLat * h
        e.eLon += e.vLon * h
        if (e.track.headingDeg !== null) {
          e.heading ??= e.track.headingDeg
          const k = 1 - Math.exp(-h / 0.8)
          e.heading = (e.heading + angleDiff(e.track.headingDeg, e.heading) * k + 360) % 360
        }
      }
      if (e.track.headingDeg === null) e.heading = null
    }
  }

  pose(id: string): Pose | null {
    const e = this.#entries.get(id)
    if (!e) return null
    const base = predictPosition(e.track, e.t)
    if (!base) return null
    return { lat: base.lat + e.eLat, lon: base.lon + e.eLon, heading: e.heading }
  }

  /** True while any icon is still absorbing a correction — keep the render loop smooth. */
  isSettling(): boolean {
    for (const e of this.#entries.values()) if (offsetKm(e) > SETTLED_KM) return true
    return false
  }

  get size(): number {
    return this.#entries.size
  }
}
