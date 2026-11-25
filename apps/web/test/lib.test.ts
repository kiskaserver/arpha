import { destination, haversineKm, type Track, ZAPORIZHZHIA } from '@arpha/shared'
import { describe, expect, it, vi } from 'vitest'
import {
  formatAgo,
  formatClock,
  formatCourse,
  formatDistance,
  formatEta,
  formatSpeed,
} from '../src/lib/format'
import { buildFrame, circlePolygon, frameInterval, kmPerPixel } from '../src/lib/frame'
import { plural, uk } from '../src/lib/i18n'
import { iconSvg, THREAT_COLORS } from '../src/lib/icons'
import { BLEND_MS, MotionModel } from '../src/lib/motion'
import {
  applyTheme,
  DEFAULT_SETTINGS,
  loadSettings,
  prefersDark,
  saveSettings,
} from '../src/lib/settings'
import { applyEvent, initialState, isStreamEvent } from '../src/lib/state'
import { alertedFeatureIds, alertLevel, threatRows } from '../src/lib/view'

const NOW = 1_800_000_000_000

function track(o: Partial<Track> = {}): Track {
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
    placeName: 'Василівка',
    target: null,
    confidence: 0.8,
    sources: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...o,
  }
}

describe('i18n', () => {
  it.each([
    [1, 'загроза'],
    [2, 'загрози'],
    [5, 'загроз'],
    [11, 'загроз'],
    [21, 'загроза'],
    [22, 'загрози'],
    [112, 'загроз'],
  ])('plural(%d) → %s', (n, word) => {
    expect(plural(n, 'загроза', 'загрози', 'загроз')).toBe(word)
  })

  it('relative time', () => {
    expect(uk.ago(3)).toBe('щойно')
    expect(uk.ago(42)).toBe('42 с тому')
    expect(uk.ago(125)).toBe('2 хв тому')
    expect(uk.ago(7300)).toBe('2 год тому')
  })

  it('has no Russian-only letters in any UI string', () => {
    const strings = Object.values(uk).flatMap((v) => (typeof v === 'string' ? [v] : []))
    for (const s of strings) expect(s, s).not.toMatch(/[ыэъё]/i)
  })
})

describe('format', () => {
  it('formats kinematics', () => {
    expect(formatSpeed(track({ speedKmh: 183 }))).toBe('~180 км/год')
    expect(formatSpeed(track({ speedKmh: null }))).toBe('—')
    expect(formatCourse(track({ headingDeg: 315 }))).toBe('пн-зх (315°)')
    expect(formatCourse(track({ headingDeg: null }))).toBe('—')
    expect(formatDistance(4.26)).toBe('4.3 км')
    expect(formatDistance(42.6)).toBe('43 км')
    expect(formatEta(null)).toBe('Курс не на вас')
    expect(formatEta(0)).toBe('Поруч')
    expect(formatEta(12.4)).toBe('~12 хв')
    expect(formatAgo(NOW - 5000, NOW)).toBe('щойно')
    expect(formatAgo(NOW + 5000, NOW)).toBe('щойно')
    expect(formatClock(Date.UTC(2026, 0, 1, 12, 5))).toMatch(/\d\d:\d\d/)
  })
})

describe('icons', () => {
  it('produces a coloured SVG per type', () => {
    const svg = iconSvg('kab')
    expect(svg).toContain(THREAT_COLORS.kab)
    expect(svg.startsWith('<svg')).toBe(true)
  })
})

describe('state reducer', () => {
  it('applies snapshot, updates, removals and alerts', () => {
    const s = initialState()
    applyEvent(
      s,
      {
        type: 'snapshot',
        tracks: [track()],
        alerts: { alerts: [], updatedAt: 1, stale: false },
        serverTime: NOW + 2000,
        demo: true,
      },
      NOW,
    )
    expect(s.tracks.size).toBe(1)
    expect(s.clockOffset).toBe(2000)
    expect(s.demo).toBe(true)
    applyEvent(s, { type: 'track', track: track({ id: 't2' }) }, NOW)
    applyEvent(s, { type: 'track_removed', id: 't1' }, NOW)
    applyEvent(s, { type: 'alerts', alerts: { alerts: [], updatedAt: 5, stale: true } }, NOW)
    expect([...s.tracks.keys()]).toEqual(['t2'])
    expect(s.alerts.updatedAt).toBe(5)
    expect(s.version).toBe(4)
  })

  it('validates event shape', () => {
    expect(isStreamEvent({ type: 'track' })).toBe(true)
    expect(isStreamEvent({ type: 'nope' })).toBe(false)
    expect(isStreamEvent(null)).toBe(false)
    expect(isStreamEvent('x')).toBe(false)
  })
})

