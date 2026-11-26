import Anthropic from '@anthropic-ai/sdk'
import type { Logger } from '../logger'
import { buildUserPrompt, REPORT_TOOL, SYSTEM_PROMPT, TOOL_NAME } from './prompt'
import {
  EMPTY_EXTRACTION,
  type Extraction,
  type ExtractionInput,
  type Extractor,
  extractionSchema,
} from './types'
import type { UsageMeter } from './usage'

/** The subset of the SDK we use — lets tests inject a fake. */
export interface MessagesClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>
  }
}

export interface AnthropicExtractorOptions {
  client?: MessagesClient
  apiKey?: string
  model: string
  logger: Logger
  /** Meters spend and enforces the daily cap; absent in tooling (eval). */
  meter?: UsageMeter
}

export class AnthropicExtractor implements Extractor {
  readonly #client: MessagesClient
  readonly #model: string
  readonly #log: Logger
  readonly #meter: UsageMeter | undefined
  #pausedDay: string | null = null

  constructor(opts: AnthropicExtractorOptions) {
    this.#client =
      opts.client ?? new Anthropic({ apiKey: opts.apiKey, maxRetries: 3, timeout: 30_000 })
    this.#model = opts.model
    this.#log = opts.logger
    this.#meter = opts.meter
  }

  async extract(input: ExtractionInput): Promise<Extraction> {
    const meter = this.#meter
    if (meter?.exhausted) {
      const { day, usd, calls } = meter.today
      if (this.#pausedDay !== day) {
        this.#pausedDay = day
        this.#log.warn(
          { usd, calls, budgetUsd: meter.budgetUsd },
          'LLM daily budget reached — parsing paused until midnight (Kyiv)',
        )
      }
      return EMPTY_EXTRACTION
    }
    const started = Date.now()
    const res = await this.#client.messages.create({
      model: this.#model,
      max_tokens: 1024,
      // Tools + system ≈ 5k tokens, above Haiku's 4096-token cache minimum. A 1 h TTL
      // survives quiet nights; a cached read costs a tenth of a fresh input token.
      system: [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } },
      ],
      tools: [REPORT_TOOL as Anthropic.Tool],
      tool_choice: { type: 'tool', name: TOOL_NAME },
      messages: [{ role: 'user', content: buildUserPrompt(input) }],
    })
    meter?.record(res.usage)

    const block = res.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === TOOL_NAME,
    )
    if (!block) {
      this.#log.warn({ stop: res.stop_reason }, 'extractor returned no tool call')
      return EMPTY_EXTRACTION
    }
    const parsed = extractionSchema.safeParse(block.input)
    if (!parsed.success) {
      this.#log.warn({ issues: parsed.error.issues }, 'extractor output failed validation')
      return EMPTY_EXTRACTION
    }
    this.#log.debug(
      {
        ms: Date.now() - started,
        in: res.usage.input_tokens,
        cached: res.usage.cache_read_input_tokens,
        out: res.usage.output_tokens,
        events: parsed.data.events.length,
      },
      'extracted',
    )
    return parsed.data
  }
}
