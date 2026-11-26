import { type LatLon, THREAT_CLASSES, type ThreatClass } from '@arpha/shared'

export type Theme = 'auto' | 'light' | 'dark'
export type SoundId = 'off' | 'soft' | 'chime' | 'siren'
export type SoundCategory = 'alert' | 'ballistic' | 'threat'

export interface SavedPoint extends LatLon {
  id: string
  name: string
  /** This place's own zone, km; absent = the default radiusKm. */
  radiusKm?: number
}

/** The zone that applies to a point. */
export const zoneOf = (p: { radiusKm?: number } | null | undefined, s: { radiusKm: number }) =>
  p?.radiusKm ?? s.radiusKm

export interface Settings {
  /** Watched places ("Дім", "Робота"); the first one is the reference for ETA in the list. */
  points: SavedPoint[]
  radiusKm: number
  theme: Theme
  pushEnabled: boolean
  pushAlerts: boolean
  pushThreats: boolean
  /** Threat classes to be notified about (push and in-app). */
  classes: ThreatClass[]
  /** In-app sounds while the app is open (system push sounds can't be customised). */
  sounds: Record<SoundCategory, SoundId>
  vibrate: boolean
  /** Visual alerts for people with hearing impairment: the screen border flashes. */
  flash: boolean
  /** Read new threats aloud (Ukrainian voice, foreground only). */
  speak: boolean
  /** How long destroyed/lost targets stay on the map, minutes (0 = disappear at once). */
  lingerMin: number
  /** Draw where every threat has been (otherwise only the selected one). */
  showTrails: boolean
  /** Show where threats were reported most in the last 30 days. */
  hotspots: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  points: [],
  radiusKm: 15,
  theme: 'auto',
  pushEnabled: false,
  pushAlerts: true,
  pushThreats: true,
  classes: [...THREAT_CLASSES],
  sounds: { alert: 'chime', ballistic: 'siren', threat: 'soft' },
  vibrate: true,
  flash: false,
  speak: false,
  lingerMin: 2,
  showTrails: false,
  hotspots: false,
}

const KEY = 'arpha:settings:v1'
const MAX_POINTS = 5
const SOUNDS: SoundId[] = ['off', 'soft', 'chime', 'siren']

const validPoint = (p: unknown): p is SavedPoint => {
  const x = p as SavedPoint
  return Boolean(
    x && Number.isFinite(x.lat) && Number.isFinite(x.lon) && typeof x.name === 'string' && x.name,
  )
}

export const newPointId = () => Math.random().toString(36).slice(2, 10)

/** Per-device preferences. Storage may be unavailable (private mode) — never throw. */
export function loadSettings(storage: Pick<Storage, 'getItem'> | null = safeStorage()): Settings {
  try {
    const raw = storage?.getItem(KEY)
    if (!raw) return structuredClone(DEFAULT_SETTINGS)
    const parsed = JSON.parse(raw) as Partial<Settings> & { point?: LatLon | null }
    const s: Settings = { ...structuredClone(DEFAULT_SETTINGS), ...parsed }
    // v1 stored a single `point`.
    if (!parsed.points && parsed.point) {
      s.points = [{ ...parsed.point, id: newPointId(), name: 'Моя точка' }]
    }
    delete (s as { point?: unknown }).point
    delete (s as { pointSource?: unknown }).pointSource
    s.points = (Array.isArray(s.points) ? s.points : [])
      .filter(validPoint)
      .slice(0, MAX_POINTS)
      .map((p) => {
        const r = Number(p.radiusKm)
        const { radiusKm: _, ...rest } = p
        return {
          ...rest,
          id: p.id || newPointId(),
          ...(r >= 1 && r <= 100 ? { radiusKm: Math.round(r) } : {}),
        }
      })
    s.showTrails = s.showTrails === true
    s.radiusKm = Math.min(100, Math.max(1, Number(s.radiusKm) || DEFAULT_SETTINGS.radiusKm))
    if (!['auto', 'light', 'dark'].includes(s.theme)) s.theme = 'auto'
    s.classes = (Array.isArray(s.classes) ? s.classes : DEFAULT_SETTINGS.classes).filter((c) =>
      THREAT_CLASSES.includes(c),
    )
    s.sounds = { ...DEFAULT_SETTINGS.sounds, ...(s.sounds ?? {}) }
    for (const k of Object.keys(s.sounds) as SoundCategory[]) {
      if (!SOUNDS.includes(s.sounds[k])) s.sounds[k] = DEFAULT_SETTINGS.sounds[k]
    }
    s.lingerMin = [0, 2, 5, 10].includes(s.lingerMin) ? s.lingerMin : DEFAULT_SETTINGS.lingerMin
    return s
  } catch {
    return structuredClone(DEFAULT_SETTINGS)
  }
}

export function saveSettings(
  s: Settings,
  storage: Pick<Storage, 'setItem'> | null = safeStorage(),
): void {
  try {
    storage?.setItem(KEY, JSON.stringify(s))
  } catch {
    /* quota / disabled storage: settings just won't persist */
  }
}

function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  if (theme === 'auto') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
}

export function prefersDark(theme: Theme): boolean {
  if (theme !== 'auto') return theme === 'dark'
  try {
    return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true
  } catch {
    return true
  }
}
