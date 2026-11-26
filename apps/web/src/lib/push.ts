import type { LatLon, ThreatClass } from '@arpha/shared'

export type PushResult =
  | { ok: true }
  | {
      ok: false
      /** subscribe: the browser's push service refused; server: we rejected the subscription. */
      reason: 'unsupported' | 'denied' | 'unavailable' | 'subscribe' | 'server' | 'failed'
      /** Error name / HTTP status, shown so a user can report what went wrong. */
      detail?: string
      /** It failed in the installed app (home-screen PWA), not in a browser tab. */
      standalone?: boolean
    }

export interface PushPrefs {
  points: (LatLon & { name: string; radiusKm?: number })[]
  radiusKm: number
  alerts: boolean
  threats: boolean
  classes: ThreatClass[]
}

export interface PushEnv {
  fetch: typeof fetch
  serviceWorker?: ServiceWorkerContainer | undefined
  Notification?: { requestPermission(): Promise<NotificationPermission> } | undefined
  hasPushManager: boolean
  /** Pause before retrying a failed subscribe (FCM needs a moment after an unsubscribe). */
  sleep?: (ms: number) => Promise<void>
  /** Running as the installed app (home-screen PWA). */
  standalone?: boolean
}

const defaultEnv = (): PushEnv => ({
  fetch: globalThis.fetch.bind(globalThis),
  serviceWorker: globalThis.navigator?.serviceWorker,
  Notification: globalThis.Notification,
  hasPushManager: typeof globalThis.PushManager !== 'undefined',
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  standalone: globalThis.matchMedia?.('(display-mode: standalone)').matches ?? false,
})

export function pushSupported(env: PushEnv = defaultEnv()): boolean {
  return Boolean(env.serviceWorker && env.Notification && env.hasPushManager)
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/')
  const raw = atob(padded)
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

/** Ask permission, subscribe with the server's VAPID key, register preferences. */
/** The server's VAPID key, fetched ahead of the tap so the tap itself does no network first. */
let cachedKey: string | null = null

async function fetchKey(env: PushEnv): Promise<string | null> {
  const res = await env.fetch('/api/push/key')
  if (!res.ok) return null
  cachedKey = ((await res.json()) as { publicKey: string }).publicKey
  return cachedKey
}

/** Warm the key cache (call on app start); errors are ignored, enablePush retries. */
export async function prefetchPushKey(env: PushEnv = defaultEnv()): Promise<void> {
  if (!pushSupported(env)) return
  await fetchKey(env).catch(() => null)
}

/** For tests: forget the cached key. */
export function resetPushKey(): void {
  cachedKey = null
}

/**
 * The registration once its worker is fully active: subscribing while a freshly deployed
 * worker is still activating fails with "AbortError: no active Service Worker".
 */
async function activeRegistration(sw: ServiceWorkerContainer): Promise<ServiceWorkerRegistration> {
  const reg = await sw.ready
  const worker = reg.active
  if (worker && worker.state !== 'activated') {
    await new Promise<void>((resolve) => {
      const done = () => worker.state === 'activated' && resolve()
      worker.addEventListener('statechange', done)
      setTimeout(resolve, 3000)
    })
  }
  return reg
}

export async function enablePush(
  prefs: PushPrefs,
  env: PushEnv = defaultEnv(),
): Promise<PushResult> {
  if (!pushSupported(env)) return { ok: false, reason: 'unsupported' }
  try {
    // Ask first, straight from the tap: browsers (Safari strictly) want the prompt — and on
    // iOS the subscribe — inside the user gesture, before any network round trip.
    const permission = await env.Notification!.requestPermission()
    if (permission !== 'granted') return { ok: false, reason: 'denied' }

    const publicKey = cachedKey ?? (await fetchKey(env))
    if (!publicKey) return { ok: false, reason: 'unavailable' }

    const reg = await activeRegistration(env.serviceWorker!)
    const key = urlBase64ToUint8Array(publicKey)
    const subscribe = () =>
      reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
    let sub = await reg.pushManager.getSubscription()
    // A subscription made with another server key can be neither reused nor replaced in place.
    if (sub && !sameKey(sub.options?.applicationServerKey, key)) {
      await sub.unsubscribe().catch(() => false)
      sub = null
    }
    if (!sub) {
      try {
        sub = await subscribe()
      } catch {
        // A stale registration (InvalidStateError) or a push-service hiccup: clear, retry once.
        await (await reg.pushManager.getSubscription())?.unsubscribe().catch(() => false)
        await env.sleep?.(1500)
        try {
          sub = await subscribe()
        } catch (err) {
          console.warn('push subscribe failed', err)
          return {
            ok: false,
            reason: 'subscribe',
            detail: describe(err),
            standalone: env.standalone === true,
          }
        }
      }
    }
    const res = await env.fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON(), ...prefs }),
    })
    return res.ok ? { ok: true } : { ok: false, reason: 'server', detail: String(res.status) }
  } catch (err) {
    console.warn('push enable failed', err)
    return { ok: false, reason: 'failed', detail: describe(err) }
  }
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return true // the browser does not expose it: assume it is ours
  const x = new Uint8Array(a)
  return x.length === b.length && x.every((v, i) => v === b[i])
}

/**
 * "AbortError: Registration failed - push service error" vs "… no active Service Worker":
 * the name alone does not tell a network problem from a timing one. DOMException is not
 * always an Error, so read the fields directly.
 */
function describe(err: unknown): string {
  if (typeof err !== 'object' || err === null) return String(err).slice(0, 90)
  const name = 'name' in err ? String(err.name) : ''
  const message = 'message' in err ? String(err.message) : ''
  return (message ? `${name}: ${message}` : name || String(err)).slice(0, 90)
}

export async function disablePush(env: PushEnv = defaultEnv()): Promise<void> {
  if (!env.serviceWorker) return
  try {
    const reg = await env.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    if (!sub) return
    await env.fetch('/api/push/unsubscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    })
    await sub.unsubscribe()
  } catch {
    /* best effort */
  }
}
