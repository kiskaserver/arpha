import { haversineKm, inBbox, type LatLon, ZAPORIZHZHIA } from '@arpha/shared'
import type { Store } from '../db'
import {
  type Extraction,
  type Extractor,
  extractionSchema,
  type ParentMessage,
  type RawMessage,
} from '../extract/types'
import type { ResolvedEvent, Tracker } from '../fusion/tracker'
import type { Gazetteer } from '../geo/gazetteer'
import type { Logger } from '../logger'

export interface MessageSource {
  /** Fetch a message by id (used to walk reply chains not yet seen). */
  getMessage(channel: string, id: number): Promise<RawMessage | null>
}

export interface ProcessedMessage {
  message: RawMessage
  extraction: Extraction
  resolved: ResolvedEvent[]
  trackIds: string[]
}

export interface PipelineDeps {
  /** Called for every relevant message after fusion (feed, infra, history). */
  onProcessed?(p: ProcessedMessage): void
  store: Store
  extractor: Extractor
  gazetteer: Gazetteer
  tracker: Tracker
  source: MessageSource
  logger: Logger
  concurrency: number
  now?: () => number
  /** Ignore reports older than this; Infinity for history import. */
  maxAgeMs?: number
  /**
   * Replays (history import): run fusion again on a stored extraction instead of
   * skipping the message, so a restarted import never pays for the model twice.
   */
  reuseStored?: boolean
}

const MAX_REPLY_DEPTH = 3
const HAS_CYRILLIC = /[А-Яа-яІіЇїЄєҐґ]/
/** Ignore reports older than this (backfill beyond the useful horizon). */
const MAX_AGE_MS = 3 * 60 * 60_000
/** Reject geocodes this far from the linked track's last position. */
const MAX_JUMP_KM = 120
/** Launch areas ("з Криму", "з Таганрогу", "з Курська") are farther than the oblast. */
const MAX_ORIGIN_KM = 1500
/**
 * Compass directions are not places: "з півночі" / "північні напрями" must not
 * fuzzy-match the village Північне 100 km south. Exact village names (Північне,
 * Південне, Східне) are neuter adjectives and do not match.
 */
const DIRECTION_TOKEN = new RegExp(
  '^(?:з|зі|із|від|на|у|в|до|бік|напрям(?:ок|ку|ки|ків|и|ах|ами)?|' +
    'північ|півночі|південь|півдня|півдні|схід|сходу|сході|захід|заходу|заході|' +
    '(?:північн|південн|східн|західн)(?:ий|ого|ому|им|ім|і|их|ими)|північно|південно)$',
  'u',
)
const DIRECTION_NAMED_PLACE = /^(?:північне|південне|східне|західне)$/u

/** True when every word is a compass word or a preposition ("з південного заходу"). */
export function isDirectionWord(name: string): boolean {
  const words = name
    .trim()
    .toLowerCase()
    .split(/[\s-]+/)
    .filter(Boolean)
  if (!words.length || (words.length === 1 && DIRECTION_NAMED_PLACE.test(words[0]!))) return false
  return words.every((w) => DIRECTION_TOKEN.test(w))
}

/**
 * Message → extraction → geocoding → fusion. Messages of one channel are
 * processed strictly in order (replies depend on their parents' results);
 * different channels run concurrently up to `concurrency`.
 */
export class Pipeline {
  readonly #d: PipelineDeps
  readonly #now: () => number
  readonly #chains = new Map<string, Promise<void>>()
  /** The newest submitted version of each post, so queued older versions are dropped. */
  readonly #latest = new Map<string, RawMessage>()
  #running = 0
  readonly #waiters: (() => void)[] = []
  #stats = { processed: 0, reused: 0, skipped: 0, failed: 0, events: 0 }

  constructor(deps: PipelineDeps) {
    this.#d = deps
    this.#now = deps.now ?? Date.now
  }

