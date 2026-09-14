/*
 * planee service worker — full offline support.
 *
 * Strategy:
 *  - Install: cache only the app SHELL (the pages + icons). Fast, small, and
 *    it never competes with the booting app for the host's rate limit.
 *  - Activate: purge old caches, claim clients, then crawl the fingerprinted
 *    _astro/ asset graph in the BACKGROUND — one file at a time, with a delay
 *    between each and a hard cap — so pages never visited still work offline.
 *  - Navigations (HTML): network-first (with retry) so users always get the
 *    newest deploy when online; when the network is unavailable the cached
 *    copy (or the cached home page) serves.
 *  - Assets: stale-while-revalidate — served from cache instantly, refreshed
 *    in the background; a miss goes to the network with retry.
 *
 * Why the pacing and retries: static hosts (GitHub Pages) rate-limit request
 * bursts with 503s, and because a crawl-on-install runs while the app is still
 * booting, the app's own dynamic imports land in the same rate limit. A
 * precache is a nicety and must never degrade the live app. Fingerprinted
 * assets are immutable, so retrying is always safe.
 */

// Bump this on any meaningful change to this file: `activate` only purges
// caches whose name differs, so a constant name makes that step dead code and
// lets a previous deploy's (or a poisoned) entry survive forever.
const CACHE_NAME = 'planee-cache-v6';

// Everything under this prefix belongs to this app. Cache Storage is keyed by
// ORIGIN, not by service-worker scope, so if two of these apps are ever served
// from one origin (a path-multiplexing gateway does exactly that) a bare
// "delete every key that isn't mine" makes them evict each other's caches on
// every activation. Scoping deletion to this prefix keeps the version bump
// working without touching a neighbour.
const CACHE_PREFIX = 'planee-cache-';

// The worker is registered from `${base}/sw.js`, so its scope IS the Astro
// base ('/' at the root, '/my-app/' under a sub-path like GitHub Pages).
// Deriving every path from it keeps the shell correct without hardcoding
// the base.
const BASE = new URL(self.registration.scope).pathname; // always ends with '/'
const ASSET_PREFIX = BASE + '_astro/';
const SHELL = ['', 'board/', 'project/', 'version/', 'task/', 'version_task/', 'asset/', 'preferences/', 'settings/', 'onboarding/', 'favicon.svg', 'manifest.webmanifest'].map((p) => BASE + p);

// Self-hosted Excalidraw fonts (public/excalidraw/fonts, refreshed by
// `npm run copy:excalidraw-fonts`). They live outside _astro/, so the crawl
// below cannot discover them; they are seeded into it explicitly so drawings
// render with the hand-drawn font offline. src/lib/sw.test.ts fails if this
// list and the files on disk drift apart.
const FONT_ASSETS = [
  'excalidraw/fonts/Cascadia/CascadiaCode-Regular.woff2',
  'excalidraw/fonts/Excalifont/Excalifont-Regular-349fac6ca4700ffec595a7150a0d1e1d.woff2',
  'excalidraw/fonts/Excalifont/Excalifont-Regular-3f2c5db56cc93c5a6873b1361d730c16.woff2',
  'excalidraw/fonts/Excalifont/Excalifont-Regular-41b173a47b57366892116a575a43e2b6.woff2',
  'excalidraw/fonts/Excalifont/Excalifont-Regular-623ccf21b21ef6b3a0d87738f77eb071.woff2',
  'excalidraw/fonts/Excalifont/Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2',
  'excalidraw/fonts/Excalifont/Excalifont-Regular-b9dcf9d2e50a1eaf42fc664b50a3fd0d.woff2',
  'excalidraw/fonts/Excalifont/Excalifont-Regular-be310b9bcd4f1a43f571c46df7809174.woff2',
  'excalidraw/fonts/Nunito/Nunito-Regular-XRXI3I6Li01BKofiOc5wtlZ2di8HDIkhdTA3j6zbXWjgevT5.woff2',
  'excalidraw/fonts/Nunito/Nunito-Regular-XRXI3I6Li01BKofiOc5wtlZ2di8HDIkhdTQ3j6zbXWjgeg.woff2',
  'excalidraw/fonts/Nunito/Nunito-Regular-XRXI3I6Li01BKofiOc5wtlZ2di8HDIkhdTk3j6zbXWjgevT5.woff2',
  'excalidraw/fonts/Nunito/Nunito-Regular-XRXI3I6Li01BKofiOc5wtlZ2di8HDIkhdTo3j6zbXWjgevT5.woff2',
  'excalidraw/fonts/Nunito/Nunito-Regular-XRXI3I6Li01BKofiOc5wtlZ2di8HDIkhdTs3j6zbXWjgevT5.woff2',
].map((p) => BASE + p);

