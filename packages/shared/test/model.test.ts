import { describe, expect, it } from 'vitest'
import { alertCovers, cityUnderAlert, OBLAST_FEATURE_ID, ZP_CITY_FEATURE_ID } from '../src/alerts'
import { haversineKm, ZAPORIZHZHIA } from '../src/geo'
import { bearingToCompassUk, THREAT_LABELS_UK, threatLabelUk } from '../src/labels'
import { isExtrapolating, kmToTarget, predictPosition, type Track } from '../src/model'
import { pushSubscriptionSchema } from '../src/schemas'
import { isThreatType, THREAT_PROFILES, THREAT_TYPES, typesCompatible } from '../src/threats'

const NOW = 1_700_000_000_000
const base: Track = {
  id: 'x',
  type: 'shahed',
  count: null,
  status: 'active',
  position: ZAPORIZHZHIA,
  speedKmh: 180,
  headingDeg: 90,
  stateAt: NOW,
  uncertaintyKm: 2,
  placeName: null,
  target: null,
  origin: null,
  prediction: null,
  model: null,
  confidence: 1,
  sources: [],
  createdAt: NOW,
  updatedAt: NOW,
}

describe('predictPosition', () => {
  it('moves 3 km per minute at 180 km/h', () => {
    const p = predictPosition(base, NOW + 60_000)!
    expect(haversineKm(ZAPORIZHZHIA, p)).toBeCloseTo(3, 3)
    expect(p.lon).toBeGreaterThan(ZAPORIZHZHIA.lon)
  })

  it('stops extrapolating after the horizon', () => {
    const horizon = THREAT_PROFILES.shahed.maxExtrapolationMin
    const a = predictPosition(base, NOW + horizon * 60_000)!
    const b = predictPosition(base, NOW + (horizon + 30) * 60_000)!
    expect(haversineKm(a, b)).toBeLessThan(1e-9)
    expect(isExtrapolating(base, NOW + (horizon + 1) * 60_000)).toBe(false)
    expect(isExtrapolating(base, NOW)).toBe(true)
  })

  it('never moves destroyed, stationary-type, or velocity-less tracks', () => {
    for (const t of [
      { ...base, status: 'destroyed' as const },
      { ...base, type: 'kab' as const },
      { ...base, speedKmh: null },
      { ...base, headingDeg: null },
    ]) {
      expect(predictPosition(t, NOW + 120_000)).toEqual(ZAPORIZHZHIA)
    }
    expect(predictPosition({ ...base, position: null }, NOW)).toBeNull()
  })

  it('clamps negative elapsed time (clock skew)', () => {
    expect(predictPosition(base, NOW - 60_000)).toEqual(ZAPORIZHZHIA)
  })
})

describe('threat taxonomy', () => {
  it('has a profile and Ukrainian label for every type', () => {
    for (const t of THREAT_TYPES) {
      expect(THREAT_PROFILES[t]).toBeDefined()
      expect(THREAT_LABELS_UK[t].one).toMatch(/[А-ЯІЇЄҐа-яіїєґ]/)
    }
  })

  it('profiles are internally consistent', () => {
    for (const t of THREAT_TYPES) {
      const p = THREAT_PROFILES[t]
      expect(p.maxSpeedKmh).toBeGreaterThanOrEqual(p.speedKmh)
      expect(p.ttlMin).toBeGreaterThan(p.maxExtrapolationMin)
      expect(p.moving).toBe(p.speedKmh > 0)
    }
  })

  it('typesCompatible groups drones', () => {
    expect(typesCompatible('shahed', 'jet_drone')).toBe(true)
    expect(typesCompatible('shahed', 'unknown')).toBe(true)
    expect(typesCompatible('shahed', 'kab')).toBe(false)
    expect(typesCompatible('kab', 'kab')).toBe(true)
  })

  it('isThreatType guards', () => {
    expect(isThreatType('shahed')).toBe(true)
    expect(isThreatType('tank')).toBe(false)
    expect(isThreatType(3)).toBe(false)
  })
})

