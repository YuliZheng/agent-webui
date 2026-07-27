const CACHE_PREFIX = "agent-webui-static-";
const CACHE_NAME = `${CACHE_PREFIX}v1`;
const STATIC_PATHS = new Set([
  "/",
  "/manifest.webmanifest",
  "/assets/icon-192.png",
  "/favicon-1780988963583-transparent.png",
]);

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
  const isStaticAsset = url.pathname.startsWith("/assets/") || STATIC_PATHS.has(url.pathname);
  if (!isNavigation && !isStaticAsset) return;

  // Network-first avoids pinning an old index/assets set after a safe publish.
  // Only public application shell files are cached; WebSocket/API/attachment
  // traffic is deliberately outside this handler.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (!response.ok) return response;
        const cacheKey = isNavigation ? "/" : request;
        void caches.open(CACHE_NAME)
          .then((cache) => cache.put(cacheKey, response.clone()))
          .catch(() => undefined);
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(isNavigation ? "/" : request);
        return cached ?? Response.error();
      }),
  );
});
