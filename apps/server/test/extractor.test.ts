import type Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it, vi } from 'vitest'
import { AnthropicExtractor, type MessagesClient } from '../src/extract/anthropic'
import { buildUserPrompt, REPORT_TOOL, SYSTEM_PROMPT, TOOL_NAME } from '../src/extract/prompt'
import { EMPTY_EXTRACTION, type ExtractionInput, extractionSchema } from '../src/extract/types'
import { silentLogger } from '../src/logger'
import { message, min } from './helpers'

function fakeClient(content: Anthropic.ContentBlock[]): MessagesClient & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    calls,
    messages: {
      create: vi.fn(async (params) => {
        calls.push(params)
        return {
          id: 'msg',
          type: 'message',
          role: 'assistant',
          model: 'claude-haiku-4-5',
          content,
          stop_reason: 'tool_use',
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80 },
        } as unknown as Anthropic.Message
      }),
    },
  }
}

const input: ExtractionInput = {
  message: message({ text: '3 шахеди повз Василівку на Запоріжжя', date: min(0) }),
  parents: [{ text: 'Шахеди на півдні області', date: min(-5), trackIds: ['t1'] }],
  activeTracks: [
    {
      id: 't1',
      type: 'shahed',
      count: 3,
      placeName: 'Михайлівка',
      headingDeg: 0,
      targetName: 'Запоріжжя',
      minutesAgo: 5,
    },
  ],
  now: min(1),
}

const toolUse = (inputJson: unknown): Anthropic.ContentBlock =>
  ({ type: 'tool_use', id: 'tu', name: TOOL_NAME, input: inputJson }) as Anthropic.ContentBlock

describe('AnthropicExtractor', () => {
  it('forces the tool, caches the system prompt and parses the result', async () => {
    const client = fakeClient([
      toolUse({
        relevant: true,
        all_clear: false,
        events: [
          {
            type: 'shahed',
            count: 3,
            action: 'update',
            location: 'Василівка',
            precision: 'near',
            toward: 'Запоріжжя',
            heading: null,
            track_id: 't1',
            confidence: 0.9,
          },
        ],
      }),
    ])
    const ex = new AnthropicExtractor({ client, model: 'claude-haiku-4-5', logger: silentLogger })
    const out = await ex.extract(input)
    expect(out.events[0]).toMatchObject({ location: 'Василівка', track_id: 't1', from: null })
    const params = client.calls[0] as Anthropic.MessageCreateParamsNonStreaming
    expect(params.tool_choice).toEqual({ type: 'tool', name: TOOL_NAME })
    expect((params.system as Anthropic.TextBlockParam[])[0]!.cache_control).toEqual({
      type: 'ephemeral',
    })
  })

  it('returns an empty extraction when the model does not call the tool', async () => {
    const client = fakeClient([
      { type: 'text', text: 'hi', citations: null } as Anthropic.ContentBlock,
    ])
    const ex = new AnthropicExtractor({ client, model: 'm', logger: silentLogger })
    expect(await ex.extract(input)).toEqual(EMPTY_EXTRACTION)
  })

  it('returns an empty extraction on schema failure', async () => {
    const client = fakeClient([toolUse('not an object')])
    const ex = new AnthropicExtractor({ client, model: 'm', logger: silentLogger })
    expect(await ex.extract(input)).toEqual(EMPTY_EXTRACTION)
  })

  it('constructs a real SDK client when none is injected', () => {
    expect(
      () => new AnthropicExtractor({ apiKey: 'sk-test', model: 'm', logger: silentLogger }),
    ).not.toThrow()
  })
})

describe('extractionSchema', () => {
  it('degrades hallucinated vocabulary to safe defaults and drops junk events', () => {
    const out = extractionSchema.parse({
      relevant: true,
      all_clear: 'yes',
      events: [
        {
          type: 'ufo',
          action: 'teleport',
          count: '4',
          heading: 'NNE',
          confidence: 7,
          location: '  ',
        },
        'garbage',
      ],
    })
    expect(out.all_clear).toBe(false)
    expect(out.events).toHaveLength(2 - 1)
    expect(out.events[0]).toMatchObject({
      type: 'unknown',
      action: 'update',
      count: 4,
      heading: null,
      confidence: 0.5,
      location: null,
    })
  })

  it('treats a non-array events field as empty', () => {
    expect(
      extractionSchema.parse({ relevant: true, all_clear: false, events: 'x' }).events,
    ).toEqual([])
  })
})

describe('prompt', () => {
  it('includes active tracks, reply chain and the message', () => {
    const p = buildUserPrompt(input)
    expect(p).toContain('id=t1')
    expect(p).toContain('курс пн')
    expect(p).toContain('на Запоріжжя')
    expect(p).toContain('[tracks: t1]')
    expect(p).toContain('Шахеди на півдні області')
    expect(p.trim().endsWith(input.message.text)).toBe(true)
  })

  it('says when there are no tracks and no parents', () => {
    const p = buildUserPrompt({ ...input, parents: [], activeTracks: [] })
    expect(p).toContain('ACTIVE TRACKS: none')
    expect(p).not.toContain('REPLIES TO')
  })

  it('tool schema enumerates every threat type and the system prompt covers slang', () => {
    const items = REPORT_TOOL.input_schema.properties.events.items
    expect(items.properties.type.enum).toContain('kab')
    expect(SYSTEM_PROMPT).toMatch(/мопед/)
    expect(SYSTEM_PROMPT).toMatch(/мінус/)
  })
})
