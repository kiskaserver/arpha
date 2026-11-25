import { EventEmitter } from 'node:events'
import type { StreamEvent } from '@arpha/shared'

/** In-process fan-out of state changes to SSE clients and push. */
export class EventBus {
  readonly #emitter = new EventEmitter()

  constructor() {
    this.#emitter.setMaxListeners(0)
  }

  publish(event: StreamEvent): void {
    this.#emitter.emit('event', event)
  }

  subscribe(listener: (event: StreamEvent) => void): () => void {
    this.#emitter.on('event', listener)
    return () => this.#emitter.off('event', listener)
  }

  get listenerCount(): number {
    return this.#emitter.listenerCount('event')
  }
}
