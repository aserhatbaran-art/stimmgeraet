/**
 * Service Worker: macht die App offline nutzbar.
 * Strategie: sofort aus dem Cache antworten und im Hintergrund aktualisieren.
 * Eine neue Version erscheint dadurch beim übernächsten Öffnen der App.
 * Bei Änderungen an der Dateiliste die Versionsnummer erhöhen.
 */
const CACHE = 'stimmgeraet-v1';
const FILES = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/audio.js',
  'js/pitch.js',
  'js/tone.js',
  'js/tunings.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request, { ignoreSearch: true });
      const update = fetch(request)
        .then((response) => {
          if (response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(() => cached);
      if (cached) {
        event.waitUntil(update);
        return cached;
      }
      return update;
    }),
  );
});
