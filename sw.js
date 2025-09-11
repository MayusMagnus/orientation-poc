// sw.js — ne JAMAIS mettre en cache data/*.json
const VERSION = "2025-09-11-04";
const STATIC_CACHE = "static-" + VERSION;

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) =>
      cache.addAll([
        "./",
        "./index.html?v=" + VERSION,
        "./styles.css?v=" + VERSION,
        "./scripts/app.js?v=" + VERSION,
        "./scripts/agent.js?v=" + VERSION,
        "./assets/renard_univia.png?v=" + VERSION,
      ]).catch(() => {})
    )
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== STATIC_CACHE).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 1) data/*.json : réseau d'abord, pas de cache
  if (url.pathname.includes("/data/") && url.pathname.endsWith(".json")) {
    event.respondWith(
      fetch(req, { cache: "no-store" }).catch(() =>
        caches.match(req, { ignoreSearch: false })
      )
    );
    return;
  }

  // 2) le reste : cache d'abord, puis réseau, en respectant la query string
  if (req.method === "GET") {
    event.respondWith(
      caches.match(req, { ignoreSearch: false }).then((cached) => {
        const fetchPromise = fetch(req)
          .then((networkRes) => {
            if (
              networkRes &&
              networkRes.status === 200 &&
              networkRes.type === "basic"
            ) {
              const clone = networkRes.clone();
              caches.open(STATIC_CACHE).then((cache) =>
                cache.put(req, clone)
              );
            }
            return networkRes;
          })
          .catch(() => cached);
        return cached || fetchPromise;
      })
    );
  }
});
