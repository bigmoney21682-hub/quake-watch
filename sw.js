/* Service worker: offline shell + background collection where the browser allows it. */
importScripts('js/core.js');

const CACHE = 'quake-watch-v4';
const SHELL = [
  './', 'index.html', 'css/app.css', 'js/core.js', 'js/app.js', 'manifest.webmanifest',
  'vendor/uPlot.iife.min.js', 'vendor/uPlot.min.css', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon.svg',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// App shell: network-first (so updates land immediately), cache fallback when offline.
// Data APIs (cross-origin) are never cached here; history lives in IndexedDB.
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});

async function backgroundRun() {
  const { alerts } = await QW.collect();
  const st = await QW.settings();
  if (!st.notify) return;
  for (const a of alerts) {
    await self.registration.showNotification(a.title, {
      body: a.body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: a.ref || a.kind, data: { url: './' },
    });
  }
}
// Chrome/Edge on installed PWAs: periodic background sync (browser decides the actual cadence).
self.addEventListener('periodicsync', e => { if (e.tag === 'collect') e.waitUntil(backgroundRun()); });
self.addEventListener('sync', e => { if (e.tag === 'collect') e.waitUntil(backgroundRun()); });
// Page asks the SW to show a notification (works even when the tab is in the background).
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'notify') {
    const a = e.data.alert;
    self.registration.showNotification(a.title, { body: a.body, icon: 'icons/icon-192.png', tag: a.ref || a.kind, data: { url: './' } });
  }
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then(cs => cs.length ? cs[0].focus() : self.clients.openWindow('./')));
});
