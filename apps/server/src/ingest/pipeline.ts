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
}

const MAX_REPLY_DEPTH = 3
const HAS_CYRILLIC = /[А-Яа-яІіЇїЄєҐґ]/
/** Ignore reports older than this (backfill beyond the useful horizon). */
const MAX_AGE_MS = 3 * 60 * 60_000
/** Reject geocodes this far from the linked track's last position. */
const MAX_JUMP_KM = 120

/**
 * Message → extraction → geocoding → fusion. Messages of one channel are
 * processed strictly in order (replies depend on their parents' results);
 * different channels run concurrently up to `concurrency`.
 */
export class Pipeline {
  readonly #d: PipelineDeps
  readonly #now: () => number
  readonly #chains = new Map<string, Promise<void>>()
  #running = 0
  readonly #waiters: (() => void)[] = []
  #stats = { processed: 0, skipped: 0, failed: 0, events: 0 }

  constructor(deps: PipelineDeps) {
    this.#d = deps
    this.#now = deps.now ?? Date.now
  }

  get stats() {
    return { ...this.#stats }
  }

  /** Enqueue a message; resolves when it has been fully processed. */
  submit(msg: RawMessage): Promise<void> {
    const prev = this.#chains.get(msg.channel) ?? Promise.resolve()
    const next = prev.then(() => this.#withSlot(() => this.#process(msg)))
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
    if (existing && existing.editDate === msg.editDate && existing.extraction !== null) {
      this.#stats.skipped++
      return
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

    if (text.length < 3 || !HAS_CYRILLIC.test(text) || now - msg.date > MAX_AGE_MS) {
      save(null, [])
      this.#stats.skipped++
      return
    }

    try {
      const parents = await this.#replyChain(msg)
      const extraction = await this.#d.extractor.extract({
        message: msg,
        parents,
        activeTracks: this.#d.tracker.briefs(now),
        now,
      })

      if (!extraction.relevant) {
        save(extraction, [])
        this.#stats.processed++
        return
      }

      const observedAt = Math.min(msg.editDate ?? msg.date, now)
      // An edited post keeps talking about the tracks its first version created.
      const parentTrackIds = [...(existing?.trackIds ?? []), ...(parents[0]?.trackIds ?? [])]
      const resolved = extraction.events.map((ev) => this.#resolve(ev, parentTrackIds))
      const ids = this.#d.tracker.apply(resolved, { message: msg, parentTrackIds, observedAt })
      if (extraction.all_clear) this.#d.tracker.allClear(observedAt)

      const trackIds = [...new Set(ids.filter((id): id is string => id !== null))]
      save(extraction, trackIds)
      this.#d.onProcessed?.({ message: msg, extraction, resolved, trackIds })
      this.#stats.processed++
      this.#stats.events += extraction.events.length
      log.info(
        { events: extraction.events.length, tracks: trackIds, allClear: extraction.all_clear },
        'message processed',
      )
    } catch (err) {
      this.#stats.failed++
      log.error({ err }, 'message processing failed')
      throw err
    }
  }

  #resolve(ev: Extraction['events'][number], parentTrackIds: string[]): ResolvedEvent {
    const { gazetteer, tracker } = this.#d
    const anchor =
      (ev.track_id ? tracker.get(ev.track_id)?.position : null) ??
      parentTrackIds.map((id) => tracker.get(id)?.position).find(Boolean) ??
      null
    const near: LatLon = anchor ?? ZAPORIZHZHIA
    // A name that only matches a homonym far outside the region is a miss, not a teleport.
    const look = (name: string | null) => {
      const place = name ? gazetteer.lookup(name, { near }) : null
      if (!place || !inBbox(place)) return null
      // Relative to a known track, a jump this large is a homonym, not a flight.
      if (anchor && haversineKm(anchor, place) > MAX_JUMP_KM) return null
      return place
    }
    return {
      ...ev,
      locationPlace: look(ev.location),
      fromPlace: look(ev.from),
      towardPlace: look(ev.toward),
    }
  }

  async #replyChain(msg: RawMessage): Promise<ParentMessage[]> {
    const parents: ParentMessage[] = []
    let replyTo = msg.replyToId
    while (replyTo !== null && parents.length < MAX_REPLY_DEPTH) {
      const stored = this.#d.store.getMessage(msg.channel, replyTo)
      if (stored) {
        parents.push({ text: stored.text, date: stored.date, trackIds: stored.trackIds })
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
    const parsed = extractionSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  }
}
