import type Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it, vi } from 'vitest'
import { Store } from '../src/db'
import { AnthropicExtractor, type MessagesClient } from '../src/extract/anthropic'
import { TOOL_NAME } from '../src/extract/prompt'
import { EMPTY_EXTRACTION } from '../src/extract/types'
import { priceOf, UsageMeter } from '../src/extract/usage'
import { silentLogger } from '../src/logger'
import { message, min } from './helpers'

/** 2026-11-26 12:00 Kyiv. */
const NOON = Date.UTC(2026, 10, 26, 10)

describe('UsageMeter', () => {
  it('prices Haiku calls including the prompt cache', () => {
    const meter = new UsageMeter({ model: 'claude-haiku-4-5', budgetUsd: 3, now: () => NOON })
    // A real call: 558 fresh input, 4800 cached, 134 output tokens.
    meter.record({ input_tokens: 558, cache_read_input_tokens: 4800, output_tokens: 134 })
    expect(meter.today.usd).toBeCloseTo(0.0017, 4)
    // A first call writes the cache (1 h TTL: 2× input price).
    meter.record({ input_tokens: 558, cache_creation_input_tokens: 4800, output_tokens: 134 })
    expect(meter.today).toMatchObject({
      day: '2026-11-26',
      calls: 2,
      cacheRead: 4800,
      cacheWrite: 4800,
    })
    expect(meter.today.usd).toBeCloseTo(0.0017 + 0.0108, 4)
  })

  it('prices unknown models conservatively', () => {
    expect(priceOf('claude-sonnet-5').input).toBe(3)
    expect(priceOf('some-future-model')).toEqual(priceOf('claude-sonnet-5'))
  })

  it('stops at the daily budget and resets at Kyiv midnight', () => {
    let now = NOON
    const meter = new UsageMeter({ model: 'claude-haiku-4-5', budgetUsd: 0.01, now: () => now })
    // $0.002 per call: four calls stay under $0.01, the fifth reaches it.
    for (let i = 0; i < 4; i++) meter.record({ input_tokens: 2000, output_tokens: 0 })
    expect(meter.exhausted).toBe(false)
    meter.record({ input_tokens: 2000, output_tokens: 0 })
    expect(meter.exhausted).toBe(true)
    now = Date.UTC(2026, 10, 26, 22, 1) // 00:01 Kyiv, Nov 27
    expect(meter.exhausted).toBe(false)
    expect(meter.today).toMatchObject({ day: '2026-11-27', calls: 0, usd: 0 })
  })

  it('a zero budget means no cap', () => {
    const meter = new UsageMeter({ model: 'claude-haiku-4-5', budgetUsd: 0, now: () => NOON })
    meter.record({ input_tokens: 10_000_000, output_tokens: 0 })
    expect(meter.exhausted).toBe(false)
  })

  it('keeps the day total across restarts', () => {
    const store = new Store(':memory:')
    const make = () =>
      new UsageMeter({ model: 'claude-haiku-4-5', budgetUsd: 3, store, now: () => NOON })
    const first = make()
    for (let i = 0; i < 10; i++) first.record({ input_tokens: 1000, output_tokens: 0 })
    expect(make().today).toMatchObject({ calls: 10, input: 10_000 })
    // A saved total from another day is not carried over.
    store.setJson('llmUsage', { ...make().today, day: '2026-11-25' })
    expect(make().today.calls).toBe(0)
  })
})

describe('AnthropicExtractor budget', () => {
  it('meters every call and stops calling the model once the budget is spent', async () => {
    const create = vi.fn(
      async () =>
        ({
          content: [
            {
              type: 'tool_use',
              id: 'tu',
              name: TOOL_NAME,
              input: { relevant: true, all_clear: false, events: [] },
            },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 5000, output_tokens: 1000 },
        }) as unknown as Anthropic.Message,
    )
    const client: MessagesClient = { messages: { create } }
    const warn = vi.fn()
    const logger = { ...silentLogger, warn } as unknown as typeof silentLogger
    const meter = new UsageMeter({ model: 'claude-haiku-4-5', budgetUsd: 0.02, now: () => NOON })
    const extractor = new AnthropicExtractor({ client, model: 'claude-haiku-4-5', logger, meter })
    const input = {
      message: message({ text: 'шахед' }),
      parents: [],
      activeTracks: [],
      now: min(1),
    }

    await extractor.extract(input) // $0.01
    await extractor.extract(input) // $0.02 → budget reached
    expect(await extractor.extract(input)).toEqual(EMPTY_EXTRACTION)
    expect(await extractor.extract(input)).toEqual(EMPTY_EXTRACTION)
    expect(create).toHaveBeenCalledTimes(2)
    expect(meter.today.calls).toBe(2)
    expect(warn).toHaveBeenCalledTimes(1) // once per day, not per post
  })
})