describe('MotionModel', () => {
  it('dead-reckons between reports', () => {
    const m = new MotionModel()
    m.upsert(track(), NOW)
    const a = m.pose('t1', NOW)!
    const b = m.pose('t1', NOW + 60_000)!
    expect(haversineKm(a, b)).toBeCloseTo(3, 1)
    expect(b.heading).toBe(0)
  })

  it('never teleports: a correction is blended in over BLEND_MS', () => {
    const m = new MotionModel()
    m.upsert(track(), NOW)
    const t = NOW + 60_000
    const before = m.pose('t1', t)!
    // New report 6 km east and heading north-east.
    m.upsert(track({ position: destination(before, 90, 6), stateAt: t, headingDeg: 45 }), t)
    const right = m.pose('t1', t)!
    expect(haversineKm(before, right)).toBeLessThan(0.01)
    expect(right.heading).toBeCloseTo(0, 5)
    expect(m.isBlending(t + 10)).toBe(true)

    // Max jump per 33 ms frame stays tiny during the blend.
    let prev = right
    for (let dt = 33; dt <= BLEND_MS + 33; dt += 33) {
      const p = m.pose('t1', t + dt)!
      expect(haversineKm(prev, p)).toBeLessThan(0.6)
      prev = p
    }
    expect(m.isBlending(t + BLEND_MS + 1)).toBe(false)
    expect(prev.heading).toBeCloseTo(45, 5)
  })

  it('handles position-less tracks, removal and retain', () => {
    const m = new MotionModel()
    m.upsert(track({ id: 'b', position: null }), NOW)
    expect(m.pose('b', NOW)).toBeNull()
    expect(m.pose('missing', NOW)).toBeNull()
    m.upsert(track({ id: 'a' }), NOW)
    m.upsert(track({ id: 'a', headingDeg: null, speedKmh: null }), NOW + 1000)
    expect(m.pose('a', NOW + 1000)!.heading).toBeNull()
    m.retain(new Set(['a']))
    expect(m.size).toBe(1)
    m.remove('a')
    expect(m.size).toBe(0)
  })
})

describe('view', () => {
  it('orders by ETA, then distance, finished last, position-less first', () => {
    const rows = threatRows(
      [
        track({ id: 'far', position: destination(ZAPORIZHZHIA, 90, 80), headingDeg: 90 }),
        track({ id: 'soon', position: destination(ZAPORIZHZHIA, 180, 30) }),
        track({ id: 'later' }),
        track({ id: 'dead', status: 'destroyed' }),
        track({
          id: 'bal',
          type: 'ballistic',
          position: null,
          target: { name: 'Запоріжжя', ...ZAPORIZHZHIA },
        }),
        track({ id: 'bal2', type: 'ballistic', position: null, updatedAt: NOW + 1 }),
      ],
      null,
      NOW,
      10,
    )
    expect(rows.map((r) => r.track.id)).toEqual(['bal2', 'bal', 'soon', 'later', 'far', 'dead'])
  })

  it('distance tie-break when neither has an ETA', () => {
    const rows = threatRows(
      [
        track({ id: 'b', position: destination(ZAPORIZHZHIA, 90, 80), headingDeg: 90 }),
        track({ id: 'a', position: destination(ZAPORIZHZHIA, 90, 40), headingDeg: 90 }),
      ],
      ZAPORIZHZHIA,
      NOW,
      10,
    )
    expect(rows.map((r) => r.track.id)).toEqual(['a', 'b'])
  })

  it('alert level', () => {
    const a = (ids: string[]) => ({
      id: 1,
      locationTitle: 'x',
      locationType: 'oblast' as const,
      locationUid: '1',
      alertType: 'air_raid',
      startedAt: 0,
      featureIds: ids,
    })
    expect(alertLevel({ alerts: [], updatedAt: 0, stale: true }, [])).toBe('unknown')
    expect(alertLevel({ alerts: [], updatedAt: 0, stale: false }, [])).toBe('none')
    expect(alertLevel({ alerts: [a(['r1'])], updatedAt: 0, stale: false }, ['r1'])).toBe('mine')
    expect(alertLevel({ alerts: [a(['r2'])], updatedAt: 0, stale: false }, ['r1'])).toBe('region')
    expect([
      ...alertedFeatureIds({ alerts: [a(['r1', 'r2'])], updatedAt: 0, stale: false }),
    ]).toEqual(['r1', 'r2'])
  })
})

