import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { AlertsState, FeedItem, Track } from '@arpha/shared'
import { Boundaries } from './alerts/boundaries'
import { AlertsService } from './alerts/service'
import { EventBus } from './bus'
import type { Config } from './config'
import { Store } from './db'
import { DemoSimulator } from './demo/simulator'
import { AnthropicExtractor } from './extract/anthropic'
import type { Extractor, RawMessage } from './extract/types'
import { Tracker, type TrackState } from './fusion/tracker'
import { Gazetteer, type PlaceRecord } from './geo/gazetteer'
import { createApp } from './http/app'
import { FeedBuffer, InfraService } from './infra/service'
import { type MessageSource, Pipeline } from './ingest/pipeline'
import type { Logger } from './logger'
import { Predictor } from './predict/predictor'
import { type PushSender, PushService } from './push/service'

/** Live message feed (Telegram in production, fakes in tests). */
export interface Ingest extends MessageSource {
  status: string
  start(onMessage: (m: RawMessage) => void): Promise<void>
  stop(): Promise<void>
}

export interface RuntimeOverrides {
  extractor?: Extractor
  ingest?: Ingest
  pushSender?: PushSender
  fetch?: typeof fetch
  now?: () => number
}

const DAY_MS = 86_400_000

/** Find a data file in the repo layout (dev) or next to the bundle (Docker). */
export function findDataFile(name: string, candidates: string[]): string | null {
  for (const dir of candidates) {
    const p = resolve(dir, name)
    if (existsSync(p)) return p
  }
  return null
}

