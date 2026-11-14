/* NoteVault Pro service worker — hand-written, same-origin only, never clears IndexedDB/Dexie user data. */
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

function isCacheableResponse(res) {
  if (!res || res.status !== 200 || res.type !== "basic") return false;
  const cc = (res.headers.get("Cache-Control") || "").toLowerCase();
  if (cc.includes("no-store") || cc.includes("private")) return false;
  if (res.headers.has("Set-Cookie")) return false;
  return true;
}

async function safeCachePut(cacheName, req, res) {
  try {
    const cache = await caches.open(cacheName);
    await cache.put(req, res);
  } catch {
    /* Ignore QuotaExceededError or transient Cache Storage failures */
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await Promise.all(
        PRECACHE.map(async (u) => {
          const res = await fetch(new Request(u, { cache: "reload" }));
          if (!res || res.status !== 200) {
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
          .map((k) => caches.delete(k).catch(() => false))
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
  // Never intercept or cache non-GET requests (e.g. POST/PUT/DELETE)
  if (req.method !== "GET") return;
  if (req.cache === "only-if-cached" && req.mode !== "same-origin") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.headers.has("range")) return;
  if (url.pathname.endsWith("/sw.js")) return;

  // Navigation requests: network-first with cached shell -> offline.html fallback
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(new Request(req, { cache: "no-cache" }));
          if (isCacheableResponse(fresh)) {
            await safeCachePut(SHELL_CACHE, "./index.html", fresh.clone());
          }
          return fresh;
        } catch {
          try {
            const cache = await caches.open(SHELL_CACHE);
            return (
              (await cache.match("./index.html", { ignoreVary: true })) ||
              (await cache.match("./", { ignoreVary: true })) ||
              (await cache.match("./offline.html", { ignoreVary: true })) ||
              Response.error()
            );
          } catch {
            return Response.error();
          }
        }
      })()
    );
    return;
  }

  // Manifest & boot scripts: network-first so theme/metadata updates stay fresh when online, cached when offline
  if (
    url.pathname.endsWith("/manifest.webmanifest") ||
    url.pathname.endsWith("/boot.js") ||
    url.pathname.endsWith("/offline.html")
  ) {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(new Request(req, { cache: "no-cache" }));
          if (isCacheableResponse(fresh)) {
            await safeCachePut(SHELL_CACHE, req, fresh.clone());
          }
          return fresh;
        } catch {
          try {
            const shell = await caches.open(SHELL_CACHE);
            const cached = await shell.match(req, { ignoreVary: true });
            return cached || Response.error();
          } catch {
            return Response.error();
          }
        }
      })()
    );
    return;
  }

  // Hashed static assets, fonts, icons & lazy OCR/ASR runtime modules: cache-first in current version caches only
  event.respondWith(
    (async () => {
      try {
        const shell = await caches.open(SHELL_CACHE);
        const fromShell = await shell.match(req, { ignoreVary: true });
        if (fromShell) return fromShell;

        const runtime = await caches.open(RUNTIME_CACHE);
        const fromRuntime = await runtime.match(req, { ignoreVary: true });
        if (fromRuntime) return fromRuntime;
      } catch {
        /* Proceed to network if Cache Storage read throws */
      }

      try {
        const res = await fetch(req);
        if (isCacheableResponse(res)) {
          await safeCachePut(RUNTIME_CACHE, req, res.clone());
        }
        return res;
      } catch {
        return Response.error();
      }
    })()
  );
});
