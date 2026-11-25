import { haversineKm, type LatLon, localFrame } from './geo'
import { isExtrapolating, predictPosition, type Track } from './model'

export interface Approach {
  /** Current great-circle distance to the observer. */
  distanceKm: number
  /** Whether the current velocity reduces the distance. */
  approaching: boolean
  /** Closest distance on the current course (equals distanceKm when stationary/receding). */
  closestKm: number
  /** Minutes until the closest point. 0 when stationary/receding. */
  closestInMin: number
  /** Minutes until the object enters `hitRadiusKm`; null when the course misses it. */
  etaMin: number | null
}

export const DEFAULT_HIT_RADIUS_KM = 10

/**
 * Closest-approach analysis in a tangent plane centred on the observer.
 * Uses the same dead-reckoned state as the map so the numbers match the icon.
 */
export function computeApproach(
  track: Track,
  observer: LatLon,
  now: number,
  hitRadiusKm = DEFAULT_HIT_RADIUS_KM,
): Approach | null {
  const pos = predictPosition(track, now)
  if (!pos) return null
  const distanceKm = haversineKm(pos, observer)
  const stationary: Approach = {
    distanceKm,
    approaching: false,
    closestKm: distanceKm,
    closestInMin: 0,
    etaMin: distanceKm <= hitRadiusKm ? 0 : null,
  }
  if (!isExtrapolating(track, now) || track.speedKmh === null || track.headingDeg === null) {
    return stationary
  }

  const frame = localFrame(observer)
  const p = frame.toXY(pos)
  const speedKmMin = track.speedKmh / 60
  const θ = (track.headingDeg * Math.PI) / 180
  const v = { x: speedKmMin * Math.sin(θ), y: speedKmMin * Math.cos(θ) }

  const pv = p.x * v.x + p.y * v.y
  const vv = v.x * v.x + v.y * v.y
  if (pv >= 0 || vv === 0) return stationary

  const tStar = -pv / vv
  const closestKm = Math.hypot(p.x + v.x * tStar, p.y + v.y * tStar)

  let etaMin: number | null = null
  const pp = p.x * p.x + p.y * p.y
  const r2 = hitRadiusKm * hitRadiusKm
  if (pp <= r2) {
    etaMin = 0
  } else if (closestKm <= hitRadiusKm) {
    // |p + v t| = r  →  vv t² + 2 pv t + (pp − r²) = 0; take the first (entry) root.
    const disc = pv * pv - vv * (pp - r2)
    etaMin = (-pv - Math.sqrt(Math.max(0, disc))) / vv
  }

  return { distanceKm, approaching: true, closestKm, closestInMin: tStar, etaMin }
}

/** "8 хв", "1 год 5 хв", "<1 хв" — compact Ukrainian duration. */
export function formatMinutesUk(min: number): string {
  if (min < 1) return '<1 хв'
  const total = Math.round(min)
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h === 0) return `${m} хв`
  return m === 0 ? `${h} год` : `${h} год ${m} хв`
}
