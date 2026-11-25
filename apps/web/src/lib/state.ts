import type { AlertsState, FeedItem, InfraStatus, StreamEvent, Track } from '@arpha/shared'

export interface LiveState {
  tracks: Map<string, Track>
  alerts: AlertsState
  infra: InfraStatus[]
  /** Newest first. */
  feed: FeedItem[]
  demo: boolean
  /** serverTime − clientTime at the last snapshot, ms. Corrects skewed phone clocks. */
  clockOffset: number
  /** Monotonic counter to let views react cheaply. */
  version: number
}

const FEED_SIZE = 80

export const initialState = (): LiveState => ({
  tracks: new Map(),
  alerts: { alerts: [], updatedAt: 0, stale: true },
  infra: [],
  feed: [],
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
      state.infra = ev.infra ?? []
      state.feed = ev.feed ?? []
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
    case 'infra':
      state.infra = ev.infra
      break
    case 'feed':
      if (!state.feed.some((f) => f.key === ev.item.key)) {
        state.feed = [ev.item, ...state.feed].slice(0, FEED_SIZE)
      }
      break
  }
  state.version++
  return state
}

export function isStreamEvent(value: unknown): value is StreamEvent {
  if (!value || typeof value !== 'object') return false
  const t = (value as { type?: unknown }).type
  return (
    t === 'snapshot' ||
    t === 'track' ||
    t === 'track_removed' ||
    t === 'alerts' ||
    t === 'infra' ||
    t === 'feed'
  )
}