describe('map helpers', () => {
  it('circle polygon is closed with the right radius', () => {
    const poly = circlePolygon(ZAPORIZHZHIA, 10, 16)
    const ring = poly.coordinates[0]!
    expect(ring).toHaveLength(17)
    expect(ring[0]).toEqual(ring[16])
    const [lon, lat] = ring[4] as [number, number]
    expect(haversineKm(ZAPORIZHZHIA, { lat, lon })).toBeCloseTo(10, 3)
  })

  it('frame interval saves battery at oblast zoom and goes smooth when zoomed in', () => {
    expect(kmPerPixel(8, 47.8)).toBeGreaterThan(0.1)
    expect(frameInterval(180, 7.5, 47.8)).toBe(1000)
    expect(frameInterval(180, 14, 47.8)).toBeLessThan(1000)
    expect(frameInterval(900, 14, 47.8)).toBe(33)
    expect(frameInterval(0, 14, 47.8)).toBe(1000)
  })

  it('builds frame features for moving, stationary, target-only and selected tracks', () => {
    const m = new MotionModel()
    const tracks = [
      track({ id: 'a', count: 3 }),
      track({ id: 'k', type: 'kab', speedKmh: null, headingDeg: null }),
      track({
        id: 'b',
        type: 'ballistic',
        position: null,
        target: { name: 'Запоріжжя', ...ZAPORIZHZHIA },
      }),
      track({
        id: 'gone',
        status: 'destroyed',
        position: null,
        target: { name: 'x', lat: 1, lon: 1 },
      }),
    ]
    for (const t of tracks) m.upsert(t, NOW)
    const f = buildFrame({ tracks, motion: m, now: NOW + 60_000, selected: 'a' })
    expect(f.points.map((p) => p.properties.id)).toEqual(['a', 'k'])
    expect(f.points[0]!.properties.label).toBe('×3')
    expect(f.points[1]!.properties.label).toBe('')
    expect(f.vectors).toHaveLength(1)
    expect(f.targets).toHaveLength(1)
    expect(f.maxSpeed).toBe(180)
    expect(f.selectedPose!.uncertaintyKm).toBeCloseTo(3.8, 5)
  })

  it('falls back to the raw position when motion has no entry', () => {
    const f = buildFrame({
      tracks: [track({ id: 'z' })],
      motion: new MotionModel(),
      now: NOW,
      selected: null,
    })
    expect(f.points).toHaveLength(1)
  })
})

describe('settings', () => {
  const mem = () => {
    const data = new Map<string, string>()
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    }
  }

  it('round-trips and sanitizes', () => {
    const s = mem()
    saveSettings(
      {
        ...DEFAULT_SETTINGS,
        radiusKm: 500,
        theme: 'neon' as never,
        point: { lat: Number.NaN, lon: 1 },
      },
      s,
    )
    const loaded = loadSettings(s)
    expect(loaded.radiusKm).toBe(100)
    expect(loaded.theme).toBe('auto')
    expect(loaded.point).toBeNull()
  })

  it('survives missing or broken storage', () => {
    expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(loadSettings({ getItem: () => '{bad json' })).toEqual(DEFAULT_SETTINGS)
    expect(() =>
      saveSettings(DEFAULT_SETTINGS, {
        setItem: () => {
          throw new Error('quota')
        },
      }),
    ).not.toThrow()
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('applies theme attributes', () => {
    const el = document.createElement('div')
    applyTheme('dark', el)
    expect(el.getAttribute('data-theme')).toBe('dark')
    applyTheme('auto', el)
    expect(el.hasAttribute('data-theme')).toBe(false)
    expect(prefersDark('light')).toBe(false)
    expect(prefersDark('dark')).toBe(true)
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    expect(prefersDark('auto')).toBe(false)
    vi.unstubAllGlobals()
  })
})
