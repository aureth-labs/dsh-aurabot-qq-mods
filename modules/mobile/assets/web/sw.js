'use strict'
// Notification click routing only. No fetch handler, caches, tokens, or private API responses.
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()))
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const botId = event.notification.data?.botId
  if (typeof botId !== 'string' || !botId || botId.length > 256) return
  event.waitUntil((async () => {
    const target = new URL('/', self.location.origin)
    target.searchParams.set('botId', botId)
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const existing = windows.find((client) => new URL(client.url).origin === target.origin)
    if (existing) {
      await existing.focus()
      existing.postMessage({ type: 'open-chat', botId })
    } else await self.clients.openWindow(target.href)
  })())
})
