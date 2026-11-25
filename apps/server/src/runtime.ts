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
import { buildTransitions, summarizePatterns } from './predict/patterns'
import { Predictor } from './predict/predictor'
import { type PushSender, PushService } from './push/service'

/** Live message feed (Telegram in production, fakes in tests). */
export interface Ingest extends MessageSource {
  status: string
  start(onMessage: (m: RawMessage) => void): Promise<void>
  stop(): Promise<void>
  /** Past posts, oldest first (for the one-time history import). */
  history?(windowMs: number, limitPerChannel?: number): Promise<RawMessage[]>
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
    predictor.setTransitions(buildTransitions(store.routes(now() - 90 * DAY_MS)))
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

  const saveRoute = (id: string, state: TrackState) => {
    // Remember where it flew: routes feed the pattern model and the predictor.
    if (state.track.type === 'explosion' || !state.path.length) return
    store.saveRoute({
      id,
      type: state.track.type,
      model: state.track.model,
      startedAt: state.path[0]!.at,
      endedAt: state.track.updatedAt,
      outcome: state.track.status === 'active' ? 'expired' : state.track.status,
      path: state.path,
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
      onRemove: (id, state) => {
        store.deleteTrack(id)
        saveRoute(id, state)
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
    patterns: (days) => summarizePatterns(store.routes(now() - days * DAY_MS), days),
    bus,
    logger,
    demo: config.DEMO_MODE,
    webDist: config.WEB_DIST,
    allowedOrigins: config.PUBLIC_ORIGINS,
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

  /**
   * Replays past posts through an isolated tracker (no push, no live map) so the
   * pattern model starts with history instead of from zero. Runs once per volume.
   *
   * Extractions are cached in their own database (never pruned), so a restart in
   * the middle resumes without paying for the model twice, and routes are written
   * in one transaction at the end, so an interrupted run leaves nothing half-done.
   */
  async function importHistory(opts: { hours?: number; posts?: number }): Promise<number> {
    const hours = opts.hours ?? 0
    const posts = opts.posts ?? 0
    if (!ingest?.history || !extractor || !(hours || posts) || store.getJson('historyImported')) {
      return 0
    }
    const windowMs = hours ? hours * 3_600_000 : Number.POSITIVE_INFINITY
    const fetched = await ingest.history(windowMs, posts || undefined)
    // Posts the live pipeline already handled are in the live store and its tracks.
    const messages = fetched.filter((m) => !store.getMessage(m.channel, m.id)?.extraction)
    const cache = new Store(
      config.NODE_ENV === 'test' ? ':memory:' : join(config.DATA_DIR, 'history.sqlite'),
    )
    const routes: [string, TrackState][] = []
    const observations: Parameters<Store['addObservation']>[0][] = []
    let clock = messages[0]?.date ?? now()
    const replay = new Tracker({ onRemove: (id, state) => routes.push([id, state]) })
    const importer = new Pipeline({
      store: cache,
      extractor,
      gazetteer,
      tracker: replay,
      source: ingest,
      logger,
      concurrency: 1,
      now: () => clock,
      maxAgeMs: Number.POSITIVE_INFINITY,
      reuseStored: true,
      onProcessed: ({ message, resolved }) => {
        for (const ev of resolved) {
          const place = ev.locationPlace
          if (place) {
            observations.push({
              at: message.date,
              place: place.name,
              lat: place.lat,
              lon: place.lon,
              type: ev.type,
            })
          }
        }
      },
    })
    logger.info(
      { messages: messages.length, hours, posts, from: messages[0]?.date },
      'history import started',
    )
    try {
      let done = 0
      for (const m of messages) {
        clock = m.date + 20_000
        replay.tick(clock)
        await importer.submit(m).catch(() => {})
        if (++done % 250 === 0) {
          logger.info({ done, of: messages.length, ...importer.stats }, 'history import progress')
        }
      }
      replay.tick(clock + 24 * 3_600_000) // flush: every track ends and leaves its route
      replay.tick(clock + 48 * 3_600_000)
      store.batch(() => {
        for (const o of observations) store.addObservation(o)
        for (const [id, state] of routes) saveRoute(id, state)
        store.setJson('historyImported', {
          at: now(),
          hours,
          posts,
          messages: messages.length,
          routes: routes.length,
        })
      })
    } finally {
      cache.close()
    }
    refreshPrior()
    logger.info(
      { messages: messages.length, routes: routes.length, ...importer.stats },
      'history imported',
    )
    return messages.length
  }

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
    importHistory,
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
        void importHistory({
          hours: config.HISTORY_IMPORT_HOURS,
          posts: config.HISTORY_IMPORT_POSTS,
        }).catch((err) => logger.warn({ err }, 'history import failed'))
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
