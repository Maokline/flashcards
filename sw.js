// FlashCard App service worker.
//
// * The app shell is precached, so the installed app opens offline.
// * Server mode: card media below /api/media is immutable per media ID and is
//   kept cache-first for offline use; all other /api/ requests go to the
//   network (data lives in IndexedDB).
// * Cloud mode (Google Drive, OneDrive): data and images live in IndexedDB;
//   Google and Microsoft requests are cross-origin and never touched here.
// Paths are relative to the worker, so the app runs at a domain root as well
// as below a sub path (e.g. GitHub Pages: https://example.github.io/flashcards/).

// The sync server and tools/build_pwa.py replace this value with a content
// hash of all app files, so every release is a new service worker version.
const VERSION = 'a0db51c4f808';
const SHELL_CACHE = `fc-shell-${VERSION}`;
const MEDIA_CACHE = 'fc-media-v1';
const MEDIA_LIMIT = 600;

const PRECACHE = [
  './',
  'index.html',
  'manifest.webmanifest',
  'config.json',
  'css/app.css',
  'js/api.js',
  'js/app.js',
  'js/bus.js',
  'js/cloud/errors.js',
  'js/cloud/providers.js',
  'js/cloud/sync.js',
  'js/config.js',
  'js/core/aidrafts.js',
  'js/core/aitest.js',
  'js/core/canonical.js',
  'js/core/dataset.js',
  'js/core/engine.js',
  'js/core/merge.js',
  'js/core/selection.js',
  'js/core/statistics.js',
  'js/core/time.js',
  'js/db.js',
  'js/gdrive/auth.js',
  'js/gdrive/drive.js',
  'js/gdrive/store.js',
  'js/images.js',
  'js/local/backend.js',
  'js/onedrive/auth.js',
  'js/onedrive/graph.js',
  'js/onedrive/store.js',
  'js/pickers.js',
  'js/screens/ai.js',
  'js/screens/cards.js',
  'js/screens/device.js',
  'js/screens/editor.js',
  'js/screens/home.js',
  'js/screens/learn.js',
  'js/screens/more.js',
  'js/screens/onboarding.js',
  'js/store.js',
  'js/sync-server.js',
  'js/sync.js',
  'js/ui.js',
  'js/util.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
];

const scopeUrl = (path) => new URL(path, self.registration ? self.registration.scope : self.location.href).toString();

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE.map((url) => new Request(scopeUrl(url), { cache: 'reload' })))),
  );
  // No skipWaiting() here: an update waits until the app offers
  // "Update verfügbar – Neu laden", so running code is never swapped mid-use.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith('fc-shell-') && key !== SHELL_CACHE)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'clear-media') event.waitUntil(caches.delete(MEDIA_CACHE));
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function isMedia(url) {
  return url.pathname.startsWith('/api/media/') && !url.pathname.endsWith('/meta')
    || /^\/api\/ai-drafts\/jobs\/[^/]+\/media\//.test(url.pathname);
}

async function trimMediaCache() {
  const cache = await caches.open(MEDIA_CACHE);
  const keys = await cache.keys();
  for (let index = 0; index < keys.length - MEDIA_LIMIT; index += 1) await cache.delete(keys[index]);
}

async function mediaFirst(request) {
  const cache = await caches.open(MEDIA_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.status === 200) {
    await cache.put(request, response.clone());
    trimMediaCache();
  }
  return response;
}

async function navigation(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok && !new URL(request.url).search) cache.put(scopeUrl('index.html'), response.clone());
    return response;
  } catch {
    return (await cache.match(scopeUrl('index.html'))) || (await cache.match(scopeUrl('./'))) || Response.error();
  }
}

async function shellAsset(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  const network = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  if (cached) {
    // Stale-while-revalidate: answer instantly, refresh in the background.
    network.catch(() => {});
    return cached;
  }
  return (await network) || Response.error();
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) {
    if (isMedia(url)) event.respondWith(mediaFirst(request));
    return;
  }
  if (request.mode === 'navigate') {
    event.respondWith(navigation(request));
    return;
  }
  event.respondWith(shellAsset(request));
});
