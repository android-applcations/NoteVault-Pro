/* NoteVault Pro service worker — hand-written, no remote code, same-origin only. */
const VERSION = "__NV_SW_VERSION__";
const SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;
const PRECACHE = /* __NV_PRECACHE_BEGIN__ */ [
  "./",
  "./index.html",
  "./boot.js",
  "./manifest.webmanifest",
  "./offline.html",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
  "./apple-touch-icon.png",
] /* __NV_PRECACHE_END__ */;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await Promise.all(
        PRECACHE.map(async (u) => {
          const res = await fetch(new Request(u, { cache: "reload" }));
          if (!res || !res.ok) {
            throw new Error(`Precache failed for ${u}: ${res ? res.status : "no response"}`);
          }
          await cache.put(u, res);
        })
      );
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("message", (event) => {
  if (event.source && "url" in event.source) {
    try {
      if (new URL(event.source.url).origin !== self.location.origin) return;
    } catch {
      return;
    }
  }
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.headers.has("range")) return;
  if (url.pathname.endsWith("/sw.js")) return;

  // Navigation: network-first with cached shell fallback (offline support)
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(new Request(req, { cache: "no-cache" }));
          if (fresh && fresh.ok && fresh.type === "basic") {
            const cache = await caches.open(SHELL_CACHE);
            await cache.put("./index.html", fresh.clone()).catch(() => undefined);
          }
          return fresh;
        } catch {
          const cache = await caches.open(SHELL_CACHE);
          return (
            (await cache.match("./index.html", { ignoreVary: true })) ||
            (await cache.match("./", { ignoreVary: true })) ||
            (await cache.match("./offline.html", { ignoreVary: true })) ||
            Response.error()
          );
        }
      })()
    );
    return;
  }

  // Static assets: search current version caches only (never stale caches)
  event.respondWith(
    (async () => {
      const shell = await caches.open(SHELL_CACHE);
      const fromShell = await shell.match(req, { ignoreVary: true });
      if (fromShell) return fromShell;

      const runtime = await caches.open(RUNTIME_CACHE);
      const fromRuntime = await runtime.match(req, { ignoreVary: true });
      if (fromRuntime) return fromRuntime;

      try {
        const res = await fetch(req);
        if (res && res.ok && res.type === "basic") {
          await runtime.put(req, res.clone()).catch(() => undefined);
        }
        return res;
      } catch {
        return Response.error();
      }
    })()
  );
});
