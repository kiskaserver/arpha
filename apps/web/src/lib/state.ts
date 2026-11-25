import type { AlertsState, StreamEvent, Track } from '@arpha/shared'

export interface LiveState {
  tracks: Map<string, Track>
  alerts: AlertsState
  demo: boolean
  /** serverTime − clientTime at the last snapshot, ms. Corrects skewed phone clocks. */
  clockOffset: number
  /** Monotonic counter to let views react cheaply. */
  version: number
}

export const initialState = (): LiveState => ({
  tracks: new Map(),
  alerts: { alerts: [], updatedAt: 0, stale: true },
  demo: false,
  clockOffset: 0,
  version: 0,
})

/** Pure reducer over server events (mutates the map for O(1) updates, bumps `version`). */
export function applyEvent(state: LiveState, ev: StreamEvent, clientNow: number): LiveState {
  switch (ev.type) {
    case 'snapshot': {
      state.tracks = new Map(ev.tracks.map((t) => [t.id, t]))
      state.alerts = ev.alerts
      state.demo = ev.demo
      state.clockOffset = ev.serverTime - clientNow
      break
    }
    case 'track':
      state.tracks.set(ev.track.id, ev.track)
      break
    case 'track_removed':
      state.tracks.delete(ev.id)
      break
    case 'alerts':
      state.alerts = ev.alerts
      break
  }
  state.version++
  return state
}

export function isStreamEvent(value: unknown): value is StreamEvent {
  if (!value || typeof value !== 'object') return false
  const t = (value as { type?: unknown }).type
  return t === 'snapshot' || t === 'track' || t === 'track_removed' || t === 'alerts'
}
