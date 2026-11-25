import type { FeedItem, InfraStatus } from '@arpha/shared'
import type { Store } from '../db'
import type { RawMessage } from '../extract/types'
import type { Gazetteer } from '../geo/gazetteer'

/** A closure nobody re-confirms is assumed lifted after this long. */
const CLOSED_TTL_MS = 6 * 3_600_000
/** "Reopened" is shown briefly, then disappears. */
const OPEN_TTL_MS = 30 * 60_000
const KEY = 'infra'

/**
 * Bridges and the DniproHES dam: channels post "мости та ГЕС перекрито" /
 * "рух відновлено". We geocode the object and keep its latest status.
 */
export class InfraService {
  readonly #items = new Map<string, InfraStatus>()
  readonly #store: Store
  readonly #gazetteer: Gazetteer
  readonly #onChange: (items: InfraStatus[]) => void

  constructor(store: Store, gazetteer: Gazetteer, onChange: (items: InfraStatus[]) => void) {
    this.#store = store
    this.#gazetteer = gazetteer
    this.#onChange = onChange
    for (const i of store.getJson<InfraStatus[]>(KEY) ?? []) this.#items.set(i.id, i)
  }

  list(): InfraStatus[] {
    return [...this.#items.values()]
  }

  apply(closures: { object: string; status: 'closed' | 'open' }[], msg: RawMessage): void {
    let changed = false
    for (const c of closures) {
      const place = this.#gazetteer.lookup(c.object)
      if (!place) continue
      const id = place.name
      const prev = this.#items.get(id)
      if (prev && prev.status === c.status && prev.updatedAt >= msg.date) continue
      this.#items.set(id, {
        id,
        name: place.name,
        lat: place.lat,
        lon: place.lon,
        status: c.status,
        updatedAt: msg.date,
        source: msg.channelTitle,
      })
      changed = true
    }
    if (changed) this.#publish()
  }

  tick(now: number): void {
    let changed = false
    for (const [id, i] of this.#items) {
      const ttl = i.status === 'closed' ? CLOSED_TTL_MS : OPEN_TTL_MS
      if (now - i.updatedAt > ttl) {
        this.#items.delete(id)
        changed = true
      }
    }
    if (changed) this.#publish()
  }

  #publish(): void {
    const items = this.list()
    this.#store.setJson(KEY, items)
    this.#onChange(items)
  }
}

/** Ring buffer of recent relevant posts for the in-app feed. */
export class FeedBuffer {
  readonly #items: FeedItem[] = []
  readonly #size: number

  constructor(size = 80) {
    this.#size = size
  }

  add(item: FeedItem): void {
    if (this.#items.some((i) => i.key === item.key)) return
    this.#items.unshift(item)
    this.#items.sort((a, b) => b.at - a.at)
    this.#items.length = Math.min(this.#items.length, this.#size)
  }

  list(): FeedItem[] {
    return [...this.#items]
  }
}
