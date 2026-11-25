import { describe, expect, it, vi } from 'vitest'
import { Store } from '../src/db'
import type { Extraction, ExtractionInput, Extractor, RawMessage } from '../src/extract/types'
import { Tracker } from '../src/fusion/tracker'
import { Pipeline } from '../src/ingest/pipeline'
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
    await pipeline.submit({ ...m, editDate: min(0.5) })
    expect(tracker.active()).toHaveLength(1)
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
      { text: 'шахед Оріхів', date: min(0), trackIds: [id] },
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

  it('all-clear clears the board', async () => {
    const { pipeline, tracker } = setup((i) =>
      i.message.id === 1
        ? relevant(event({ location: 'Оріхів' }))
        : { relevant: true, all_clear: true, events: [] },
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
      events: [],
    })
    expect(Pipeline.parseStored('[]')).toBeNull()
  })
})
