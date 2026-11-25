import {
  destination,
  isExtrapolating,
  type LatLon,
  THREAT_PROFILES,
  type Track,
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

export interface FrameInput {
  tracks: Iterable<Track>
  motion: MotionModel
  now: number
  selected: string | null
}

/** Build the per-frame GeoJSON (pure; unit-tested). */
export function buildFrame({ tracks, motion, now, selected }: FrameInput) {
  const points: Feature[] = []
  const vectors: Feature[] = []
  const targets: Feature[] = []
  let maxSpeed = 0
  let selectedPose: (LatLon & { uncertaintyKm: number }) | null = null

  for (const t of tracks) {
    if (!t.position) {
      if (t.target && t.status === 'active') {
        targets.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [t.target.lon, t.target.lat] },
          properties: { id: t.id, color: THREAT_COLORS[t.type] },
        })
      }
      continue
    }
    const pose = motion.pose(t.id, now) ?? { ...t.position, heading: t.headingDeg }
    const moving = isExtrapolating(t, now)
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
        properties: { color: THREAT_COLORS[t.type] },
      })
    }
    if (t.id === selected) {
      // Uncertainty grows while dead-reckoning without fresh reports.
      const ageMin = Math.max(0, (now - t.stateAt) / 60_000)
      const growth = THREAT_PROFILES[t.type].moving ? ageMin * 0.8 : 0
      selectedPose = { lat: pose.lat, lon: pose.lon, uncertaintyKm: t.uncertaintyKm + growth }
    }
  }
  return { points, vectors, targets, maxSpeed, selectedPose }
}
