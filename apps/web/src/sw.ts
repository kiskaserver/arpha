/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core'
import { ExpirationPlugin } from 'workbox-expiration'
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { CacheFirst, StaleWhileRevalidate } from 'workbox-strategies'

declare const self: ServiceWorkerGlobalScope

self.skipWaiting()
clientsClaim()
cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)

// App shell for every navigation, except the API.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: [/^\/api\//] }),
)

// Vector tiles, glyphs and sprites: the region is small, so cache aggressively for offline use.
registerRoute(
  ({ url }) => url.hostname === 'tiles.openfreemap.org' && !url.pathname.startsWith('/styles/'),
  new CacheFirst({
    cacheName: 'map-tiles',
    plugins: [
      new ExpirationPlugin({
        maxEntries: 3000,
        maxAgeSeconds: 30 * 24 * 3600,
        purgeOnQuotaError: true,
      }),
    ],
  }),
)
registerRoute(
  ({ url }) => url.hostname === 'tiles.openfreemap.org' && url.pathname.startsWith('/styles/'),
  new StaleWhileRevalidate({ cacheName: 'map-styles' }),
)

interface PushPayload {
  title: string
  body: string
  tag: string
  url: string
}

self.addEventListener('push', (event) => {
  let data: PushPayload = { title: 'Арфа', body: '', tag: 'arpha', url: '/' }
  try {
    data = { ...data, ...(event.data?.json() as Partial<PushPayload>) }
  } catch {
    data.body = event.data?.text() ?? ''
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag,
      icon: '/pwa-192x192.png',
      badge: '/pwa-64x64.png',
      data: { url: data.url },
      requireInteraction: data.tag === 'alert',
    } as NotificationOptions),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data as { url?: string } | undefined)?.url ?? '/'
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const existing = windows[0]
      if (existing) {
        await existing.focus()
        await existing.navigate(url)
        return
      }
      await self.clients.openWindow(url)
    })(),
  )
})
