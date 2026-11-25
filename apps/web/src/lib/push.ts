import type { LatLon } from '@arpha/shared'

export type PushResult =
  | { ok: true }
  | { ok: false; reason: 'unsupported' | 'denied' | 'unavailable' | 'failed' }

export interface PushPrefs {
  point: LatLon | null
  radiusKm: number
  alerts: boolean
  threats: boolean
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
    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      }))
    const res = await env.fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON(), ...prefs }),
    })
    return res.ok ? { ok: true } : { ok: false, reason: 'failed' }
  } catch {
    return { ok: false, reason: 'failed' }
  }
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
