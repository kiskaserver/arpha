import type { LatLon, ThreatClass } from '@arpha/shared'

export type PushResult =
  | { ok: true }
  | {
      ok: false
      /** subscribe: the browser's push service refused; server: we rejected the subscription. */
      reason: 'unsupported' | 'denied' | 'unavailable' | 'subscribe' | 'server' | 'failed'
      /** Error name / HTTP status, shown so a user can report what went wrong. */
      detail?: string
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
}

const defaultEnv = (): PushEnv => ({
  fetch: globalThis.fetch.bind(globalThis),
  serviceWorker: globalThis.navigator?.serviceWorker,
  Notification: globalThis.Notification,
  hasPushManager: typeof globalThis.PushManager !== 'undefined',
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
export async function enablePush(
  prefs: PushPrefs,
  env: PushEnv = defaultEnv(),
): Promise<PushResult> {
  if (!pushSupported(env)) return { ok: false, reason: 'unsupported' }
  try {
    const keyRes = await env.fetch('/api/push/key')
    if (!keyRes.ok) return { ok: false, reason: 'unavailable' }
    const { publicKey } = (await keyRes.json()) as { publicKey: string }

    const permission = await env.Notification!.requestPermission()
    if (permission !== 'granted') return { ok: false, reason: 'denied' }

    const reg = await env.serviceWorker!.ready
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
        try {
          sub = await subscribe()
        } catch (err) {
          console.warn('push subscribe failed', err)
          return { ok: false, reason: 'subscribe', detail: describe(err) }
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

/** The error's name ("AbortError", "InvalidStateError"); DOMException is not always an Error. */
function describe(err: unknown): string {
  const name =
    typeof err === 'object' && err !== null && 'name' in err ? String(err.name) : String(err)
  return name.slice(0, 60)
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
