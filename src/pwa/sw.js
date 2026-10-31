// Service worker. The build prepends VERSION and PRECACHE (every file the build produced,
// plus the files in public/), so a new deploy gets a new cache and old caches are removed.
//
// - The app shell and its assets are cached at install, so single-player works offline.
// - Pages: network first (always fresh when online), cached copy when offline.
// - Hashed assets: cache first (their names change whenever their content does).
// - Google Fonts: cached as they are used, so the fonts work offline after the first visit.
// - Never cached: /api/ (AI review), /_vercel/ (analytics), anything not GET, other origins
//   (the multiplayer server).
/* global VERSION, PRECACHE */
const SHELL = 'shell-' + VERSION;
const FONTS = 'fonts-v1';

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== SHELL && key !== FONTS) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(req, FONTS));
    return;
  }
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/_vercel/')) return;
  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req, url));
    return;
  }
  event.respondWith(cacheFirst(req, SHELL));
});

async function cacheFirst(req, name) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') (await caches.open(name)).put(req, res.clone());
  return res;
}

async function networkFirst(req, url) {
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(SHELL)).put(req, res.clone());
    return res;
  } catch {
    const page = url.pathname.startsWith('/mp') ? '/mp.html' : '/index.html';
    return (await caches.match(req, { ignoreSearch: true })) || (await caches.match(page)) || Response.error();
  }
}
