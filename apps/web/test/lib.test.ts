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
import { buildFrame, circlePolygon, frameInterval, isVisible, kmPerPixel } from '../src/lib/frame'
import { plural, uk } from '../src/lib/i18n'
import { iconSvg, infraSvg, THREAT_COLORS } from '../src/lib/icons'
import { FOLLOW_TAU_S, MotionModel } from '../src/lib/motion'
import {
  applyTheme,
  DEFAULT_SETTINGS,
  loadSettings,
  prefersDark,
  saveSettings,
} from '../src/lib/settings'
import { applyEvent, initialState, isStreamEvent } from '../src/lib/state'
import { alertedFeatures, alertLevel, threatRows } from '../src/lib/view'

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
    origin: null,
    prediction: null,
    model: null,
    confidence: 0.8,
    sources: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...o,
  }
}

const alert = (ids: string[], o: Record<string, unknown> = {}) => ({
  id: 1,
  locationTitle: 'x',
  locationType: 'oblast' as const,
  locationUid: '1',
  alertType: 'air_raid',
  level: null,
  threats: [],
  startedAt: 0,
  featureIds: ids,
  ...o,
})

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

  it('relative time and helpers', () => {
    expect(uk.ago(3)).toBe('щойно')
    expect(uk.ago(42)).toBe('42 с тому')
    expect(uk.ago(125)).toBe('2 хв тому')
    expect(uk.ago(7300)).toBe('2 год тому')
    expect(uk.level('red')).toBe('червоний рівень')
    expect(uk.level('yellow')).toBe('жовтий рівень')
    expect(uk.level('x')).toBe('')
    expect(uk.pointNameDefault(0)).toBe('Дім')
    expect(uk.pointNameDefault(1)).toBe('Робота')
    expect(uk.pointNameDefault(2)).toBe('Місце 3')
    expect(uk.lingerMin(5)).toBe('через 5 хв')
    expect(uk.fromSide('Крим')).toBe('з боку: Крим')
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
  it('produces coloured SVGs per type and for infra', () => {
    const svg = iconSvg('fpv')
    expect(svg).toContain(THREAT_COLORS.fpv)
    expect(svg.startsWith('<svg')).toBe(true)
    expect(infraSvg('closed')).toContain('#ff3b30')
    expect(infraSvg('open')).toContain('#30d158')
  })
})

