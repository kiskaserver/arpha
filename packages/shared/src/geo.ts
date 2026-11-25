/** Spherical-earth helpers. Accuracy (~0.3 %) is far better than the source reports. */

export const EARTH_RADIUS_KM = 6371.0088

export interface LatLon {
  lat: number
  lon: number
}

const toRad = (deg: number) => (deg * Math.PI) / 180
const toDeg = (rad: number) => (rad * 180) / Math.PI

export function normalizeBearing(deg: number): number {
  const b = deg % 360
  return b < 0 ? b + 360 : b
}

/** Great-circle distance in km. */
export function haversineKm(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Initial bearing from `a` to `b`, degrees clockwise from north. */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const φ1 = toRad(a.lat)
  const φ2 = toRad(b.lat)
  const Δλ = toRad(b.lon - a.lon)
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return normalizeBearing(toDeg(Math.atan2(y, x)))
}

/** Point reached travelling `distanceKm` from `start` on `bearing`. */
export function destination(start: LatLon, bearing: number, distanceKm: number): LatLon {
  const δ = distanceKm / EARTH_RADIUS_KM
  const θ = toRad(bearing)
  const φ1 = toRad(start.lat)
  const λ1 = toRad(start.lon)
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ))
  const λ2 =
    λ1 +
    Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2))
  return { lat: toDeg(φ2), lon: ((toDeg(λ2) + 540) % 360) - 180 }
}

/**
 * Local tangent-plane projection (east/north, km) around an origin.
 * Inside one oblast (~250 km) the distortion is negligible and it lets the
 * motion filter work in linear coordinates.
 */
export interface LocalFrame {
  toXY(p: LatLon): { x: number; y: number }
  toLatLon(x: number, y: number): LatLon
}

export function localFrame(origin: LatLon): LocalFrame {
  const kmPerDegLat = (Math.PI * EARTH_RADIUS_KM) / 180
  const kmPerDegLon = kmPerDegLat * Math.cos(toRad(origin.lat))
  return {
    toXY: (p) => ({ x: (p.lon - origin.lon) * kmPerDegLon, y: (p.lat - origin.lat) * kmPerDegLat }),
    toLatLon: (x, y) => ({ lat: origin.lat + y / kmPerDegLat, lon: origin.lon + x / kmPerDegLon }),
  }
}

/** Centre of Zaporizhzhia city; used as the default local-frame origin and map centre. */
export const ZAPORIZHZHIA: LatLon = { lat: 47.8388, lon: 35.1396 }

/** [west, south, east, north] — the oblast plus a margin for approaching threats. */
export const REGION_BBOX: [number, number, number, number] = [33.6, 45.9, 37.6, 48.6]

export function inBbox(p: LatLon, bbox: [number, number, number, number] = REGION_BBOX): boolean {
  return p.lon >= bbox[0] && p.lon <= bbox[2] && p.lat >= bbox[1] && p.lat <= bbox[3]
}

const COMPASS: Record<string, number> = {
  N: 0,
  NNE: 22.5,
  NE: 45,
  ENE: 67.5,
  E: 90,
  ESE: 112.5,
  SE: 135,
  SSE: 157.5,
  S: 180,
  SSW: 202.5,
  SW: 225,
  WSW: 247.5,
  W: 270,
  WNW: 292.5,
  NW: 315,
  NNW: 337.5,
}

export type CompassPoint = keyof typeof COMPASS

export function compassToBearing(point: string): number | null {
  const v = COMPASS[point.toUpperCase()]
  return v === undefined ? null : v
}

/** Ray-casting point-in-polygon for GeoJSON rings ([lon, lat][]). First ring is outer, rest are holes. */
export function pointInPolygon(p: LatLon, rings: number[][][]): boolean {
  const inRing = (ring: number[][]) => {
    let inside = false
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i] as [number, number]
      const [xj, yj] = ring[j] as [number, number]
      if (yi > p.lat !== yj > p.lat && p.lon < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) {
        inside = !inside
      }
    }
    return inside
  }
  const [outer, ...holes] = rings
  if (!outer || !inRing(outer)) return false
  return !holes.some(inRing)
}

export function pointInGeometry(
  p: LatLon,
  geometry:
    | { type: 'Polygon'; coordinates: number[][][] }
    | { type: 'MultiPolygon'; coordinates: number[][][][] },
): boolean {
  if (geometry.type === 'Polygon') return pointInPolygon(p, geometry.coordinates)
  return geometry.coordinates.some((poly) => pointInPolygon(p, poly))
}
