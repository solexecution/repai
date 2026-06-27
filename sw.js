/**
 * sw.js — Service Worker for RepCount PWA
 *
 * Strategy:
 *  - App shell: pre-cached on install
 *  - External CDN resources (TF.js, model weights): cached on first fetch,
 *    served from cache when offline
 */

const CACHE_VERSION = 'repai-v11';

const APP_SHELL = [
  './index.html',
  './style.css',
  './app.js',
  './pose-engine.js',
  './rep-counter.js',
  './voice-assistant.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './videos/pushup.mp4',
  './vosk/vosk.js',
  './vosk/vosk-model-small-en-us-0.15.tar.gz'
];

// ─── Install ────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => {
      return cache.addAll(APP_SHELL);
    })
  );
  // Take control immediately without waiting for old SW to die
  self.skipWaiting();
});

// ─── Activate ────────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_VERSION)
          .map(key => caches.delete(key))
      )
    )
  );
  // Claim all clients so the new SW controls existing tabs
  self.clients.claim();
});

// ─── Fetch ───────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;

  // Only handle GET requests
  if (request.method !== 'GET') return;

  // Skip non-HTTP(S) requests (chrome-extension://, etc.)
  if (!request.url.startsWith('http')) return;

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) {
        // Serve from cache; also refresh it in the background
        fetch(request)
          .then(response => {
            if (response && response.status === 200) {
              caches.open(CACHE_VERSION).then(cache => cache.put(request, response));
            }
          })
          .catch(() => {}); // ignore network errors during background refresh
        return cached;
      }

      // Not in cache — fetch from network and cache the result
      return fetch(request)
        .then(response => {
          if (!response || response.status !== 200 || response.type === 'error') {
            return response;
          }
          // Cache a clone (response body can only be consumed once)
          const toCache = response.clone();
          caches.open(CACHE_VERSION).then(cache => cache.put(request, toCache));
          return response;
        })
        .catch(() => {
          // Offline fallback for HTML navigations
          if (request.destination === 'document') {
            return caches.match('./index.html');
          }
          return new Response('Offline', { status: 503 });
        });
    })
  );
});
