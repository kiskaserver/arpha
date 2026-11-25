import type { ActiveAlert } from '@arpha/shared'
import type { Boundaries } from '../alerts/boundaries'
import type { ExtractedEvent, RawMessage } from '../extract/types'
import type { ResolvedEvent, Tracker } from '../fusion/tracker'
import type { Gazetteer } from '../geo/gazetteer'

/**
 * Scripted attack used by DEMO_MODE: realistic routes through real places,
 * fed through the same geocoder and tracker as live data. Lets the UI, e2e
 * tests and reviewers see moving threats without Telegram credentials.
 */
export interface DemoStep {
  /** Seconds from scenario start. */
  at: number
  /** Logical group; the same group maps to one track. */
  group: string
  text: string
  event: Partial<ExtractedEvent>
}

/** Timings follow real speeds (~180 km/h for shaheds) so the filter sees a consistent picture. */
export const DEMO_SCENARIO: DemoStep[] = [
  {
    at: 0,
    group: 'kab',
    text: 'КАБи на Оріхів',
    event: { type: 'kab', location: 'Оріхів', count: 2 },
  },
  {
    at: 5,
    group: 'a',
    text: '3 шахеди в районі Михайлівки курсом на Запоріжжя',
    event: { location: 'Михайлівка', toward: 'Запоріжжя', count: 3 },
  },
  {
    at: 20,
    group: 'b',
    text: 'Шахед з боку Більмака на Гуляйполе',
    event: { from: 'Більмак', toward: 'Гуляйполе' },
  },
  {
    at: 60,
    group: 'r',
    text: 'Розвідувальний БпЛА біля Степногірська',
    event: { type: 'recon_drone', location: 'Степногірськ', heading: 'E' },
  },
  {
    at: 90,
    group: 'bal',
    text: '⚠️ Загроза балістики для Запоріжжя!',
    event: { type: 'ballistic', toward: 'Запоріжжя' },
  },
  {
    at: 300,
    group: 'kab',
    text: 'Повторні пуски КАБ по Оріхову',
    event: { type: 'kab', location: 'Оріхів', action: 'update' },
  },
  {
    at: 400,
    group: 'a',
    text: 'Група шахедів повз Василівку',
    event: { action: 'update', location: 'Василівка', toward: 'Запоріжжя' },
  },
  {
    at: 520,
    group: 'b',
    text: 'Шахед над Гуляйполем, курс на північний захід',
    event: { action: 'update', location: 'Гуляйполе', heading: 'NW' },
  },
  {
    at: 1000,
    group: 'a',
    text: 'Шахеди в районі Балабиного',
    event: { action: 'update', location: 'Балабине' },
  },
  { at: 1050, group: 'a', text: 'Мінус 1 над Балабиним', event: { action: 'destroyed', count: 1 } },
  {
    at: 1200,
    group: 'a',
    text: 'Двоє на Кушугум',
    event: { action: 'update', location: 'Кушугум', count: 2 },
  },
  { at: 1300, group: 'a', text: 'Мінус обидва', event: { action: 'destroyed' } },
  {
    at: 1420,
    group: 'b',
    text: 'Шахед на Комишуваху',
    event: { action: 'update', location: 'Комишуваха', toward: 'Запоріжжя' },
  },
  {
    at: 2000,
    group: 'b',
    text: 'Шахед повз Вільнянськ на Дніпропетровщину',
    event: { action: 'update', location: 'Вільнянськ', heading: 'N' },
  },
]

export const DEMO_LOOP_SECONDS = 2200

export const DEMO_ALERT: Omit<ActiveAlert, 'featureIds' | 'startedAt'> = {
  id: 1,
  locationTitle: 'Запорізька область',
  locationType: 'oblast',
  locationUid: '12',
  alertType: 'air_raid',
  level: 'red',
  threats: [
    { type: 'drones', level: 'red', startedAt: 0, message: 'Загроза ударних БпЛА' },
    { type: 'guided_aerial_bombs', level: 'red', startedAt: 0, message: 'Загроза КАБ' },
  ],
}

export class DemoSimulator {
  readonly #tracker: Tracker
  readonly #gazetteer: Gazetteer
  readonly #groups = new Map<string, string>()
  #cursor = 0
  #startedAt: number
  #msgId = 1

  constructor(tracker: Tracker, gazetteer: Gazetteer, startedAt: number) {
    this.#tracker = tracker
    this.#gazetteer = gazetteer
    this.#startedAt = startedAt
  }

  alerts(boundaries: Boundaries, now: number): ActiveAlert[] {
    return [{ ...DEMO_ALERT, startedAt: now, featureIds: boundaries.match(DEMO_ALERT) }]
  }

  /** Apply every step due by `now`; restarts the loop after DEMO_LOOP_SECONDS. */
  advance(now: number): number {
    let applied = 0
    if ((now - this.#startedAt) / 1000 >= DEMO_LOOP_SECONDS) {
      this.#tracker.allClear(now)
      this.#startedAt = now
      this.#cursor = 0
      this.#groups.clear()
    }
    const elapsed = (now - this.#startedAt) / 1000
    while (this.#cursor < DEMO_SCENARIO.length && DEMO_SCENARIO[this.#cursor]!.at <= elapsed) {
      this.#apply(DEMO_SCENARIO[this.#cursor]!, now)
      this.#cursor++
      applied++
    }
    return applied
  }

  #apply(step: DemoStep, now: number): void {
    const ev: ExtractedEvent = {
      type: 'shahed',
      model: null,
      count: null,
      action: 'new',
      location: null,
      precision: 'exact',
      from: null,
      toward: null,
      heading: null,
      track_id: this.#groups.get(step.group) ?? null,
      confidence: 0.9,
      ...step.event,
    }
    const look = (n: string | null) => (n ? this.#gazetteer.lookup(n) : null)
    const resolved: ResolvedEvent = {
      ...ev,
      locationPlace: look(ev.location),
      fromPlace: look(ev.from),
      towardPlace: look(ev.toward),
    }
    const message: RawMessage = {
      channel: 'demo',
      channelTitle: 'Демо-сценарій',
      id: this.#msgId++,
      date: now,
      editDate: null,
      text: step.text,
      replyToId: null,
    }
    const [id] = this.#tracker.apply([resolved], { message, parentTrackIds: [], observedAt: now })
    if (id) this.#groups.set(step.group, id)
  }
}
