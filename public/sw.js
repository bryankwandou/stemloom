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

// Bumped when a cached file changes shape, such as the recorder worklet
// learning to acknowledge a stop.
const CACHE = "stemloom-v4";

// The pages the app needs to open offline, kept apart from everything
// cached at run time. Written once at install and never touched again
// while the app runs: an offline fallback read from a cache that is also
// being rewritten underneath it can find the entry missing at exactly the
// wrong moment, which is what the offline check kept catching on the first
// visit after a deploy.
const SHELL = "stemloom-shell-v4";

// The shell we want available before the user ever goes offline.
const PRECACHE = ["/", "/studio", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
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
        Promise.all(
          keys.filter((k) => k !== CACHE && k !== SHELL).map((k) => caches.delete(k)),
        ),
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
          // Only a good page is worth keeping; a 500 cached here would be
          // what the user sees the next time they are offline.
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => offlinePage(req)),
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

      if (hit && (req.destination === "worker" || req.destination === "sharedworker")) {
        return detach(hit);
      }
      return hit || network;
    }),
  );
});

/**
 * The page to show for a navigation with no network: the latest copy of
 * that page if there is one, else the shell. Vary is ignored because Next
 * marks pages as varying on its router headers, which a plain navigation
 * never carries the same way twice.
 */
function offlinePage(req) {
  const loose = { ignoreVary: true };
  return caches
    .match(req, loose)
    .then((hit) => hit || caches.open(SHELL).then((c) => c.match(new URL(req.url).pathname, loose)))
    .then((hit) => hit || caches.open(SHELL).then((c) => c.match("/studio", loose)));
}

/**
 * A copy of a cached response with no URL of its own.
 *
 * A worker takes its location from the response that served its script.
 * The bundler starts every worker from the same bootstrap file and passes
 * the chunks to load in the URL's fragment, and the Cache API stores URLs
 * without fragments — so a worker served straight from the cache wakes up
 * with no idea what to load and never answers. A response with no URL
 * leaves the worker the one it was created with, fragment and all.
 */
function detach(res) {
  return res.blob().then(
    (body) =>
      new Response(body, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      }),
  );
}
