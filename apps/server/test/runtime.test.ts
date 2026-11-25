import { haversineKm, predictPosition, ZAPORIZHZHIA } from '@arpha/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config'
import { DEMO_LOOP_SECONDS, DEMO_SCENARIO, DemoSimulator } from '../src/demo/simulator'
import type { Extractor, RawMessage } from '../src/extract/types'
import { Tracker } from '../src/fusion/tracker'
import { silentLogger } from '../src/logger'
import { buildRuntime, findDataFile, type Ingest } from '../src/runtime'
import { channelKey, toRawMessage } from '../src/telegram/map'
import { event, gazetteer, message, min, T0 } from './helpers'

// biome-ignore lint/suspicious/noExplicitAny: loosely-typed JSON in assertions
const json = async (res: Response | Promise<Response>): Promise<any> => (await res).json()

describe('config', () => {
  it('applies defaults and parses channels in any form', () => {
    const c = loadConfig({
      TG_CHANNELS: '@one, https://t.me/two\nthree',
      DEMO_MODE: 'true',
    } as NodeJS.ProcessEnv)
    expect(c.TG_CHANNELS).toEqual(['one', 'two', 'three'])
    expect(c.DEMO_MODE).toBe(true)
    expect(c.PORT).toBe(8080)
    expect(c.telegramEnabled).toBe(false)
    expect(c.pushEnabled).toBe(false)
  })

  it('enables telegram only with full credentials and requires the LLM key', () => {
    const env = { TG_API_ID: '123', TG_API_HASH: 'h', TG_SESSION: 's', TG_CHANNELS: 'a' }
    expect(() => loadConfig(env as NodeJS.ProcessEnv)).toThrow(/ANTHROPIC_API_KEY/)
    const c = loadConfig({
      ...env,
      ANTHROPIC_API_KEY: 'k',
      VAPID_PUBLIC_KEY: 'p',
      VAPID_PRIVATE_KEY: 'q',
    } as NodeJS.ProcessEnv)
    expect(c.telegramEnabled).toBe(true)
    expect(c.pushEnabled).toBe(true)
  })

  it('reports invalid values clearly', () => {
    expect(() => loadConfig({ PORT: 'abc' } as NodeJS.ProcessEnv)).toThrow(/PORT/)
  })
})

describe('telegram mapping', () => {
  it('maps GramJS messages to RawMessage', () => {
    expect(
      toRawMessage(
        {
          id: 5,
          date: 1_700_000_000,
          editDate: 1_700_000_060,
          message: 'текст',
          replyTo: { replyToMsgId: 4 },
        },
        { key: 'chan', title: 'Канал' },
      ),
    ).toEqual({
      channel: 'chan',
      channelTitle: 'Канал',
      id: 5,
      date: 1_700_000_000_000,
      editDate: 1_700_000_060_000,
      text: 'текст',
      replyToId: 4,
    })
    expect(toRawMessage({ id: 1, date: 1 }, { key: 'c', title: 't' })).toMatchObject({
      text: '',
      editDate: null,
      replyToId: null,
    })
  })

  it('normalizes channel references', () => {
    expect(channelKey('https://t.me/Some_Channel/')).toBe('some_channel')
    expect(channelKey(' @Foo ')).toBe('foo')
  })
})

describe('DemoSimulator', () => {
  it('plays the scenario on real places and loops', () => {
    const tracker = new Tracker()
    const sim = new DemoSimulator(tracker, gazetteer(), T0)
    expect(sim.advance(T0)).toBe(1)
    sim.advance(T0 + 100_000)
    expect(
      tracker
        .active()
        .map((t) => t.type)
        .sort(),
    ).toEqual(['ballistic', 'kab', 'recon_drone', 'shahed', 'shahed'])
    const total = sim.advance(T0 + 2_100_000)
    expect(total).toBe(DEMO_SCENARIO.length - 5)
    // Group "a" was destroyed over Kushuhum, group "b" is still flying north.
    const shaheds = tracker.tracks().filter((t) => t.type === 'shahed')
    expect(shaheds.some((t) => t.status === 'destroyed')).toBe(true)
    expect(shaheds.some((t) => t.status === 'active')).toBe(true)
    sim.advance(T0 + DEMO_LOOP_SECONDS * 1000)
    expect(tracker.active().length).toBe(1)
  })

  it('every scenario place resolves', () => {
    const g = gazetteer()
    for (const step of DEMO_SCENARIO) {
      for (const name of [step.event.location, step.event.from, step.event.toward]) {
        if (name) expect(g.lookup(name), name).not.toBeNull()
      }
    }
  })
})

describe('findDataFile', () => {
  it('returns null when nothing matches', () => {
    expect(findDataFile('nope.json', ['.'])).toBeNull()
  })
})

class FakeIngest implements Ingest {
  status = 'connected'
  emit: ((m: RawMessage) => void) | null = null
  stop = vi.fn(async () => {})
  async start(onMessage: (m: RawMessage) => void) {
    this.emit = onMessage
  }
  async getMessage() {
    return null
  }
}

