import { describe, expect, it, vi } from 'vitest'
import { Store } from '../src/db'
import { buildUserPrompt } from '../src/extract/prompt'
import type { Extraction, ExtractionInput, Extractor, RawMessage } from '../src/extract/types'
import { Tracker } from '../src/fusion/tracker'
import {
  clearScope,
  isDirectionWord,
  Pipeline,
  quotedTracks,
  slashPeers,
} from '../src/ingest/pipeline'
import { silentLogger } from '../src/logger'
import { event, gazetteer, message, min } from './helpers'

type Script = (input: ExtractionInput) => Extraction | Promise<Extraction>

function setup(script: Script, source: Record<number, RawMessage> = {}) {
  const store = new Store(':memory:')
  const tracker = new Tracker()
  const extract = vi.fn(async (i: ExtractionInput) => script(i))
  const extractor: Extractor = { extract }
  const getMessage = vi.fn(async (_c: string, id: number) => source[id] ?? null)
  let now = min(1)
  const pipeline = new Pipeline({
    store,
    extractor,
    gazetteer: gazetteer(),
    tracker,
    source: { getMessage },
    logger: silentLogger,
    concurrency: 2,
    now: () => now,
  })
  return { store, tracker, extract, getMessage, pipeline, setNow: (n: number) => (now = n) }
}

const relevant = (...events: Extraction['events']): Extraction => ({
  relevant: true,
  all_clear: false,
  closures: [],
  events,
})

