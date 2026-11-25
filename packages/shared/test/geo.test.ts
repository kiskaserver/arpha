import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  bearingDeg,
  compassToBearing,
  destination,
  haversineKm,
  inBbox,
  localFrame,
  normalizeBearing,
  pointInGeometry,
  pointInPolygon,
  ZAPORIZHZHIA,
} from '../src/geo'

const MELITOPOL = { lat: 46.8489, lon: 35.3653 }
const regionPoint = fc.record({
  lat: fc.double({ min: 46, max: 48.5, noNaN: true }),
  lon: fc.double({ min: 34, max: 37.5, noNaN: true }),
})

describe('haversineKm', () => {
  it('measures Zaporizhzhia → Melitopol (~111 km)', () => {
    expect(haversineKm(ZAPORIZHZHIA, MELITOPOL)).toBeCloseTo(111.4, 0)
  })

  it('is zero for identical points and symmetric', () => {
    fc.assert(
      fc.property(regionPoint, regionPoint, (a, b) => {
        expect(haversineKm(a, a)).toBe(0)
        expect(haversineKm(a, b)).toBeCloseTo(haversineKm(b, a), 9)
      }),
    )
  })
})

describe('bearingDeg / destination', () => {
  it('Melitopol is south of Zaporizhzhia', () => {
    const b = bearingDeg(ZAPORIZHZHIA, MELITOPOL)
    expect(b).toBeGreaterThan(165)
    expect(b).toBeLessThan(180)
  })

  it('destination inverts bearing + distance', () => {
    fc.assert(
      fc.property(
        regionPoint,
        fc.double({ min: 0, max: 359.9, noNaN: true }),
        fc.double({ min: 0.5, max: 200, noNaN: true }),
        (start, bearing, dist) => {
          const end = destination(start, bearing, dist)
          expect(haversineKm(start, end)).toBeCloseTo(dist, 6)
          const back = bearingDeg(start, end)
          const diff = Math.abs(((back - bearing + 540) % 360) - 180)
          expect(diff).toBeLessThan(1e-6)
        },
      ),
    )
  })

  it('normalizes negative and overflowing bearings', () => {
    expect(normalizeBearing(-90)).toBe(270)
    expect(normalizeBearing(725)).toBe(5)
  })
})

describe('localFrame', () => {
  it('round-trips points within the region', () => {
    const frame = localFrame(ZAPORIZHZHIA)
    fc.assert(
      fc.property(regionPoint, (p) => {
        const { x, y } = frame.toXY(p)
        const back = frame.toLatLon(x, y)
        expect(back.lat).toBeCloseTo(p.lat, 9)
        expect(back.lon).toBeCloseTo(p.lon, 9)
      }),
    )
  })

  it('approximates great-circle distance within 1 % over 110 km', () => {
    const frame = localFrame(ZAPORIZHZHIA)
    const { x, y } = frame.toXY(MELITOPOL)
    expect(Math.hypot(x, y) / haversineKm(ZAPORIZHZHIA, MELITOPOL)).toBeCloseTo(1, 2)
  })
})

describe('compassToBearing', () => {
  it('maps known points and rejects garbage', () => {
    expect(compassToBearing('nw')).toBe(315)
    expect(compassToBearing('S')).toBe(180)
    expect(compassToBearing('X')).toBeNull()
  })
})

describe('pointInPolygon', () => {
  const square = [
    [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ],
    [
      [4, 4],
      [6, 4],
      [6, 6],
      [4, 6],
      [4, 4],
    ],
  ]

  it('respects outer ring and holes', () => {
    expect(pointInPolygon({ lat: 2, lon: 2 }, square)).toBe(true)
    expect(pointInPolygon({ lat: 5, lon: 5 }, square)).toBe(false)
    expect(pointInPolygon({ lat: 12, lon: 2 }, square)).toBe(false)
    expect(pointInPolygon({ lat: 1, lon: 1 }, [])).toBe(false)
  })

  it('handles MultiPolygon', () => {
    const triangle = [
      [
        [20, 20],
        [30, 20],
        [30, 30],
        [20, 20],
      ],
    ]
    const geom = { type: 'MultiPolygon' as const, coordinates: [square, triangle] }
    expect(pointInGeometry({ lat: 22, lon: 25 }, geom)).toBe(true)
    expect(pointInGeometry({ lat: 2, lon: 2 }, { type: 'Polygon', coordinates: square })).toBe(true)
  })
})

describe('inBbox', () => {
  it('includes Zaporizhzhia and excludes Kyiv', () => {
    expect(inBbox(ZAPORIZHZHIA)).toBe(true)
    expect(inBbox({ lat: 50.45, lon: 30.52 })).toBe(false)
  })
})