describe('runtime', () => {
  const runtimes: { stop(): Promise<void> }[] = []
  afterEach(async () => {
    while (runtimes.length) await runtimes.pop()!.stop()
    vi.useRealTimers()
  })

  const cfg = (env: Record<string, string> = {}) =>
    loadConfig({ NODE_ENV: 'test', WEB_DIST: './nope', ...env } as NodeJS.ProcessEnv)

  it('demo mode: serves moving tracks and an oblast alert', async () => {
    const rt = buildRuntime(cfg({ DEMO_MODE: 'true' }), silentLogger, { now: () => T0 + 60_000 })
    runtimes.push(rt)
    await rt.start()
    const state = await json(rt.app.request('/api/state'))
    expect(state.demo).toBe(true)
    expect(state.alerts.alerts[0].featureIds).toEqual(['r71980'])
    const health = await json(rt.app.request('/api/health'))
    expect(health).toMatchObject({ telegram: 'disabled', alerts: 'disabled', boundaries: 73 })
  })

  it('live mode: Telegram → extractor → tracker → SSE bus, push wired', async () => {
    const ingest = new FakeIngest()
    const extractor: Extractor = {
      extract: async () => ({
        relevant: true,
        all_clear: false,
        closures: [{ object: 'Мости', status: 'closed' as const }],
        events: [event({ location: 'Балабине', toward: 'Запоріжжя' })],
      }),
    }
    const send = vi.fn(async () => {})
    const rt = buildRuntime(
      cfg({ VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv', ALERTS_IN_UA_TOKEN: 'tok' }),
      silentLogger,
      {
        ingest,
        extractor,
        pushSender: send,
        now: () => min(1),
        fetch: async () => new Response(JSON.stringify({ alerts: [] })),
      },
    )
    runtimes.push(rt)
    const published: string[] = []
    rt.bus.subscribe((e) => published.push(e.type))
    await rt.start()
    rt.app.request('/api/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://arpha.svitix.com' },
      body: JSON.stringify({
        subscription: { endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' } },
        points: [{ name: 'Дім', ...ZAPORIZHZHIA }],
      }),
    })
    await new Promise((r) => setTimeout(r, 10))
    ingest.emit!(message({ id: 1, text: 'шахед повз Балабине', date: min(0) }))
    await vi.waitFor(() => expect(rt.tracker.active()).toHaveLength(1))
    const t = rt.tracker.active()[0]!
    expect(haversineKm(predictPosition(t, min(1))!, ZAPORIZHZHIA)).toBeLessThan(25)
    expect(published).toContain('track')
    expect(published).toContain('feed')
    expect(published).toContain('infra')
    expect(t.prediction?.targets.length).toBeGreaterThan(0)
    const state = await json(rt.app.request('/api/state'))
    expect(state.infra[0]).toMatchObject({ name: 'Мости Преображенського', status: 'closed' })
    expect(state.feed[0]).toMatchObject({ channel: 'test_channel', types: ['shahed'] })
    const hot = await json(rt.app.request('/api/hotspots?days=7'))
    expect(hot[0]).toMatchObject({ name: 'Балабине', count: 1 })
    await vi.waitFor(() => expect(send).toHaveBeenCalled())
    expect((await json(rt.app.request('/api/push/key'))).publicKey).toBe('pub')
    const health = await json(rt.app.request('/api/health'))
    expect(health.pipeline).toMatchObject({ processed: 1 })
    expect(health.alerts).toBe('ok')
    await rt.stop()
    runtimes.pop()
    expect(ingest.stop).toHaveBeenCalled()
  })

  it('imports channel history once to seed routes, without touching the live map', async () => {
    const ingest = new FakeIngest()
    const history = [
      message({ id: 1, text: 'шахед Василівка', date: min(-300) }),
      message({ id: 2, text: 'Балабине', replyToId: 1, date: min(-290) }),
    ]
    ;(ingest as Ingest).history = async () => history
    const extractor: Extractor = {
      extract: async (i) => ({
        relevant: true,
        all_clear: false,
        closures: [],
        events: [
          event({
            location: i.message.id === 1 ? 'Василівка' : 'Балабине',
            action: i.message.id === 1 ? 'new' : 'update',
          }),
        ],
      }),
    }
    const rt = buildRuntime(cfg({ HISTORY_IMPORT_HOURS: '6' }), silentLogger, {
      ingest,
      extractor,
      now: () => min(0),
    })
    runtimes.push(rt)
    expect(await rt.importHistory(6)).toBe(2)
    expect(rt.store.routes(0)[0]!.path.map((p) => p.place)).toEqual(['Василівка', 'Балабине'])
    expect(rt.tracker.active()).toHaveLength(0)
    const patterns = await json(rt.app.request('/api/patterns?days=7'))
    expect(patterns.corridors[0]).toMatchObject({ from: 'Василівка', to: 'Балабине' })
    // Runs only once per volume.
    expect(await rt.importHistory(6)).toBe(0)
  })

  it('without an extractor key, ingestion is not wired', () => {
    const rt = buildRuntime(cfg(), silentLogger, { ingest: new FakeIngest() })
    runtimes.push(rt)
    expect(rt.pipeline).toBeNull()
  })
})
