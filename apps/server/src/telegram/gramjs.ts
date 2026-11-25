import { Api, TelegramClient } from 'telegram'
import { NewMessage, type NewMessageEvent } from 'telegram/events'
import { EditedMessage } from 'telegram/events/EditedMessage'
import { LogLevel } from 'telegram/extensions/Logger'
import { StringSession } from 'telegram/sessions'
import type { RawMessage } from '../extract/types'
import type { MessageSource } from '../ingest/pipeline'
import type { Logger } from '../logger'
import { type ChannelInfo, channelKey, type GramMessageLike, toRawMessage } from './map'

export interface TelegramOptions {
  apiId: number
  apiHash: string
  session: string
  channels: string[]
  backfillMin: number
  logger: Logger
  /** Safety-net poll interval; updates can be dropped by Telegram under load. */
  pollMs?: number
}

export type TelegramStatus = 'disabled' | 'connecting' | 'connected' | 'error'

/**
 * MTProto user-account ingestion via GramJS. This is a thin adapter: all
 * logic lives in the pipeline, so this file is excluded from unit coverage
 * and exercised by the manual `pnpm tg:dump` smoke test.
 */
export class TelegramIngest implements MessageSource {
  readonly #opts: TelegramOptions
  readonly #client: TelegramClient
  readonly #channels = new Map<string, { entity: Api.Channel; info: ChannelInfo }>()
  readonly #byPeerId = new Map<string, ChannelInfo>()
  #poll: NodeJS.Timeout | null = null
  status: TelegramStatus = 'connecting'

  constructor(opts: TelegramOptions) {
    this.#opts = opts
    this.#client = new TelegramClient(new StringSession(opts.session), opts.apiId, opts.apiHash, {
      connectionRetries: Number.POSITIVE_INFINITY,
      autoReconnect: true,
      retryDelay: 2000,
    })
    this.#client.setLogLevel(LogLevel.ERROR)
  }

  get channels(): ChannelInfo[] {
    return [...this.#channels.values()].map((c) => c.info)
  }

  async start(onMessage: (m: RawMessage) => void): Promise<void> {
    const log = this.#opts.logger
    try {
      await this.#client.connect()
      if (!(await this.#client.checkAuthorization())) {
        throw new Error('TG_SESSION is not authorized — run `pnpm tg:login` again')
      }
      for (const ref of this.#opts.channels) {
        try {
          const entity = await this.#client.getEntity(ref)
          if (!(entity instanceof Api.Channel)) {
            log.warn({ ref }, 'not a channel, skipping')
            continue
          }
          const info = { key: channelKey(entity.username ?? ref), title: entity.title }
          this.#channels.set(info.key, { entity, info })
          this.#byPeerId.set(entity.id.toString(), info)
        } catch (err) {
          log.error({ ref, err }, 'cannot resolve channel')
        }
      }
      log.info({ channels: this.channels.map((c) => c.key) }, 'telegram connected')

      const chats = [...this.#channels.values()].map((c) => c.entity)
      const handler = (event: NewMessageEvent) => {
        const m = event.message
        const peer = m.peerId instanceof Api.PeerChannel ? m.peerId.channelId.toString() : null
        const info = peer ? this.#byPeerId.get(peer) : undefined
        if (info) onMessage(toRawMessage(m as unknown as GramMessageLike, info))
      }
      this.#client.addEventHandler(handler, new NewMessage({ chats }))
      this.#client.addEventHandler(handler, new EditedMessage({ chats }))
      this.status = 'connected'

      await this.#sweep(onMessage, this.#opts.backfillMin * 60_000, 100)
      this.#poll = setInterval(() => {
        this.#sweep(onMessage, 10 * 60_000, 15).catch((err) => log.warn({ err }, 'poll failed'))
      }, this.#opts.pollMs ?? 60_000)
    } catch (err) {
      this.status = 'error'
      throw err
    }
  }

  /** Read recent history of every channel; the pipeline dedupes. */
  async #sweep(onMessage: (m: RawMessage) => void, windowMs: number, limit: number) {
    const since = Date.now() - windowMs
    for (const { entity, info } of this.#channels.values()) {
      const batch: RawMessage[] = []
      for await (const m of this.#client.iterMessages(entity, { limit })) {
        if (m.date * 1000 < since) break
        batch.push(toRawMessage(m as unknown as GramMessageLike, info))
      }
      // Oldest first so replies see their parents.
      for (const m of batch.reverse()) onMessage(m)
    }
  }

  async getMessage(channel: string, id: number): Promise<RawMessage | null> {
    const c = this.#channels.get(channel)
    if (!c) return null
    const [m] = await this.#client.getMessages(c.entity, { ids: [id] })
    return m ? toRawMessage(m as unknown as GramMessageLike, c.info) : null
  }

  async stop(): Promise<void> {
    if (this.#poll) clearInterval(this.#poll)
    await this.#client.disconnect()
    await this.#client.destroy()
  }
}
