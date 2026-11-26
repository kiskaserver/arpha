/**
 * LLM spend accounting and a daily safety cap. Every post the pipeline sends to
 * the model is metered here; the totals are visible in /api/health and the logs,
 * and once the day's budget is spent the extractor stops calling the model until
 * midnight (Kyiv), so a spamming channel or a bug can never run up a large bill.
 */

/** USD per million tokens. */
interface Price {
  input: number
  output: number
  cacheRead: number
  /** 1-hour cache writes cost 2× input. */
  cacheWrite: number
}

const PRICES: [RegExp, Price][] = [
  [/haiku-4/, { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 2 }],
  [/sonnet/, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 6 }],
  [/opus/, { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 }],
]
/** Unknown models are priced like Sonnet: overestimating is the safe side of a cap. */
const FALLBACK = PRICES[1]![1]

export function priceOf(model: string): Price {
  return PRICES.find(([re]) => re.test(model))?.[1] ?? FALLBACK
}

export interface TokenUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

export interface DayUsage {
  day: string
  calls: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  usd: number
}

export interface UsageStore {
  getJson<T>(key: string): T | null
  setJson(key: string, value: unknown): void
}

const KEY = 'llmUsage'
const kyivDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' })

export class UsageMeter {
  readonly #price: Price
  readonly #budgetUsd: number
  readonly #store: UsageStore | undefined
  readonly #now: () => number
  #today: DayUsage

  constructor(opts: {
    model: string
    budgetUsd: number
    store?: UsageStore
    now?: () => number
  }) {
    this.#price = priceOf(opts.model)
    this.#budgetUsd = opts.budgetUsd
    this.#store = opts.store
    this.#now = opts.now ?? Date.now
    const saved = this.#store?.getJson<DayUsage>(KEY)
    this.#today = saved?.day === this.#day() ? saved : this.#empty()
  }

  get budgetUsd(): number {
    return this.#budgetUsd
  }

  /** Today's totals (rolls over at Kyiv midnight). */
  get today(): DayUsage {
    this.#rollover()
    return { ...this.#today, usd: Math.round(this.#today.usd * 10_000) / 10_000 }
  }

  /** True once today's spend reached the budget (0 = no cap). */
  get exhausted(): boolean {
    this.#rollover()
    return this.#budgetUsd > 0 && this.#today.usd >= this.#budgetUsd
  }

  record(u: TokenUsage): void {
    this.#rollover()
    const t = this.#today
    const cacheRead = u.cache_read_input_tokens ?? 0
    const cacheWrite = u.cache_creation_input_tokens ?? 0
    t.calls++
    t.input += u.input_tokens
    t.output += u.output_tokens
    t.cacheRead += cacheRead
    t.cacheWrite += cacheWrite
    const p = this.#price
    t.usd +=
      (u.input_tokens * p.input +
        u.output_tokens * p.output +
        cacheRead * p.cacheRead +
        cacheWrite * p.cacheWrite) /
      1_000_000
    // Survive restarts without writing on every call.
    if (t.calls % 10 === 0 || this.exhausted) this.#store?.setJson(KEY, t)
  }

  #day(): string {
    return kyivDay.format(new Date(this.#now()))
  }

  #empty(): DayUsage {
    return { day: this.#day(), calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0 }
  }

  #rollover(): void {
    if (this.#today.day !== this.#day()) this.#today = this.#empty()
  }
}
