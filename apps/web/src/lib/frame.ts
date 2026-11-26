import {
  bearingDeg,
  destination,
  isExtrapolating,
  type LatLon,
  THREAT_PROFILES,
  type Track,
  trackCone,
} from '@arpha/shared'
import { THREAT_COLORS } from './icons'
import type { MotionModel } from './motion'

/** How far ahead the course vector is drawn. */
const VECTOR_MIN = 5
export const MIN_FRAME_MS = 33
export const MAX_FRAME_MS = 1000

export type Feature = GeoJSON.Feature<GeoJSON.Geometry, Record<string, unknown>>
export const fc = (features: Feature[]): GeoJSON.FeatureCollection => ({
  type: 'FeatureCollection',
  features,
})

/** An active threat no source has mentioned for longer than its dead-reckoning horizon. */
export function isQuiet(t: Track, now: number): boolean {
  const horizon = Math.max(THREAT_PROFILES[t.type].maxExtrapolationMin, 3) * 60_000
  return now - t.updatedAt > horizon
}

/** Degrees between a course and the bearing to a point (0 = dead ahead, 180 = behind). */
function offCourse(from: LatLon, heading: number, to: LatLon): number {
  return Math.abs(((bearingDeg(from, to) - heading + 540) % 360) - 180)
}

/** Polygon approximating a circle (good enough for radii ≤ 100 km). */
export function circlePolygon(center: LatLon, radiusKm: number, steps = 48): GeoJSON.Polygon {
  const ring: number[][] = []
  for (let i = 0; i <= steps; i++) {
    const p = destination(center, (i * 360) / steps, radiusKm)
    ring.push([p.lon, p.lat])
  }
  return { type: 'Polygon', coordinates: [ring] }
}

/** km per CSS pixel at a zoom level (512-px tiles). */
export function kmPerPixel(zoom: number, lat: number): number {
  return (40075.016 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** zoom)
}

/**
 * Frame interval that moves the fastest icon about half a pixel per frame:
 * a shahed at oblast zoom needs ~1 fps, a cruise missile zoomed in gets 30 fps.
 * This is the main battery saver.
 */
export function frameInterval(maxSpeedKmh: number, zoom: number, lat: number): number {
  if (maxSpeedKmh <= 0) return MAX_FRAME_MS
  const pxPerMs = maxSpeedKmh / 3_600_000 / kmPerPixel(zoom, lat)
  return Math.min(MAX_FRAME_MS, Math.max(MIN_FRAME_MS, 0.5 / pxPerMs))
}

/** Finished tracks stay visible for `lingerMin` minutes (user setting). */
export function isVisible(t: Track, now: number, lingerMin: number): boolean {
  return t.status === 'active' || now - t.updatedAt < lingerMin * 60_000
}

export interface FrameInput {
  tracks: Iterable<Track>
  motion: MotionModel
  now: number
  selected: string | null
  lingerMin: number
  /** Whose trail to draw (default: the selected threat's). */
  trails?: 'selected' | 'all' | 'off'
}

/** Build the per-frame GeoJSON (pure; unit-tested). Call `motion.advance(now)` first. */
export function buildFrame({
  tracks,
  motion,
  now,
  selected,
  lingerMin,
  trails: trailMode = 'selected',
}: FrameInput) {
  const points: Feature[] = []
  const vectors: Feature[] = []
  const targets: Feature[] = []
  const cones: Feature[] = []
  const impacts: Feature[] = []
  const predicted: Feature[] = []
  const trails: Feature[] = []
  const trailPoints: Feature[] = []
  let maxSpeed = 0
  let selectedPose: (LatLon & { uncertaintyKm: number }) | null = null

  for (const t of tracks) {
    if (!isVisible(t, now, lingerMin)) continue
    const color = THREAT_COLORS[t.type]
    const impact = t.status === 'active' ? t.prediction?.impact : null
    if (impact) {
      impacts.push({
        type: 'Feature',
        geometry: circlePolygon(impact, impact.radiusKm, 40),
        properties: { id: t.id, color, selected: t.id === selected },
      })
    }
    const pose = t.position ? (motion.pose(t.id) ?? { ...t.position, heading: t.headingDeg }) : null
    if (t.id === selected && t.prediction) {
      for (const c of t.prediction.targets) {
        // The forecast is made when a report arrives; the icon flies on between reports.
        // Places it has since passed are behind it, not where it is going.
        if (pose && pose.heading !== null && offCourse(pose, pose.heading, c) > 90) continue
        predicted.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
          properties: { label: `${c.name} ${Math.round(c.p * 100)}%`, p: c.p, color },
        })
      }
    }
    if (!t.position || !pose) {
      if (t.target && t.status === 'active') {
        targets.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [t.target.lon, t.target.lat] },
          properties: { id: t.id, color },
        })
      }
      continue
    }
    const moving = isExtrapolating(t, now)
    // Where it has been: the reported villages, joined up to where it is now.
    const sel = t.id === selected
    const drawn = trailMode === 'all' || (trailMode === 'selected' && sel)
    const trail = drawn ? (t.trail ?? []) : []
    if (trail.length) {
      trails.push({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [...trail.map((p) => [p.lon, p.lat]), [pose.lon, pose.lat]],
        },
        properties: { color, selected: sel },
      })
      trail.forEach((p, i) => {
        trailPoints.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
          // Names for the selected track; the latest place gets the label first.
          properties: { color, selected: sel, label: sel ? p.name : '', order: trail.length - i },
        })
      })
    }
    if (moving && t.speedKmh) maxSpeed = Math.max(maxSpeed, t.speedKmh)
    points.push({
      type: 'Feature',
      id: t.id,
      geometry: { type: 'Point', coordinates: [pose.lon, pose.lat] },
      properties: {
        id: t.id,
        type: t.type,
        status: t.status,
        rotate: pose.heading ?? 0,
        label: t.count && t.count > 1 ? `×${t.count}` : '',
        selected: t.id === selected,
        // Silent for longer than it can be dead-reckoned: we no longer know where it is.
        quiet: t.status === 'active' && isQuiet(t, now),
      },
    })
    if (moving && pose.heading !== null && t.speedKmh) {
      const ahead = destination(pose, pose.heading, (t.speedKmh / 60) * VECTOR_MIN)
      vectors.push({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            [pose.lon, pose.lat],
            [ahead.lon, ahead.lat],
          ],
        },
        properties: { color },
      })
      const cone = trackCone(t, now, pose)
      if (cone) {
        cones.push({
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [cone] },
          properties: { color, selected: t.id === selected },
        })
      }
    }
    if (t.id === selected) {
      // Uncertainty grows while dead-reckoning without fresh reports.
      const ageMin = Math.max(0, (now - t.stateAt) / 60_000)
      const growth = THREAT_PROFILES[t.type].moving ? ageMin * 0.8 : 0
      selectedPose = { lat: pose.lat, lon: pose.lon, uncertaintyKm: t.uncertaintyKm + growth }
    }
  }
  return {
    points,
    vectors,
    targets,
    cones,
    impacts,
    predicted,
    trails,
    trailPoints,
    maxSpeed,
    selectedPose,
  }
}