describe('labels', () => {
  it('pluralizes with count', () => {
    expect(threatLabelUk('shahed', 1)).toBe('Шахед')
    expect(threatLabelUk('shahed', null)).toBe('Шахед')
    expect(threatLabelUk('shahed', 4)).toBe('Шахеди ×4')
  })

  it('maps bearings to compass', () => {
    expect(bearingToCompassUk(0)).toBe('пн')
    expect(bearingToCompassUk(359)).toBe('пн')
    expect(bearingToCompassUk(-45)).toBe('пн-зх')
    expect(bearingToCompassUk(135)).toBe('пд-сх')
  })
})

describe('pushSubscriptionSchema', () => {
  it('applies defaults and validates keys', () => {
    const parsed = pushSubscriptionSchema.parse({
      subscription: { endpoint: 'https://push.example/abc', keys: { p256dh: 'k', auth: 'a' } },
      point: null,
    })
    expect(parsed.radiusKm).toBe(15)
    expect(parsed.alerts).toBe(true)
    expect(() =>
      pushSubscriptionSchema.parse({ subscription: { endpoint: 'nope' }, point: null }),
    ).toThrow()
  })
})

describe('alertCovers (city is announced separately)', () => {
  const a = (
    featureIds: string[],
    locationType: 'oblast' | 'raion' | 'city' | 'hromada' = 'raion',
  ) => ({
    featureIds,
    locationType,
  })
  const CITY_AREA = [ZP_CITY_FEATURE_ID, 'r11857100', OBLAST_FEATURE_ID]
  it('a raion alert does not put the city under alert', () => {
    expect(alertCovers(a(['r11857100']), CITY_AREA)).toBe(false)
    expect(alertCovers(a([ZP_CITY_FEATURE_ID], 'city'), CITY_AREA)).toBe(true)
    expect(alertCovers(a([OBLAST_FEATURE_ID], 'oblast'), CITY_AREA)).toBe(true)
    expect(cityUnderAlert([a(['r11857100'])])).toBe(false)
    expect(cityUnderAlert([a([ZP_CITY_FEATURE_ID], 'city')])).toBe(true)
  })
  it('outside the city, any overlapping polygon counts', () => {
    expect(alertCovers(a(['r11857100']), ['r123', 'r11857100'])).toBe(true)
    expect(alertCovers(a(['r9']), ['r123'])).toBe(false)
  })
})

describe('predictPosition near a named target', () => {
  // 10 km due east of the city, flying east at 180 km/h.
  const target = { name: 'X', lat: ZAPORIZHZHIA.lat, lon: ZAPORIZHZHIA.lon + 10 / 74.6 }

  it('stops at a target ahead instead of flying past it', () => {
    const p = predictPosition({ ...base, target }, NOW + 10 * 60_000)!
    expect(haversineKm(p, target)).toBeLessThan(0.2)
    expect(haversineKm(ZAPORIZHZHIA, p)).toBeLessThan(10.2)
  })

  it('stops extrapolating once it reaches the target (no course drawn beyond it)', () => {
    const t = { ...base, target }
    expect(isExtrapolating(t, NOW + 2 * 60_000)).toBe(true) // 6 of 10 km
    expect(isExtrapolating(t, NOW + 4 * 60_000)).toBe(false) // there
    expect(kmToTarget(t)).toBeCloseTo(10, 0)
    expect(kmToTarget({ ...t, headingDeg: 270 })).toBeNull()
  })

  it('ignores a target behind it (the course changed, not the destination)', () => {
    const p = predictPosition({ ...base, target, headingDeg: 270 }, NOW + 10 * 60_000)!
    expect(haversineKm(ZAPORIZHZHIA, p)).toBeCloseTo(30, 0)
  })
})
