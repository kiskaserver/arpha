import { describe, expect, it } from 'vitest'
import { computeApproach, formatMinutesUk } from '../src/eta'
import { destination, ZAPORIZHZHIA } from '../src/geo'
import type { Track } from '../src/model'

const NOW = 1_700_000_000_000

function track(overrides: Partial<Track> = {}): Track {
  return {
    id: 't1',
    type: 'shahed',
    count: 1,
    status: 'active',
    position: destination(ZAPORIZHZHIA, 180, 60),
    speedKmh: 180,
    headingDeg: 0,
    stateAt: NOW,
    uncertaintyKm: 3,
    placeName: null,
    target: null,
    confidence: 0.8,
    sources: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

describe('computeApproach', () => {
  it('head-on shahed 60 km south at 180 km/h enters the 10 km radius in ~16.7 min', () => {
    const a = computeApproach(track(), ZAPORIZHZHIA, NOW)!
    expect(a.approaching).toBe(true)
    expect(a.distanceKm).toBeCloseTo(60, 0)
    expect(a.closestKm).toBeLessThan(0.5)
    expect(a.closestInMin).toBeCloseTo(20, 0)
    expect(a.etaMin!).toBeCloseTo(50 / 3, 0)
  })

  it('a course that passes 30 km away has no ETA but a closest approach', () => {
    const start = destination(ZAPORIZHZHIA, 270, 30)
    const pos = destination(start, 180, 60)
    const a = computeApproach(track({ position: pos }), ZAPORIZHZHIA, NOW)!
    expect(a.approaching).toBe(true)
    expect(a.etaMin).toBeNull()
    expect(a.closestKm).toBeCloseTo(30, 0)
  })

  it('a receding object reports no approach', () => {
    const a = computeApproach(track({ headingDeg: 180 }), ZAPORIZHZHIA, NOW)!
    expect(a.approaching).toBe(false)
    expect(a.etaMin).toBeNull()
    expect(a.closestKm).toBeCloseTo(a.distanceKm, 6)
  })

  it('inside the radius ETA is zero', () => {
    const a = computeApproach(
      track({ position: destination(ZAPORIZHZHIA, 180, 5) }),
      ZAPORIZHZHIA,
      NOW,
    )!
    expect(a.etaMin).toBe(0)
  })

  it('stationary types (KAB) only report distance', () => {
    const a = computeApproach(
      track({ type: 'kab', speedKmh: null, headingDeg: null }),
      ZAPORIZHZHIA,
      NOW,
    )!
    expect(a.approaching).toBe(false)
    expect(a.etaMin).toBeNull()
  })

  it('stationary track inside the radius reports ETA 0', () => {
    const a = computeApproach(
      track({ type: 'kab', speedKmh: null, headingDeg: null, position: ZAPORIZHZHIA }),
      ZAPORIZHZHIA,
      NOW,
    )!
    expect(a.etaMin).toBe(0)
  })

  it('returns null without a position', () => {
    expect(computeApproach(track({ position: null }), ZAPORIZHZHIA, NOW)).toBeNull()
  })

  it('accounts for elapsed time via dead reckoning', () => {
    const a = computeApproach(track(), ZAPORIZHZHIA, NOW + 5 * 60_000)!
    expect(a.distanceKm).toBeCloseTo(45, 0)
    expect(a.etaMin!).toBeCloseTo(35 / 3, 0)
  })
})

describe('formatMinutesUk', () => {
  it.each([
    [0.4, '<1 хв'],
    [8.2, '8 хв'],
    [60, '1 год'],
    [65, '1 год 5 хв'],
  ])('%d → %s', (min, out) => {
    expect(formatMinutesUk(min)).toBe(out)
  })
})