  get stats() {
    return { ...this.#stats }
  }

  /** Enqueue a message; resolves when it has been fully processed. */
  submit(msg: RawMessage): Promise<void> {
    // One post arrives several times (new, edited, history sweep) and channels fix
    // typos seconds after posting: only the newest queued version is worth a model call.
    const key = `${msg.channel}#${msg.id}`
    this.#latest.set(key, msg)
    const prev = this.#chains.get(msg.channel) ?? Promise.resolve()
    const next = prev.then(() => {
      if (this.#latest.get(key) !== msg) {
        this.#stats.skipped++
        return
      }
      this.#latest.delete(key)
      return this.#withSlot(() => this.#process(msg))
    })
    const tail = next.catch(() => {})
    this.#chains.set(msg.channel, tail)
    void tail.then(() => {
      if (this.#chains.get(msg.channel) === tail) this.#chains.delete(msg.channel)
    })
    return next
  }

  async #withSlot<T>(fn: () => Promise<T>): Promise<T> {
    while (this.#running >= this.#d.concurrency) {
      await new Promise<void>((r) => this.#waiters.push(r))
    }
    this.#running++
    try {
      return await fn()
    } finally {
      this.#running--
      this.#waiters.shift()?.()
    }
  }

  async #process(msg: RawMessage): Promise<void> {
    const { store, logger } = this.#d
    // Not `msg`: that is pino's message key.
    const log = logger.child({ channel: msg.channel, messageId: msg.id })
    const text = msg.text.trim()

    const existing = store.getMessage(msg.channel, msg.id)
    let cached: Extraction | null = null
    // Same version, or an edit that left the text alone (reactions, buttons, media).
    if (
      existing &&
      existing.extraction !== null &&
      (existing.editDate === msg.editDate || existing.text === msg.text)
    ) {
      cached = this.#d.reuseStored ? Pipeline.parseStored(existing.extraction) : null
      // Without a reusable extraction there is nothing new to learn (an outdated
      // stored schema in a replay is the exception: extract it again).
      if (!cached && (!this.#d.reuseStored || existing.extraction === '')) {
        this.#stats.skipped++
        return
      }
    }

    const now = this.#now()
    const save = (extraction: Extraction | null, trackIds: string[]) =>
      store.saveMessage({
        channel: msg.channel,
        id: msg.id,
        date: msg.date,
        editDate: msg.editDate,
        text: msg.text,
        replyToId: msg.replyToId,
        extraction: extraction ? JSON.stringify(extraction) : '',
        trackIds,
      })

    const maxAge = this.#d.maxAgeMs ?? MAX_AGE_MS
    if (!cached && (text.length < 3 || !HAS_CYRILLIC.test(text) || now - msg.date > maxAge)) {
      save(null, [])
      this.#stats.skipped++
      return
    }

    try {
      const parents = await this.#replyChain(msg)
      const extraction =
        cached ??
        (await this.#d.extractor.extract({
          message: msg,
          parents,
          activeTracks: this.#d.tracker.briefs(now),
          now,
        }))
      if (cached) this.#stats.reused++

      if (!extraction.relevant) {
        save(extraction, [])
        this.#stats.processed++
        return
      }

      const observedAt = Math.min(msg.editDate ?? msg.date, now)
      // An edited post keeps talking about the tracks its first version created
      // (a replay's stored ids belong to the previous run's tracker, not this one).
      const own = cached ? [] : (existing?.trackIds ?? [])
      const parentTrackIds = [...own, ...(parents[0]?.trackIds ?? [])]
      // The model copies places from anywhere up the reply chain, not only the parent.
      const parentPlaces = parents.flatMap((p) => p.places ?? [])
      const resolved = extraction.events.map((ev) =>
        this.#resolve(ev, parentTrackIds, text, parentPlaces),
      )
      const ids = this.#d.tracker.apply(resolved, { message: msg, parentTrackIds, observedAt })
      if (extraction.all_clear) this.#d.tracker.allClear(observedAt)

      const trackIds = [...new Set(ids.filter((id): id is string => id !== null))]
      save(extraction, trackIds)
      this.#d.onProcessed?.({ message: msg, extraction, resolved, trackIds })
      this.#stats.processed++
      this.#stats.events += extraction.events.length
      log.info(
        {
          events: extraction.events.length,
          tracks: trackIds,
          allClear: extraction.all_clear,
          edited: msg.editDate !== null,
        },
        'message processed',
      )
    } catch (err) {
      this.#stats.failed++
      log.error({ err }, 'message processing failed')
      throw err
    }
  }

