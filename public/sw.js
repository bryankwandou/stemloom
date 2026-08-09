/**
 * Stemloom service worker.
 *
 * Strategy is stale-while-revalidate over same-origin GETs. The first visit
 * populates the cache as assets are requested; every visit after that is
 * served from disk first and refreshed in the background, so the editor
 * opens instantly and keeps working with the network switched off.
 *
 * Cross-origin requests are deliberately not handled. There should not be
 * any — if one ever appears, it will fail loudly rather than be quietly
 * cached, which is exactly the behaviour we want from a tool that claims
 * your audio never leaves the machine.
 */

const CACHE = "stemloom-v1";

// The shell we want available before the user ever goes offline.
const PRECACHE = ["/", "/studio", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // Individually, so one miss cannot fail the whole install.
      .then((c) => Promise.allSettled(PRECACHE.map((u) => c.add(u))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Navigations fall back to the cached shell so a hard refresh while
  // offline still lands somewhere useful instead of the dinosaur.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() =>
          caches.match(req).then((hit) => hit || caches.match("/studio")),
        ),
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => hit);

      return hit || network;
    }),
  );
});
