/* F11-07 Service Worker (F11-02-Hülle + Update-Protokoll): Offline-Hülle
 * ohne Sync/Push. Navigation: network-first mit Fallback auf /offline.html.
 * Gleichartige GET-Anfragen (kein /api/*, kein Auth-OTP): stale-while-
 * revalidate. Versionierter Cache, alte Stände werden aufgeräumt.
 * Update: kein Auto-skipWaiting — neuer Worker wartet, bis die Seite per
 * {type:'SKIP_WAITING'} aktualisiert (Update-Notice). Erstinstallation
 * aktiviert weiter sofort (kein aktiver Worker → kein Waiting).
 */
const SW_VERSION = "f11-07-v1";
const STATIC_CACHE = `wmee-static-${SW_VERSION}`;
const PAGES_CACHE = `wmee-pages-${SW_VERSION}`;
const PRECACHE = ["/offline.html", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE)),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("wmee-") && key !== STATIC_CACHE && key !== PAGES_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function isCacheableSameOriginGet(request, url) {
  if (request.method !== "GET") return false;
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith("/api/")) return false;
  return true;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (!isCacheableSameOriginGet(request, url)) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(PAGES_CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() =>
          caches.match(request).then(
            (cached) => cached ?? caches.match("/offline.html"),
          ),
        ),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ??
        fetch(request).then((response) => {
          if (response.ok && (request.destination === "style" || request.destination === "script" || request.destination === "image" || request.destination === "font")) {
            const copy = response.clone();
            caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});
