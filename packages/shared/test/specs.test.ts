import { describe, expect, it } from 'vitest'
import { haversineKm } from '../src/geo'
import { DEFAULT_MODEL, flightMinutes, WEAPON_IDS, WEAPON_SPECS, weaponSpec } from '../src/specs'
import { THREAT_PROFILES } from '../src/threats'

describe('weapon specs', () => {
  it('every entry is sourced, consistent and in Ukrainian', () => {
    expect(new Set(WEAPON_IDS).size).toBe(WEAPON_IDS.length)
    for (const w of WEAPON_SPECS) {
      expect(w.sources.length, w.id).toBeGreaterThan(0)
      for (const s of w.sources) expect(s).toMatch(/^https:\/\//)
      expect(w.maxKmh, w.id).toBeGreaterThanOrEqual(w.cruiseKmh)
      expect(w.rangeKm, w.id).toBeGreaterThan(0)
      expect(w.nameUk).toMatch(/[А-ЯІЇЄҐа-яіїєґ]/)
      expect(w.aliases.length).toBeGreaterThan(0)
    }
  })

  it('type defaults match the published figures of the most common model', () => {
    for (const [type, id] of Object.entries(DEFAULT_MODEL)) {
      const spec = weaponSpec(id)!
      expect(spec.type).toBe(type)
      const profile = THREAT_PROFILES[spec.type]
      if (profile.moving)
        expect(Math.abs(profile.speedKmh - spec.cruiseKmh) / spec.cruiseKmh).toBeLessThan(0.15)
    }
  })

  it('looks up by id with a per-type fallback', () => {
    expect(weaponSpec('geran_3')!.cruiseKmh).toBe(370)
    expect(weaponSpec(null, 'kab')!.id).toBe('umpk_fab500')
    expect(weaponSpec('nope', 'aircraft')).toBeNull()
    expect(weaponSpec(undefined)).toBeNull()
  })

  it('Iskander from Crimea reaches Zaporizhzhia in about three minutes', () => {
    const km = haversineKm({ lat: 45.7, lon: 34.4 }, { lat: 47.84, lon: 35.14 })
    const min = flightMinutes(weaponSpec('iskander_m')!, km)
    expect(min).toBeGreaterThan(2)
    expect(min).toBeLessThan(4)
  })
})