// Servers often send `Vary: Origin`, and module import() requests carry an
// Origin header while our install-time fetches don't — without ignoreVary the
// cache would refuse to serve cached chunks to module loads.
const MATCH_OPTS = { ignoreVary: true };

// Navigations also ignore query strings: routes like /page/?id=<x> are cached
// as /page/ (the static HTML is identical for every query).
const NAV_OPTS = { ignoreVary: true, ignoreSearch: true };

// Background-warm pacing: gap between fetches and a ceiling on how many the
// crawl will pull, so a large bundle can't hammer the host.
const WARM_DELAY_MS = 120;
// Sized from the measured production build (board + markdown editor): a full
// crawl is 259 fetches (12 shell pages/files, 13 Excalidraw fonts, 234 _astro
// files), +25% headroom. tests/sync/sw-crawl.spec.ts replays this crawl
// against the built dist/ and fails when the bundle outgrows the cap or a
// file becomes unreachable — raise it there, deliberately, not by guesswork.
const WARM_MAX_ASSETS = 324;

/** Transient failures worth retrying (throttles and gateway hiccups). */
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 300;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * fetch with exponential backoff on 429/5xx and network errors. Returns the
 * final Response even if it is still an error status (callers decide); throws
 * only when every attempt threw.
 */
async function fetchWithRetry(request) {
  let lastError;
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
    try {
      const response = await fetch(request);
      if (!RETRY_STATUS.has(response.status) || attempt === RETRY_ATTEMPTS - 1) return response;
      lastError = new Error('HTTP ' + response.status);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/** Offline navigation fallback: exact page → trailing-slash page → home. */
async function cachedNavigation(request, url) {
  const cache = await caches.open(CACHE_NAME);
  const withSlash = url.pathname.endsWith('/') ? url.pathname : url.pathname + '/';
  return (
    (await cache.match(request, NAV_OPTS)) ??
    (await cache.match(withSlash, NAV_OPTS)) ??
    (await cache.match(BASE, NAV_OPTS))
  );
}

/** Install-time: the app shell only. Small and bounded. */
async function precacheShell() {
  const cache = await caches.open(CACHE_NAME);
  await Promise.all(
    SHELL.map(async (url) => {
      try {
        const response = await fetchWithRetry(url);
        if (response.ok) await cache.put(url, response.clone());
      } catch {
        // Offline during install — the fetch handler fills this in later.
      }
    })
  );
}

/**
 * Crawl the cached HTML/JS/CSS for fingerprinted _astro/ assets (including
 * dynamically imported chunks) and cache them, slowly, after activation.
 * Never awaited by anything the app is waiting on.
 */
async function warmAssetCache() {
  const cache = await caches.open(CACHE_NAME);
  const seen = new Set([...SHELL, ...FONT_ASSETS]);
  const queue = [...SHELL, ...FONT_ASSETS];
  let fetched = 0;

  while (queue.length > 0 && fetched < WARM_MAX_ASSETS) {
    const url = queue.shift();
    let response = await cache.match(url, MATCH_OPTS);
    if (!response) {
      await sleep(WARM_DELAY_MS); // pace: never burst at the host
      try {
        response = await fetchWithRetry(url);
      } catch {
        continue; // genuinely offline; the next activation resumes the crawl
      }
      fetched++;
      if (!response.ok) continue; // never cache a non-ok response
      await cache.put(url, response.clone());
    }
    const type = response.headers.get('content-type') || '';
    if (!/html|javascript|css/.test(type)) continue;
    const text = await response.clone().text();
    const enqueue = (path) => {
      if (path.startsWith(ASSET_PREFIX) && !seen.has(path)) {
        seen.add(path);
        queue.push(path);
      }
    };
    // Fingerprinted asset references, however the bundle spells them:
    // "/_astro/x.js" (HTML), "/base/_astro/x.js", or bare "_astro/x.js"
    // (Vite's __vite__mapDeps). Normalizing the _astro/... tail onto BASE
    // covers every form.
    for (const match of text.matchAll(/_astro\/[A-Za-z0-9_.\-]+/g)) {
      enqueue(BASE + match[0]);
    }
    // Relative specifiers — note the bundler emits dynamic imports with
    // BACKTICKS, e.g. import(`./chunk.js`), so all three quote styles count.
    const from = new URL(url, self.location.origin);
    // Only specifiers that name a loadable asset: bundled libraries are full
    // of strings that merely LOOK relative ("./locales/de-DE.json",
    // "./fonts/Virgil/…", "./mm_resize"), and each one would otherwise cost a
    // paced 404 fetch against WARM_MAX_ASSETS.
    for (const match of text.matchAll(/['"`](\.{1,2}\/[A-Za-z0-9_.\-/]+\.(?:m?js|css))['"`]/g)) {
      try {
        enqueue(new URL(match[1], from).pathname);
      } catch {
        // not a resolvable path — ignore
      }
    }
  }
}

// Browsers terminate idle service workers, and a paced crawl spends most of
// its time sleeping — so a warm run is regularly cut short. These live for the
// lifetime of one worker instance: a restarted worker re-runs the crawl, which
// skips everything already cached (no delay on a cache hit) and picks up where
// the last run stopped. `activate` fires only once, so navigations re-kick it.
let warmPromise = null;
let warmDone = false;

function warmOnce() {
  if (warmDone) return Promise.resolve();
  if (!warmPromise) {
    warmPromise = warmAssetCache()
      .then(() => {
        warmDone = true;
      })
      .catch(() => {})
      .finally(() => {
        warmPromise = null;
      });
  }
  return warmPromise;
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
      // Start the warm in the background, deliberately OUTSIDE waitUntil. A
      // worker stays in the "activating" state until every promise passed to
      // activate's waitUntil settles, and the browser holds every fetch event
      // for its clients — navigations included — until it is "activated". The
      // paced crawl takes ~30 s (WARM_MAX_ASSETS × WARM_DELAY_MS), so waiting
      // on it here froze the first navigation after install for that long.
      // The fetch handler's warmOnce() keeps an interrupted crawl going.
      .then(() => {
        void warmOnce();
      })
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache the sync/API endpoints — they must always hit the server. Once
  // the client resolves its sync URL from BASE_URL these live under the app's
  // own base (`/<user>/planee/sync/pull` behind a path-multiplexing
  // gateway), so match on a path segment rather than a root-absolute path: the
  // base is not known here. A stale-while-revalidate /sync/pull would hand the
  // client a response it has already applied and report success — silent data
  // loss — and GET /backup would otherwise be served from cache too.
  if (
    /\/sync\//.test(url.pathname) ||
    /\/healthz$/.test(url.pathname) ||
    /\/backup$/.test(url.pathname)
  ) {
    return;
  }

  // Resume an interrupted warm. Cheap once it has finished, and the in-flight
  // request keeps the worker alive long enough to make more progress, so the
  // graph fills in across normal use even when a run gets cut short.
  event.waitUntil(warmOnce());

  if (request.mode === 'navigate') {
    // Network-first: fresh page when online, cached page offline. The cache
    // key is the bare pathname so /page/?id=a and /page/?id=b share one entry.
    event.respondWith(
      (async () => {
        try {
          const response = await fetchWithRetry(request);
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(url.pathname, copy));
            return response;
          }
          // Server error after retries — a cached page beats an error page.
          return (await cachedNavigation(request, url)) ?? response;
        } catch {
          // Always resolve with a real Response: resolving respondWith with a
          // non-Response makes Chromium report a confusing synthetic 503.
          return (await cachedNavigation(request, url)) ?? Response.error();
        }
      })()
    );
    return;
  }

  // Stale-while-revalidate for everything else.
  event.respondWith(
    (async () => {
      const cached = await caches.match(request, MATCH_OPTS);
      if (cached) {
        // Answer from cache now, refresh in the background.
        event.waitUntil(
          fetchWithRetry(request)
            .then(async (response) => {
              if (response.ok) {
                (await caches.open(CACHE_NAME)).put(request, response.clone());
              }
            })
            .catch(() => {})
        );
        return cached;
      }
      try {
        const response = await fetchWithRetry(request);
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      } catch {
        return Response.error(); // never a non-Response
      }
    })()
  );
});