export function buildRuntime(config: Config, logger: Logger, o: RuntimeOverrides = {}) {
  const now = o.now ?? Date.now
  const store = new Store(
    config.NODE_ENV === 'test' ? ':memory:' : join(config.DATA_DIR, 'arpha.sqlite'),
  )
  const bus = new EventBus()
  const roots = [
    process.cwd(),
    resolve(process.cwd(), '../..'),
    resolve(import.meta.dirname, '../../..'),
  ]

  const gazetteerPath = findDataFile('data/gazetteer.json', roots)
  if (!gazetteerPath) throw new Error('data/gazetteer.json not found — run `pnpm data:gazetteer`')
  const places = JSON.parse(readFileSync(gazetteerPath, 'utf8')) as PlaceRecord[]
  const gazetteer = new Gazetteer(places)
  const predictor = new Predictor(places)
  const refreshPrior = () => {
    const rows = store.hotspots(now() - 30 * DAY_MS, 2000)
    predictor.setPrior(new Map(rows.map((r) => [r.name, r.count])))
  }

  const boundariesPath =
    findDataFile('boundaries.geojson', [config.WEB_DIST]) ??
    findDataFile('apps/web/public/boundaries.geojson', roots)
  const boundaries = boundariesPath ? Boundaries.load(boundariesPath) : Boundaries.empty()

  let push: PushService | undefined
  const pushSender = o.pushSender
  if (pushSender || config.pushEnabled) {
    push = new PushService({
      store,
      boundaries,
      logger,
      now,
      send: pushSender ?? lazyWebPush(config),
    })
  }

  const tracker = new Tracker(
    {
      predict: (track, at) => predictor.predict(track, Math.max(at, now())),
      onChange: (track, state) => {
        store.saveTrack(track.id, state, track.updatedAt)
        bus.publish({ type: 'track', track })
        void push?.onTrack(track)
      },
      onRemove: (id) => {
        store.deleteTrack(id)
        bus.publish({ type: 'track_removed', id })
      },
    },
    config.DEMO_MODE ? [] : store.loadTracks<TrackState>(),
  )

  const alerts = new AlertsService({
    token: config.ALERTS_IN_UA_TOKEN,
    pollMs: config.ALERTS_POLL_MS,
    logger,
    now,
    match: (a) => boundaries.match(a),
    ...(o.fetch ? { fetch: o.fetch } : {}),
    onChange: (state, diff) => {
      bus.publish({ type: 'alerts', alerts: state })
      void push?.onAlerts(diff)
    },
  })

  const extractor =
    o.extractor ??
    (config.ANTHROPIC_API_KEY
      ? new AnthropicExtractor({
          apiKey: config.ANTHROPIC_API_KEY,
          model: config.ANTHROPIC_MODEL,
          logger,
        })
      : null)

  const infra = new InfraService(store, gazetteer, (items) =>
    bus.publish({ type: 'infra', infra: items }),
  )
  const feed = new FeedBuffer(80, store)

  const ingest = o.ingest ?? null
  const pipeline =
    ingest && extractor
      ? new Pipeline({
          store,
          extractor,
          gazetteer,
          tracker,
          source: ingest,
          logger,
          concurrency: config.EXTRACT_CONCURRENCY,
          now,
          onProcessed: ({ message, extraction, resolved, trackIds }) => {
            if (extraction.closures.length) infra.apply(extraction.closures, message)
            for (const ev of resolved) {
              const place = ev.locationPlace
              if (place) {
                store.addObservation({
                  at: message.date,
                  place: place.name,
                  lat: place.lat,
                  lon: place.lon,
                  type: ev.type,
                })
              }
            }
            const item: FeedItem = {
              key: `${message.channel}:${message.id}`,
              channel: message.channel,
              channelTitle: message.channelTitle,
              messageId: message.id,
              text: message.text.length > 400 ? `${message.text.slice(0, 397)}…` : message.text,
              at: message.date,
              types: [...new Set(extraction.events.map((e) => e.type))],
              trackIds,
            }
            feed.add(item)
            bus.publish({ type: 'feed', item })
          },
        })
      : null

  const demo = config.DEMO_MODE ? new DemoSimulator(tracker, gazetteer, now()) : null

  const app = createApp({
    tracks: (): Track[] => tracker.tracks(),
    alerts: (): AlertsState => alerts.state,
    infra: () => infra.list(),
    feed: () => feed.list(),
    hotspots: (days) => store.hotspots(now() - days * DAY_MS, 150),
    bus,
    logger,
    demo: config.DEMO_MODE,
    webDist: config.WEB_DIST,
    push:
      push && config.VAPID_PUBLIC_KEY
        ? { service: push, publicKey: config.VAPID_PUBLIC_KEY }
        : undefined,
    now,
    health: () => ({
      telegram: ingest?.status ?? 'disabled',
      alerts: alerts.enabled ? (alerts.state.stale ? 'stale' : 'ok') : 'disabled',
      tracks: tracker.active().length,
      pipeline: pipeline?.stats ?? null,
      pushSubscribers: push?.size ?? 0,
      gazetteer: gazetteer.size,
      boundaries: boundaries.features.length,
    }),
  })

  const timers: NodeJS.Timeout[] = []

  return {
    app,
    store,
    tracker,
    alerts,
    pipeline,
    gazetteer,
    boundaries,
    bus,
    infra,
    feed,
    predictor,
    async start() {
      refreshPrior()
      timers.push(setInterval(refreshPrior, 10 * 60_000))
      timers.push(setInterval(() => tracker.tick(now()), 5_000))
      timers.push(setInterval(() => infra.tick(now()), 60_000))
      timers.push(setInterval(() => store.pruneObservations(now() - 60 * DAY_MS), 6 * 3_600_000))
      timers.push(setInterval(() => store.pruneMessages(now() - 24 * 3_600_000), 3_600_000))
      if (demo) {
        alerts.set(demo.alerts(boundaries, now()))
        demo.advance(now())
        timers.push(setInterval(() => demo.advance(now()), 1_000))
      } else {
        alerts.start()
      }
      if (ingest && pipeline) {
        await ingest.start((m) => {
          pipeline.submit(m).catch(() => {
            /* logged by the pipeline */
          })
        })
      }
    },
    async stop() {
      for (const t of timers) clearInterval(t)
      alerts.stop()
      await ingest?.stop()
      store.close()
    },
  }
}

export type Runtime = ReturnType<typeof buildRuntime>

/** Load web-push (and its crypto) only once a notification is actually sent. */
function lazyWebPush(config: Config): PushSender {
  let sender: Promise<PushSender> | null = null
  return async (sub, payload) => {
    sender ??= import('./push/webpush').then(({ createWebPushSender }) =>
      createWebPushSender({
        publicKey: config.VAPID_PUBLIC_KEY!,
        privateKey: config.VAPID_PRIVATE_KEY!,
        subject: config.VAPID_SUBJECT,
      }),
    )
    return (await sender)(sub, payload)
  }
}
