import type { LatLon } from '@arpha/shared'

export type Theme = 'auto' | 'light' | 'dark'

export interface Settings {
  point: LatLon | null
  pointSource: 'gps' | 'manual' | null
  radiusKm: number
  theme: Theme
  pushEnabled: boolean
  pushAlerts: boolean
  pushThreats: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  point: null,
  pointSource: null,
  radiusKm: 15,
  theme: 'auto',
  pushEnabled: false,
  pushAlerts: true,
  pushThreats: true,
}

const KEY = 'arpha:settings:v1'

/** Per-device preferences. Storage may be unavailable (private mode) — never throw. */
export function loadSettings(storage: Pick<Storage, 'getItem'> | null = safeStorage()): Settings {
  try {
    const raw = storage?.getItem(KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<Settings>
    const s = { ...DEFAULT_SETTINGS, ...parsed }
    if (s.point && !(Number.isFinite(s.point.lat) && Number.isFinite(s.point.lon))) {
      s.point = null
      s.pointSource = null
    }
    s.radiusKm = Math.min(100, Math.max(1, Number(s.radiusKm) || DEFAULT_SETTINGS.radiusKm))
    if (!['auto', 'light', 'dark'].includes(s.theme)) s.theme = 'auto'
    return s
  } catch {
    return { ...DEFAULT_SETTINGS }
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
