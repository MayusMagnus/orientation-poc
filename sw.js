// sw.js — cache contrôlé par version
const VERSION = (new URL(location)).searchParams.get('v') || 'dev';
const CACHE_NAME = 'orientation-' + VERSION;

// Liste des ressources essentielles (mêmes URLs que dans index.html/preview.html)
const CORE_ASSETS = [
  './',
  './index.html',
  './preview.html',
  './styles.css?v=' + VERSION,
  './scripts/agent.js?v=' + VERSION,
  './scripts/app.js?v=' + VERSION,
  './scripts/preview.js?v=' + VERSION,
  './data/questions.json?v=' + VERSION,
  './data/mock_summary.json?v=' + VERSION,
  './assets/renard_univia.png?v=' + VERSION,
  './assets/globe.png?v=' + VERSION
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CORE_ASSETS))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => { if (k !== CACHE_NAME) return caches.delete(k); }));
    await self.clients.claim();
  })());
});

// Stratégie :
// - HTML -> réseau d’abord, fallback cache
// - Assets versionnés (?v=...) -> cache d’abord, refresh silencieux
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (url.origin !== location.origin) return;

  if (req.headers.get('accept')?.includes('text/html')) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req, { cache: 'no-store' });
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, fresh.clone());
        return fresh;
      } catch (e) {
        const cached = await caches.match(req);
        return cached || new Response('<h1>Offline</h1>', { status: 503, headers: { 'Content-Type': 'text/html' } });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) {
      fetch(req).then(resp => caches.open(CACHE_NAME).then(c => c.put(req, resp.clone()))).catch(()=>{});
      return cached;
    }
    try {
      const fresh = await fetch(req);
      const cache = await caches.open(CACHE_NAME);
      cache.put(req, fresh.clone());
      return fresh;
    } catch (e) {
      return new Response('', { status: 504 });
    }
  })());
});