describe('Pipeline', () => {
  it('extracts, geocodes and tracks a message, then stores the result', async () => {
    const { pipeline, tracker, store } = setup(() =>
      relevant(event({ location: 'Оріхова', toward: 'Запоріжжю' })),
    )
    await pipeline.submit(message({ id: 10, text: 'шахед повз Оріхів на Запоріжжя' }))
    const [t] = tracker.active()
    expect(t).toMatchObject({ placeName: 'Оріхів', target: { name: 'Запоріжжя' } })
    expect(store.getMessage('test_channel', 10)!.trackIds).toEqual([t!.id])
    expect(pipeline.stats).toMatchObject({ processed: 1, events: 1 })
  })

  it('skips duplicates but re-processes edits', async () => {
    const { pipeline, extract } = setup(() => relevant(event({ location: 'Оріхів' })))
    const m = message({ id: 1, text: 'шахед Оріхів' })
    await pipeline.submit(m)
    await pipeline.submit(m)
    expect(extract).toHaveBeenCalledTimes(1)
    await pipeline.submit({ ...m, editDate: min(0.5), text: 'шахед Оріхів, курс на північ' })
    expect(extract).toHaveBeenCalledTimes(2)
    expect(pipeline.stats.skipped).toBe(1)
  })

  it('an edited post updates the track it created instead of spawning a new one', async () => {
    let n = 0
    const { pipeline, tracker } = setup(() =>
      relevant(event({ location: n++ === 0 ? 'Оріхів' : 'Мала Токмачка', action: 'update' })),
    )
    const m = message({ id: 1, text: 'шахед' })
    await pipeline.submit(m)
    await pipeline.submit({ ...m, editDate: min(0.5), text: 'шахед, уточнення' })
    expect(tracker.active()).toHaveLength(1)
  })

  it('an edit that keeps the text (reactions, buttons) does not call the model again', async () => {
    const { pipeline, extract } = setup(() => relevant(event({ location: 'Оріхів' })))
    const m = message({ id: 1, text: 'шахед Оріхів' })
    await pipeline.submit(m)
    await pipeline.submit({ ...m, editDate: min(0.2) })
    await pipeline.submit({ ...m, editDate: min(0.3) })
    expect(extract).toHaveBeenCalledTimes(1)
    expect(pipeline.stats.skipped).toBe(2)
  })

  it('a burst of versions of one post (new, edited, sweep) costs one model call', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const seen: string[] = []
    const { pipeline, extract } = setup(async (i) => {
      seen.push(i.message.text)
      await gate
      return relevant(event({ location: 'Оріхів' }))
    })
    // Another post of the channel is in flight, so the versions queue up behind it.
    const busy = pipeline.submit(message({ id: 9, text: 'шахед Комишуваха' }))
    const original = message({ id: 1, text: 'шахед Оріхв' })
    const edited = { ...original, editDate: min(0.1), text: 'шахед Оріхів' }
    const all = Promise.all([
      pipeline.submit(original),
      pipeline.submit(edited),
      pipeline.submit({ ...edited }),
    ])
    release()
    await Promise.all([busy, all])
    expect(extract).toHaveBeenCalledTimes(2)
    expect(seen).toEqual(['шахед Комишуваха', 'шахед Оріхів'])
    expect(pipeline.stats.skipped).toBe(2)
  })

  it('a replay reuses stored extractions instead of calling the model again', async () => {
    const store = new Store(':memory:')
    const extract = vi.fn(async () => relevant(event({ location: 'Оріхів' })))
    const make = (tracker: Tracker) =>
      new Pipeline({
        store,
        extractor: { extract },
        gazetteer: gazetteer(),
        tracker,
        source: { getMessage: async () => null },
        logger: silentLogger,
        concurrency: 1,
        now: () => min(1),
        reuseStored: true,
      })
    const m = message({ id: 1, text: 'шахед Оріхів' })
    const noise = message({ id: 2, text: '👍' })
    await make(new Tracker()).submit(m)
    await make(new Tracker()).submit(noise)
    // A restarted import: a fresh tracker, the same cache.
    const tracker = new Tracker()
    const second = make(tracker)
    await second.submit(m)
    await second.submit(noise)
    expect(extract).toHaveBeenCalledTimes(1)
    expect(tracker.active()).toHaveLength(1)
    expect(second.stats).toMatchObject({ processed: 1, reused: 1, skipped: 1 })
    // A stored extraction that no longer parses is extracted again, not trusted.
    store.saveMessage({ ...store.getMessage('test_channel', 1)!, extraction: '{"relevant":' })
    await make(new Tracker()).submit(m)
    expect(extract).toHaveBeenCalledTimes(2)
  })

  it('ignores noise without calling the model', async () => {
    const { pipeline, extract, setNow } = setup(() => relevant())
    await pipeline.submit(message({ id: 1, text: '👍' }))
    await pipeline.submit(message({ id: 2, text: 'hello world' }))
    setNow(min(60 * 5))
    await pipeline.submit(message({ id: 3, text: 'старий шахед' }))
    expect(extract).not.toHaveBeenCalled()
    expect(pipeline.stats.skipped).toBe(3)
  })

  it('stores irrelevant messages so they are not re-sent', async () => {
    const { pipeline, extract, store } = setup(() => ({
      relevant: false,
      all_clear: false,
      closures: [],
      events: [],
    }))
    await pipeline.submit(message({ id: 5, text: 'Підтримайте канал донатом' }))
    await pipeline.submit(message({ id: 5, text: 'Підтримайте канал донатом' }))
    expect(extract).toHaveBeenCalledOnce()
    expect(store.getMessage('test_channel', 5)!.trackIds).toEqual([])
  })

  it('walks the reply chain from the store and passes parent track ids', async () => {
    const { pipeline, tracker, extract } = setup((i) =>
      i.message.id === 1
        ? relevant(event({ location: 'Оріхів' }))
        : relevant(event({ action: 'destroyed' })),
    )
    await pipeline.submit(message({ id: 1, text: 'шахед Оріхів' }))
    const id = tracker.active()[0]!.id
    await pipeline.submit(message({ id: 2, text: 'мінус', replyToId: 1, date: min(0.5) }))
    expect(extract.mock.calls[1]![0].parents).toEqual([
      { text: 'шахед Оріхів', date: min(0), trackIds: [id], places: ['Оріхів'] },
    ])
    expect(tracker.get(id)!.status).toBe('destroyed')
  })

  it('fetches unknown parents from the source, bounded in depth', async () => {
    const chain: Record<number, RawMessage> = {}
    for (let i = 1; i <= 5; i++)
      chain[i] = message({ id: i, text: `p${i}`, replyToId: i > 1 ? i - 1 : null })
    const { pipeline, extract, getMessage } = setup(() => relevant(), chain)
    await pipeline.submit(message({ id: 6, text: 'реплай', replyToId: 5 }))
    expect(extract.mock.calls[0]![0].parents.map((p) => p.text)).toEqual(['p5', 'p4', 'p3'])
    expect(getMessage).toHaveBeenCalledTimes(3)
  })

  it('tolerates a failing source when walking replies', async () => {
    const { pipeline, extract, getMessage } = setup(() => relevant())
    getMessage.mockRejectedValueOnce(new Error('flood wait'))
    await pipeline.submit(message({ id: 2, text: 'реплай', replyToId: 1 }))
    expect(extract.mock.calls[0]![0].parents).toEqual([])
  })

  it('"Локаційно чисто" in a reply ends that thread only; a standalone "відбій" clears all', async () => {
    const { pipeline, tracker } = setup((i) =>
      i.message.id === 3
        ? { relevant: true, all_clear: true, closures: [], events: [] }
        : i.message.id === 4
          ? { relevant: true, all_clear: true, closures: [], events: [] }
          : relevant(event({ location: i.message.id === 1 ? 'Оріхів' : 'Гуляйполе' })),
    )
    await pipeline.submit(message({ id: 1, text: 'шахед Оріхів' }))
    await pipeline.submit(message({ id: 2, text: 'шахед Гуляйполе' }))
    await pipeline.submit(message({ id: 3, text: 'Локаційно чисто', replyToId: 1, date: min(0.5) }))
    expect(tracker.active().map((t) => t.placeName)).toEqual(['Гуляйполе'])
    await pipeline.submit(message({ id: 4, text: 'Відбій тривоги', date: min(0.6) }))
    expect(tracker.active()).toHaveLength(0)
  })

  it('"Відбій по балістиці" ends ballistic warnings, not the drones still flying', () => {
    expect(clearScope('Відбій по Балістиці')).toEqual(['ballistic'])
    expect(clearScope('Відбій тривоги в Запоріжжі')).toBeUndefined()
    expect(clearScope('По БпЛА чисто')).toContain('shahed')
    expect(clearScope('Локаційно чисто')).toBeUndefined()
    expect(clearScope('Відбій по КАБах')).toEqual(['kab'])
    expect(clearScope('Кабовози пішли, чисто')).toEqual(['aircraft'])
  })

  it('a quote-reply to one line of a three-object post is about that object only', async () => {
    const { pipeline, tracker, extract, setNow } = setup((i) =>
      i.message.id === 1
        ? relevant(
            event({
              type: 'jet_drone',
              count: 2,
              action: 'update',
              toward: 'Дніпропетровська область',
              location: 'Вільнянськ',
            }),
            event({
              type: 'jet_drone',
              action: 'update',
              location: 'Великий Луг',
              toward: 'Бородинський',
            }),
            event({
              type: 'jet_drone',
              action: 'update',
              location: 'Новомиколаївка',
              toward: 'Михайло-Лукашеве',
            }),
          )
        : relevant(event({ type: 'jet_drone', action: 'update', location: 'Бородинський' })),
    )
    await pipeline.submit(
      message({
        id: 1,
        text: '2 вийшли на Дніпропетровщину\n1 на Великий Луг від Михайлівки\n1 західніше Новомиколаївки розворот на МЛ',
      }),
    )
    const before = new Map(tracker.active().map((t) => [t.id, t.placeName]))
    expect(before.size).toBe(3)
    setNow(min(4))
    // "Бородок", quoting only the second line.
    await pipeline.submit(
      message({
        id: 2,
        text: 'Бородок',
        replyToId: 1,
        date: min(3),
        quoteText: '1 на Великий Луг від Михайлівки',
      }),
    )
    // The model is told which part is quoted…
    expect(buildUserPrompt(extract.mock.calls[1]![0])).toContain(
      'QUOTES ONLY THIS PART OF THE NEAREST PARENT: «1 на Великий Луг від Михайлівки»',
    )
    // …and only that object moved to Бородинський.
    const moved = tracker.active().filter((t) => t.placeName === 'Бородинський')
    expect(
      moved,
      JSON.stringify(tracker.active().map((t) => [t.placeName, t.target?.name])),
    ).toHaveLength(1)
    expect(before.get(moved[0]!.id)).toBe('Великий Луг')
    expect(
      tracker
        .active()
        .map((t) => t.placeName)
        .sort(),
    ).toEqual(['Бородинський', 'Вільнянськ', 'Новомиколаївка'].sort())
  })

  it('a place named in the other lines does not pull the quote to another object', () => {
    const parent = [
      '2 вийшли на Дніпропетровщину',
      '1 на Великий Луг від Михайлівки',
      '1 західніше Новомиколаївки розворот на МЛ',
    ].join(String.fromCharCode(10))
    const events = [
      event({ toward: 'Дніпропетровська область' }),
      event({ location: 'Михайлівка', toward: 'Великий Луг' }),
      // "МЛ" read as Михайло-Лукашеве shares its stem with "Михайлівки" in the quote.
      event({ location: 'Новомиколаївка', toward: 'Михайло-Лукашеве' }),
    ]
    const json = JSON.stringify({ eventTrackIds: ['ta', 'tb', 'tc'] })
    expect(quotedTracks('1 на Великий Луг від Михайлівки', events, json, parent)).toEqual(['tb'])
    expect(quotedTracks('2 вийшли на Дніпропетровщину', events, json, parent)).toEqual(['ta'])
  })

  it('"вектор Оріхів/Таврійське" keeps the second goal as an alternative', async () => {
    const { pipeline, tracker } = setup(() =>
      relevant(event({ type: 'kab', location: 'Нестерянка', toward: 'Оріхів' })),
    )
    await pipeline.submit(
      message({ id: 1, text: 'КАБ проходять ЛБЗ над Нестерянкою вектор Оріхів/Таврійське' }),
    )
    const [t] = tracker.active()
    expect(t!.target?.name).toBe('Оріхів')
    expect(t!.altTargets?.map((g) => g.name)).toEqual(['Таврійське'])
  })

  it('finds the names a post joins with "/"', () => {
    expect(slashPeers('вектор Оріхів/Таврійське', 'Оріхів')).toEqual(['Таврійське'])
    expect(slashPeers('курс Аеропорт / Матвіївка / Балабине', 'Матвіївку')).toEqual([
      'Аеропорт',
      'Балабине',
    ])
    expect(slashPeers('курс на Оріхів', 'Оріхів')).toEqual([])
    expect(slashPeers('Оріхів/Таврійське', '')).toEqual([])
  })

  it('a quote that names nothing known falls back to the whole parent', () => {
    expect(
      quotedTracks('щось', [event({ location: 'Оріхів' })], '{"eventTrackIds":["t1"]}'),
    ).toBeNull()
    expect(
      quotedTracks('над Оріховом', [event({ location: 'Оріхів' })], '{"eventTrackIds":["t1"]}'),
    ).toEqual(['t1'])
    expect(quotedTracks('Оріхів', [event({ location: 'Оріхів' })], 'not json')).toBeNull()
  })

  it('all-clear clears the board', async () => {
    const { pipeline, tracker } = setup((i) =>
      i.message.id === 1
        ? relevant(event({ location: 'Оріхів' }))
        : { relevant: true, all_clear: true, closures: [], events: [] },
    )
    await pipeline.submit(message({ id: 1, text: 'шахед Оріхів' }))
    await pipeline.submit(message({ id: 2, text: 'Відбій тривоги' }))
    expect(tracker.active()).toHaveLength(0)
  })

  it('processes a channel in order even when extraction times differ', async () => {
    const order: number[] = []
    const { pipeline } = setup(async (i) => {
      await new Promise((r) => setTimeout(r, i.message.id === 1 ? 30 : 1))
      order.push(i.message.id)
      return relevant()
    })
    await Promise.all([
      pipeline.submit(message({ id: 1, text: 'перше' })),
      pipeline.submit(message({ id: 2, text: 'друге' })),
      pipeline.submit(message({ id: 3, text: 'інший канал', channel: 'other' })),
    ])
    expect(order.indexOf(1)).toBeLessThan(order.indexOf(2))
    expect(order[0]).toBe(3)
  })

  it('respects the concurrency limit across channels', async () => {
    let inFlight = 0
    let peak = 0
    const { pipeline } = setup(async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return relevant()
    })
    await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((ch, i) =>
        pipeline.submit(message({ id: i, channel: ch, text: 'шахед' })),
      ),
    )
    expect(peak).toBe(2)
  })

  it('surfaces extractor failures, counts them, and allows a retry', async () => {
    let fail = true
    const { pipeline, extract } = setup(() => {
      if (fail) throw new Error('overloaded')
      return relevant()
    })
    const m = message({ id: 1, text: 'шахед' })
    await expect(pipeline.submit(m)).rejects.toThrow('overloaded')
    expect(pipeline.stats.failed).toBe(1)
    fail = false
    await pipeline.submit(m)
    expect(extract).toHaveBeenCalledTimes(2)
  })

  it('drops geocodes outside the region or far from the linked track', async () => {
    const { pipeline, tracker } = setup((i) =>
      i.message.id === 1
        ? relevant(event({ location: 'Кушугум' }))
        : relevant(event({ action: 'update', location: i.message.text })),
    )
    await pipeline.submit(message({ id: 1, text: 'шахед Кушугум' }))
    const id = tracker.active()[0]!.id
    // Бердянськ is in the oblast but 170 km from the track: a homonym/mistake, not a flight.
    await pipeline.submit(message({ id: 2, text: 'Бердянськ', replyToId: 1, date: min(0.5) }))
    expect(tracker.get(id)!.placeName).toBe('Кушугум')
    // Київ is outside the region altogether.
    await pipeline.submit(message({ id: 3, text: 'Київ', replyToId: 1, date: min(0.6) }))
    expect(tracker.get(id)!.placeName).toBe('Кушугум')
    await pipeline.submit(message({ id: 4, text: 'Балабине', replyToId: 1, date: min(0.7) }))
    expect(tracker.get(id)!.placeName).toBe('Балабине')
  })

  it('parseStored round-trips and rejects junk', () => {
    expect(Pipeline.parseStored(null)).toBeNull()
    expect(Pipeline.parseStored('{"relevant":true,"all_clear":false,"events":[]}')).toEqual({
      relevant: true,
      all_clear: false,
      closures: [],
      events: [],
    })
    expect(Pipeline.parseStored('[]')).toBeNull()
  })

  it('compass words are directions, not villages ("з півночі" ≠ Північне)', async () => {
    const { pipeline, tracker } = setup(() =>
      relevant(
        event({ type: 'jet_drone', from: 'північні напрями', toward: 'Запоріжжя', heading: 'S' }),
      ),
    )
    await pipeline.submit(message({ id: 1, text: 'Реактив з півночі на Запоріжжя' }))
    const [t] = tracker.active()
    expect(t!.origin).toBeNull()
    expect(t!.target?.name).toBe('Запоріжжя')
    expect(isDirectionWord('з південного заходу')).toBe(true)
    expect(isDirectionWord('Північне')).toBe(false)
    expect(isDirectionWord('Південноукраїнськ')).toBe(false)
    expect(isDirectionWord('північне перетиння')).toBe(true)
    expect(isDirectionWord('межа областей')).toBe(true)
    expect(isDirectionWord('ЛБЗ')).toBe(true)
  })

  it('a nationwide relay ("загроза балістики з Брянська") is no threat to Запоріжжя', async () => {
    const run = async (text: string, from: string) => {
      const { pipeline, tracker } = setup(() =>
        relevant(event({ type: 'ballistic', from, toward: 'Запоріжжя' })),
      )
      await pipeline.submit(message({ id: 1, text }))
      return tracker.active().filter((t) => t.type === 'ballistic')
    }
    // ~600 km: beyond Iskander's reach, and the post names no target here.
    expect(await run('Загроза балістики з Брянська', 'Брянськ')).toHaveLength(0)
    // The same launch area, but the post itself names the city: keep it.
    expect(await run('Балістика з Брянська на Запоріжжя!', 'Брянськ')).toHaveLength(1)
    // Within reach: a threat as before.
    expect(await run('Загроза балістики з Криму', 'Крим')).toHaveLength(1)
  })

  it('a new object in reply to far-away aircraft is not measured against them', async () => {
    const { pipeline, tracker } = setup((i) =>
      i.message.id === 1
        ? relevant(event({ type: 'aircraft', location: 'Азовське море' }))
        : relevant(event({ type: 'kab', action: 'new', location: 'Покровське' })),
    )
    await pipeline.submit(
      message({ id: 1, text: 'Активність авіації в акваторії Азовського моря' }),
    )
    // KABs land ~170 km from the carriers the thread is about.
    await pipeline.submit(
      message({ id: 2, text: 'Закидують КАБами Покровське', replyToId: 1, date: min(0.5) }),
    )
    expect(tracker.active().find((t) => t.type === 'kab')?.placeName).toBe('Покровське')
  })

  it('keeps launch areas outside the oblast as the origin', async () => {
    const { pipeline, tracker } = setup(() =>
      relevant(event({ type: 'ballistic', from: 'Крим', toward: 'Запоріжжя' })),
    )
    await pipeline.submit(message({ id: 1, text: 'Балістика з Криму на Запоріжжя' }))
    expect(tracker.active()[0]!.origin?.name).toBe('Крим')
  })

  it('drops a place the model copied from the reply chain into a course-only reply', async () => {
    const { pipeline, tracker } = setup((i) =>
      i.message.id === 1
        ? relevant(event({ type: 'jet_drone', location: 'Вільнянськ', heading: 'S' }))
        : relevant(
            event({
              type: 'jet_drone',
              action: 'update',
              location: 'Вільнянськ',
              toward: 'Матвіївка',
            }),
          ),
    )
    await pipeline.submit(message({ id: 1, text: 'Реактив над Вільнянськом' }))
    await pipeline.submit(
      message({ id: 2, text: 'Довертає до Матвіївки', replyToId: 1, date: min(0.5) }),
    )
    const [t] = tracker.active()
    expect(t!.trail!.map((p) => p.name)).toEqual(['Вільнянськ']) // no second, fake sighting
    expect(t!.target?.name).toBe('Матвіївка')
  })

  it('keeps a repeated place when the reply itself names it', async () => {
    const { pipeline, tracker, setNow } = setup(() =>
      relevant(event({ type: 'jet_drone', action: 'update', location: 'Вільнянськ' })),
    )
    await pipeline.submit(message({ id: 1, text: 'Реактив над Вільнянськом' }))
    setNow(min(4))
    await pipeline.submit(
      message({ id: 2, text: 'Вільнянськ уважно, кружляє', replyToId: 1, date: min(3) }),
    )
    expect(tracker.active()[0]!.sources).toHaveLength(2)
    expect(tracker.active()[0]!.stateAt).toBe(min(3))
  })
})