describe('state reducer', () => {
  it('applies snapshot, updates, removals, alerts, infra and feed', () => {
    const s = initialState()
    const item = {
      key: 'c:1',
      channel: 'c',
      channelTitle: 'C',
      messageId: 1,
      text: 'шахед',
      at: NOW,
      types: [],
      trackIds: [],
    }
    applyEvent(
      s,
      {
        type: 'snapshot',
        tracks: [track()],
        alerts: { alerts: [], updatedAt: 1, stale: false },
        infra: [],
        feed: [item],
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
    applyEvent(
      s,
      {
        type: 'infra',
        infra: [
          { id: 'm', name: 'Мости', lat: 1, lon: 1, status: 'closed', updatedAt: 1, source: 'x' },
        ],
      },
      NOW,
    )
    applyEvent(s, { type: 'feed', item: { ...item, key: 'c:2' } }, NOW)
    applyEvent(s, { type: 'feed', item: { ...item, key: 'c:2' } }, NOW)
    expect([...s.tracks.keys()]).toEqual(['t2'])
    expect(s.alerts.updatedAt).toBe(5)
    expect(s.infra).toHaveLength(1)
    expect(s.feed.map((f) => f.key)).toEqual(['c:2', 'c:1'])
    expect(s.version).toBe(7)
  })

  it('validates event shape', () => {
    for (const t of ['track', 'infra', 'feed', 'snapshot', 'alerts', 'track_removed']) {
      expect(isStreamEvent({ type: t })).toBe(true)
    }
    expect(isStreamEvent({ type: 'nope' })).toBe(false)
    expect(isStreamEvent(null)).toBe(false)
    expect(isStreamEvent('x')).toBe(false)
  })
})

describe('MotionModel (smooth flight)', () => {
  const run = (m: MotionModel, from: number, to: number, stepMs = 33) => {
    const poses: { lat: number; lon: number }[] = []
    for (let t = from; t <= to; t += stepMs) {
      m.advance(t)
      poses.push(m.pose('t1')!)
    }
    return poses
  }

  it('starts on the track and dead-reckons along the course', () => {
    const m = new MotionModel()
    m.upsert(track(), NOW)
    m.advance(NOW)
    const a = m.pose('t1')!
    expect(haversineKm(a, track().position!)).toBeLessThan(0.01)
    run(m, NOW, NOW + 60_000)
    const b = m.pose('t1')!
    // Follows the 3 km/min course closely once settled.
    expect(haversineKm(a, b)).toBeGreaterThan(2.5)
    expect(haversineKm(a, b)).toBeLessThan(3.2)
    expect(b.heading).toBeCloseTo(0, 3)
  })

  it('a correction is flown over smoothly, never teleported', () => {
    const m = new MotionModel()
    m.upsert(track(), NOW)
    run(m, NOW, NOW + 30_000)
    const t = NOW + 30_000
    const before = m.pose('t1')!
    // New report 5 km east and a course change to north-east.
    m.upsert(track({ position: destination(before, 90, 5), stateAt: t, headingDeg: 45 }), t)
    expect(m.isSettling()).toBe(true)
    const end = t + 5 * FOLLOW_TAU_S * 1000
    const poses = run(m, t, end)
    let maxStep = 0
    let prev: { lat: number; lon: number } = before
    for (const p of poses) {
      maxStep = Math.max(maxStep, haversineKm(prev, p))
      prev = p
    }
    // No frame moves the icon more than a few hundred metres; the gap closes.
    expect(maxStep).toBeLessThan(0.35)
    expect(m.isSettling()).toBe(false)
    expect(m.pose('t1')!.heading).toBeCloseTo(45, 0)
  })

  it('snaps after an absurd gap and after a long sleep', () => {
    const m = new MotionModel()
    m.upsert(track(), NOW)
    m.advance(NOW)
    const far = destination(ZAPORIZHZHIA, 90, 100)
    m.upsert(track({ position: far, stateAt: NOW + 1000 }), NOW + 1000)
    m.advance(NOW + 1000)
    expect(haversineKm(m.pose('t1')!, far)).toBeLessThan(0.1)
    m.advance(NOW + 60_000) // tab asleep for a minute
    expect(m.isSettling()).toBe(false)
  })

  it('handles position-less tracks, heading loss, removal and retain', () => {
    const m = new MotionModel()
    m.upsert(track({ id: 'b', position: null }), NOW)
    m.advance(NOW)
    expect(m.pose('b')).toBeNull()
    expect(m.pose('missing')).toBeNull()
    m.upsert(track({ id: 'a' }), NOW)
    m.upsert(track({ id: 'a', headingDeg: null, speedKmh: null }), NOW + 1000)
    m.advance(NOW + 1000)
    expect(m.pose('a')!.heading).toBeNull()
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

  it('alert level and map colouring by alert type', () => {
    expect(alertLevel({ alerts: [], updatedAt: 0, stale: true }, [])).toBe('unknown')
    expect(alertLevel({ alerts: [], updatedAt: 0, stale: false }, [])).toBe('none')
    expect(alertLevel({ alerts: [alert(['r1'])], updatedAt: 0, stale: false }, ['r1'])).toBe('mine')
    expect(alertLevel({ alerts: [alert(['r2'])], updatedAt: 0, stale: false }, ['r1'])).toBe(
      'region',
    )
    const m = alertedFeatures({
      alerts: [
        alert(['r1', 'r2'], { alertType: 'artillery_shelling' }),
        alert(['r2'], { id: 2, alertType: 'air_raid' }),
      ],
      updatedAt: 0,
      stale: false,
    })
    expect(Object.fromEntries(m)).toEqual({ r1: 'artillery_shelling', r2: 'air_raid' })
  })
})

describe('frame', () => {
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

  it('hides finished targets after the linger time', () => {
    const dead = track({ status: 'lost', updatedAt: NOW })
    expect(isVisible(dead, NOW + 60_000, 2)).toBe(true)
    expect(isVisible(dead, NOW + 3 * 60_000, 2)).toBe(false)
    expect(isVisible(dead, NOW + 1, 0)).toBe(false)
    expect(isVisible(track(), NOW + 10 ** 9, 0)).toBe(true)
  })

  it('builds icons, vectors, reach cones, impact zones and the selected forecast', () => {
    const m = new MotionModel()
    const prediction = {
      computedAt: NOW,
      horizonMin: 15,
      targets: [{ name: 'Балабине', lat: 47.75, lon: 35.2, p: 0.7, etaMin: 9 }],
      impact: { lat: 47.75, lon: 35.2, radiusKm: 0.5 },
    }
    const tracks = [
      track({ id: 'a', count: 3, prediction }),
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
    m.advance(NOW + 60_000)
    const f = buildFrame({ tracks, motion: m, now: NOW + 60_000, selected: 'a', lingerMin: 2 })
    expect(f.points.map((p) => p.properties.id)).toEqual(['a', 'k'])
    expect(f.points[0]!.properties.label).toBe('×3')
    expect(f.points[1]!.properties.label).toBe('')
    expect(f.vectors).toHaveLength(1)
    expect(f.cones).toHaveLength(1)
    expect(f.impacts).toHaveLength(1)
    expect(f.predicted[0]!.properties.label).toBe('Балабине 70%')
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
      lingerMin: 0,
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
        lingerMin: 7,
        sounds: { alert: 'boom' as never, ballistic: 'siren', threat: 'off' },
        classes: ['kab', 'bogus' as never],
        points: [
          { id: 'a', name: 'Дім', lat: 47.8, lon: 35.1 },
          { id: 'b', name: '', lat: Number.NaN, lon: 1 },
        ],
      },
      s,
    )
    const loaded = loadSettings(s)
    expect(loaded.radiusKm).toBe(100)
    expect(loaded.theme).toBe('auto')
    expect(loaded.lingerMin).toBe(DEFAULT_SETTINGS.lingerMin)
    expect(loaded.sounds).toEqual({ alert: 'chime', ballistic: 'siren', threat: 'off' })
    expect(loaded.classes).toEqual(['kab'])
    expect(loaded.points.map((p) => p.name)).toEqual(['Дім'])
  })

  it('migrates the single point of v1', () => {
    const s = mem()
    s.setItem(
      'arpha:settings:v1',
      JSON.stringify({ point: { lat: 47.8, lon: 35.1 }, pointSource: 'gps' }),
    )
    const loaded = loadSettings(s)
    expect(loaded.points).toEqual([
      expect.objectContaining({ name: 'Моя точка', lat: 47.8, lon: 35.1 }),
    ])
    expect('point' in loaded).toBe(false)
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
