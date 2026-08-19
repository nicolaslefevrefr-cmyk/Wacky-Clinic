// Wacky Clinic - service worker
// Cache-first for the app shell (so the game boots offline / on GitHub Pages after first visit),
// falling back to the network for anything not in the cache, and updating the cache in the
// background whenever a newer version of a cached file is fetched.

const CACHE_NAME = "wacky-clinic-v2";

// All paths are relative to this file's own location, so this works whether the site is served
// from a domain root or a GitHub Pages project subpath (e.g. username.github.io/repo-name/).
const APP_SHELL = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  // Only handle same-origin GET requests - everything else (e.g. cross-origin API calls, if
  // any are ever added) just goes straight to the network untouched.
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached); // offline and not cached: nothing more we can do

      // Cache-first: serve instantly from cache if we have it, and refresh the cache quietly in
      // the background so the next load picks up any update.
      return cached || networkFetch;
    })
  );
});
