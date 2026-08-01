const CACHE_PREFIX = "agent-webui-static-";
const CACHE_NAME = `${CACHE_PREFIX}v1`;
const SHELL_KEY = "/";
const NAVIGATION_NETWORK_BUDGET_MS = 750;
const STATIC_PATHS = new Set([
  SHELL_KEY,
  "/manifest.webmanifest",
  "/assets/icon-192.png",
  "/favicon-1780988963583-transparent.png",
]);

async function fetchAndCache(request, cacheKey) {
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(cacheKey, response.clone());
  }
  return response;
}

function boundedNavigationResponse(event, request) {
  const networkResponse = fetchAndCache(request, SHELL_KEY);
  event.waitUntil(networkResponse.then(() => undefined, () => undefined));

  return (async () => {
    const cached = await caches.match(SHELL_KEY);
    if (!cached) return networkResponse;

    let timeoutId;
    const cachedAfterBudget = new Promise((resolve) => {
      timeoutId = setTimeout(() => resolve(cached), NAVIGATION_NETWORK_BUDGET_MS);
    });
    try {
      return await Promise.race([networkResponse, cachedAfterBudget]);
    } catch {
      return cached;
    } finally {
      clearTimeout(timeoutId);
    }
  })();
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    return await fetchAndCache(request, request);
  } catch {
    return Response.error();
  }
}

async function networkFirst(request) {
  try {
    return await fetchAndCache(request, request);
  } catch {
    const cached = await caches.match(request);
    return cached ?? Response.error();
  }
}

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const isNavigation = request.mode === "navigate";
  const isHashedAsset = url.pathname.startsWith("/assets/");
  const isStaticAsset = isHashedAsset || STATIC_PATHS.has(url.pathname);
  if (!isNavigation && !isStaticAsset) return;

  // A slow relay/tailnet path must not hold an installed PWA on a blank screen.
  // Navigation gets a short freshness budget, then reuses the cached shell while
  // the in-flight response refreshes it. Content-hashed assets are immutable, so
  // their cached copy is always safe. API/WebSocket/attachment traffic remains
  // outside this handler and keeps its live network semantics.
  if (isNavigation) {
    event.respondWith(boundedNavigationResponse(event, request));
  } else if (isHashedAsset) {
    event.respondWith(cacheFirst(request));
  } else {
    event.respondWith(networkFirst(request));
  }
});