  #resolve(
    ev: Extraction['events'][number],
    parentTrackIds: string[],
    text: string,
    parentPlaces: string[],
  ): ResolvedEvent {
    const { gazetteer, tracker } = this.#d
    const linked = [ev.track_id, ...parentTrackIds]
      .map((id) => (id ? tracker.get(id) : undefined))
      .filter((t) => t !== undefined)
    const anchor = linked.map((t) => t.position).find(Boolean) ?? null
    const near: LatLon = anchor ?? ZAPORIZHZHIA
    // A name that only matches a homonym far outside the region is a miss, not a teleport.
    const look = (name: string | null, origin = false) => {
      const place = name && !isDirectionWord(name) ? gazetteer.lookup(name, { near }) : null
      if (!place) return null
      // Origins legitimately lie outside the oblast: "з Криму", "з Таганрогу".
      if (origin) return haversineKm(ZAPORIZHZHIA, place) <= MAX_ORIGIN_KM ? place : null
      if (!inBbox(place)) return null
      // Relative to a known track, a jump this large is a homonym, not a flight.
      if (anchor && haversineKm(anchor, place) > MAX_JUMP_KM) return null
      return place
    }
    let locationPlace = look(ev.location)
    // "Довернув на X" in reply to "над Y": the model sometimes repeats Y as the current
    // position, which pins the object to where it was. Keep a repeated place only when
    // this post itself names it.
    const repeated = (name: string) =>
      linked.some((t) => t.placeName === name) ||
      parentPlaces.some((p) => p === name || look(p)?.name === name)
    if (
      locationPlace &&
      ev.action === 'update' &&
      repeated(locationPlace.name) &&
      !this.#names(text, locationPlace.name, near)
    ) {
      locationPlace = null
    }
    return {
      ...ev,
      locationPlace,
      fromPlace: look(ev.from, true),
      towardPlace: look(ev.toward),
    }
  }

  /** Whether the post text itself names `place` (directly, by an alias or slang). */
  #names(text: string, place: string, near: LatLon): boolean {
    const words = text.split(/[\s,.;:!?()«»"/+—–-]+/u).filter((w) => w.length > 1)
    for (let i = 0; i < words.length; i++) {
      for (let n = 1; n <= 3 && i + n <= words.length; n++) {
        if (this.#d.gazetteer.lookup(words.slice(i, i + n).join(' '), { near })?.name === place)
          return true
      }
    }
    return false
  }

  async #replyChain(msg: RawMessage): Promise<ParentMessage[]> {
    const parents: ParentMessage[] = []
    let replyTo = msg.replyToId
    while (replyTo !== null && parents.length < MAX_REPLY_DEPTH) {
      const stored = this.#d.store.getMessage(msg.channel, replyTo)
      if (stored) {
        const events = Pipeline.parseStored(stored.extraction)?.events ?? []
        const places = events.flatMap((e) => [e.location, e.toward]).filter((n) => n !== null)
        parents.push({ text: stored.text, date: stored.date, trackIds: stored.trackIds, places })
        replyTo = stored.replyToId
        continue
      }
      const fetched = await this.#d.source.getMessage(msg.channel, replyTo).catch(() => null)
      if (!fetched) break
      parents.push({ text: fetched.text, date: fetched.date, trackIds: [] })
      replyTo = fetched.replyToId
    }
    return parents
  }

  /** Re-hydrate an extraction saved by a previous run (for tests/eval tooling). */
  static parseStored(raw: string | null): Extraction | null {
    if (!raw) return null
    try {
      const parsed = extractionSchema.safeParse(JSON.parse(raw))
      return parsed.success ? parsed.data : null
    } catch {
      return null // corrupted row: treat as absent
    }
  }
}
