import type { StreamEvent } from '@arpha/shared'
import { isStreamEvent } from './state'

export type ConnectionStatus = 'connecting' | 'online' | 'offline'

export interface StreamOptions {
  url?: string
  onEvent(ev: StreamEvent): void
  onStatus(status: ConnectionStatus): void
  /** Injected for tests. */
  EventSourceImpl?: typeof EventSource
  /** Treat the link as dead if nothing arrives for this long (server pings every 25 s). */
  staleMs?: number
}

/**
 * SSE subscription with liveness tracking. EventSource reconnects by itself;
 * we additionally force a fresh connection when the stream goes silent (mobile
 * networks often leave half-open sockets) and when the page becomes visible again.
 */
export class LiveStream {
  readonly #o: StreamOptions
  #es: EventSource | null = null
  #watchdog: ReturnType<typeof setInterval> | null = null
  #lastActivity = 0
  #status: ConnectionStatus = 'connecting'

  constructor(opts: StreamOptions) {
    this.#o = opts
  }

  get status(): ConnectionStatus {
    return this.#status
  }

  start(): void {
    this.#connect()
    const stale = this.#o.staleMs ?? 70_000
    this.#watchdog = setInterval(
      () => {
        if (Date.now() - this.#lastActivity > stale) this.reconnect()
      },
      Math.min(stale, 10_000),
    )
  }

  reconnect(): void {
    this.#es?.close()
    this.#connect()
  }

  stop(): void {
    this.#es?.close()
    this.#es = null
    if (this.#watchdog) clearInterval(this.#watchdog)
  }

  #connect(): void {
    const Impl = this.#o.EventSourceImpl ?? EventSource
    this.#lastActivity = Date.now()
    this.#setStatus('connecting')
    const es = new Impl(this.#o.url ?? '/api/stream')
    this.#es = es
    es.onopen = () => {
      this.#lastActivity = Date.now()
      this.#setStatus('online')
    }
    es.onmessage = (msg: MessageEvent<string>) => {
      this.#lastActivity = Date.now()
      this.#setStatus('online')
      let parsed: unknown
      try {
        parsed = JSON.parse(msg.data)
      } catch {
        return
      }
      if (isStreamEvent(parsed)) this.#o.onEvent(parsed)
    }
    es.onerror = () => {
      // CONNECTING means the browser is retrying; CLOSED means it gave up.
      if (es.readyState === 2) {
        this.#setStatus('offline')
        setTimeout(() => {
          if (this.#es === es) this.reconnect()
        }, 5_000)
      } else {
        this.#setStatus('offline')
      }
    }
  }

  #setStatus(s: ConnectionStatus): void {
    if (s === this.#status) return
    this.#status = s
    this.#o.onStatus(s)
  }
}
