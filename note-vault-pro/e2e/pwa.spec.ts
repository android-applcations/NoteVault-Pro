import { expect, test } from "@playwright/test";

test.setTimeout(90_000);

test("PWA manifest, icons, SW lifecycle, offline routes, and IndexedDB durability across updates", async ({ page, context }) => {
  const pageErrors: string[] = [];
  const cspViolations: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.addInitScript(() => {
    if (!localStorage.getItem("nv-prefs")) {
      localStorage.setItem("nv-prefs", JSON.stringify({ lang: "en", theme: "light" }));
    }
    window.addEventListener("securitypolicyviolation", (e) => {
      const w = window as unknown as { __cspViolations?: string[] };
      w.__cspViolations = w.__cspViolations ?? [];
      w.__cspViolations.push(`${e.violatedDirective}:${e.blockedURI}`);
    });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: /All your lectures/ })).toBeVisible();

  // 1 & 2. Verify manifest fields, standalone (never fullscreen), shortcuts, and icon responses
  const manifestRes = await page.request.get("/manifest.webmanifest");
  expect(manifestRes.status()).toBe(200);
  const manifest = (await manifestRes.json()) as {
    id: string;
    name: string;
    short_name: string;
    start_url: string;
    scope: string;
    display: string;
    orientation: string;
    lang: string;
    dir: string;
    prefer_related_applications: boolean;
    icons: Array<{ src: string; sizes?: string; purpose?: string }>;
    shortcuts: Array<{ name: string; url: string; icons: Array<{ src: string }> }>;
  };
  expect(manifest.id).toBe("./");
  expect(manifest.name).toBe("NoteVault Pro");
  expect(manifest.short_name).toBe("NoteVault Pro");
  expect(manifest.display).toBe("standalone");
  expect(manifest.orientation).toBe("any");
  expect(manifest.lang).toBe("ar");
  expect(manifest.dir).toBe("rtl");
  expect(manifest.prefer_related_applications).toBe(false);
  expect(manifest.icons.length).toBeGreaterThanOrEqual(4);
  expect(manifest.shortcuts.some((s) => s.url === "./#/record")).toBe(true);

  for (const ic of [...manifest.icons, ...manifest.shortcuts.flatMap((s) => s.icons)]) {
    const r = await page.request.get(`/${ic.src.replace(/^\.\//, "")}`);
    expect(r.status(), `Icon missing: ${ic.src}`).toBe(200);
    expect((await r.body()).byteLength).toBeGreaterThan(100);
  }
  for (const extra of ["/apple-touch-icon.png", "/boot.js", "/offline.html", "/sw.js"]) {
    const r = await page.request.get(extra);
    expect(r.status(), `Asset missing: ${extra}`).toBe(200);
  }

  // 3, 4 & 5. Wait for SW registration, activation, and shell precache
  const swInfo = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    const sw = reg.active;
    if (sw && sw.state !== "activated") {
      await new Promise<void>((res) => {
        if (sw.state === "activated") return res();
        sw.addEventListener("statechange", () => {
          if (sw.state === "activated") res();
        });
      });
    }
    const keys = await caches.keys();
    const shellKey = keys.find((k) => k.endsWith("-shell"));
    const c = shellKey ? await caches.open(shellKey) : null;
    const cachedUrls = c ? (await c.keys()).map((r) => new URL(r.url).pathname) : [];
    return { active: reg.active?.state, shellKey, cachedCount: cachedUrls.length };
  });
  expect(swInfo.active).toBe("activated");
  expect(swInfo.shellKey).toMatch(/^nv-[a-f0-9]+-shell$/);
  expect(swInfo.cachedCount).toBeGreaterThan(20);

  // Create real user data in IndexedDB (Dexie) before update/offline checks
  await page.goto("/#/subjects");
  await page.getByRole("button", { name: "New subject" }).first().click();
  await page.getByLabel("Subject name").fill("Offline Persistence Check");
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Offline Persistence Check")).toBeVisible();

  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);

  // 7. Trigger safe SW update check without harming IndexedDB
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    await reg?.update();
  });

  // 6 & 16. Go completely offline, navigate ALL routes, and verify IndexedDB data persists
  await context.setOffline(true);
  for (const route of [
    "#/subjects",
    "#/record",
    "#/notes",
    "#/library",
    "#/flashcards",
    "#/quizzes",
    "#/references",
    "#/calendar",
    "#/semesters",
    "#/trash",
    "#/settings",
    "#/more",
  ]) {
    await page.goto(`/${route}`);
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByRole("heading").first()).toBeVisible();
  }
  await page.goto("/#/subjects");
  await expect(page.getByText("Offline Persistence Check")).toBeVisible();

  // Verify Settings renders clean App permissions & preserves removed Install/Privacy exclusions
  await page.goto("/#/settings");
  await expect(page.getByRole("heading", { name: "Appearance & language" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "App permissions" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Backup & restore" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Install on your device" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Privacy" })).toHaveCount(0);

  const recordedCsp = await page.evaluate(() => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? []);
  cspViolations.push(...recordedCsp);
  expect(cspViolations).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("Standalone detection, mic pre-permission, grant, deny, unsupported API, track release, Wake Lock, and zero network requests while recording", async ({ browser, page, context }) => {
  // 8. Standalone display-mode detection
  await page.addInitScript(() => {
    localStorage.setItem("nv-prefs", JSON.stringify({ lang: "en", theme: "light" }));
    const origMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = (q: string) =>
      q === "(display-mode: standalone)"
        ? ({ matches: true, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false } as MediaQueryList)
        : origMatchMedia(q);
  });

  // Track any unexpected network requests during local recording
  const networkWhileRecording: string[] = [];
  let recordingActive = false;
  page.on("request", (req) => {
    if (recordingActive) networkWhileRecording.push(req.url());
  });

  // 9, 10, 13, 14 & 15. Grant mic + verify pre-permission flow, Wake Lock call, zero network during recording, and track stop() release
  await context.grantPermissions(["microphone"]);
  await page.addInitScript(() => {
    const w = window as unknown as {
      __wakeLockReqCount?: number;
      __wakeLockRelCount?: number;
      __tracksStopped?: number;
    };
    w.__wakeLockReqCount = 0;
    w.__wakeLockRelCount = 0;
    w.__tracksStopped = 0;

    if (navigator.mediaDevices?.getUserMedia) {
      const origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (c) => {
        const s = await origGUM(c);
        for (const tr of s.getTracks()) {
          const origStop = tr.stop.bind(tr);
          tr.stop = () => {
            w.__tracksStopped = (w.__tracksStopped ?? 0) + 1;
            origStop();
          };
        }
        return s;
      };
    }
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: {
        request: async () => {
          w.__wakeLockReqCount = (w.__wakeLockReqCount ?? 0) + 1;
          return {
            released: false,
            addEventListener() {},
            release: async () => {
              w.__wakeLockRelCount = (w.__wakeLockRelCount ?? 0) + 1;
            },
          };
        },
      },
    });
  });

  await page.goto("/#/record");
  await expect(page.getByRole("heading", { name: "Record Lecture Audio" })).toBeVisible();

  recordingActive = true;
  await page.getByRole("button", { name: "Record Lecture" }).click();
  const miniBar = page.getByRole("region", { name: "Active lecture recorder" });
  await expect(miniBar).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(1200);
  await miniBar.getByRole("button", { name: "Stop & save" }).click();
  await expect(miniBar).toBeHidden({ timeout: 10_000 });
  recordingActive = false;

  expect(networkWhileRecording).toEqual([]);
  const metrics = await page.evaluate(() => {
    const w = window as unknown as {
      __wakeLockReqCount?: number;
      __wakeLockRelCount?: number;
      __tracksStopped?: number;
    };
    return { req: w.__wakeLockReqCount ?? 0, rel: w.__wakeLockRelCount ?? 0, stopped: w.__tracksStopped ?? 0 };
  });
  expect(metrics.req).toBeGreaterThanOrEqual(1);
  expect(metrics.rel).toBeGreaterThanOrEqual(1);
  expect(metrics.stopped).toBeGreaterThanOrEqual(1);

  // 11. Denied microphone permission -> concise non-looping guidance & Settings reflects live state
  const deniedCtx = await browser.newContext();
  const deniedPage = await deniedCtx.newPage();
  await deniedPage.addInitScript(() => {
    localStorage.setItem("nv-prefs", JSON.stringify({ lang: "en", theme: "light" }));
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          throw new DOMException("Permission denied", "NotAllowedError");
        },
      },
    });
  });
  await deniedPage.goto("/#/record");
  await deniedPage.getByRole("button", { name: "Record Lecture" }).click();
  await expect(deniedPage.getByRole("alert")).toBeVisible();
  await expect(deniedPage.getByText(/Microphone access is not enabled/i)).toBeVisible();
  await deniedCtx.close();

  // 12. Unsupported MediaRecorder/getUserMedia API -> graceful fallback & audio import remains available
  const unsupCtx = await browser.newContext();
  const unsupPage = await unsupCtx.newPage();
  await unsupPage.addInitScript(() => {
    localStorage.setItem("nv-prefs", JSON.stringify({ lang: "en", theme: "light" }));
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
  });
  await unsupPage.goto("/#/record");
  await expect(unsupPage.getByRole("alert")).toBeVisible();
  await expect(unsupPage.getByRole("button", { name: "Import audio file instead" })).toBeVisible();
  await unsupCtx.close();
});

test("Viewport mobile safeguards, standalone manifest, and strict script-src CSP on Android and iPad", async ({ browser }) => {
  for (const [label, ua] of [
    ["android", "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36"],
    ["ipad", "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1"],
  ] as const) {
    const ctx = await browser.newContext({ userAgent: ua });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      localStorage.setItem("nv-prefs", JSON.stringify({ lang: "en", theme: "light" }));
    });
    await page.goto("/#/settings");
    await expect(page.getByRole("heading", { name: "Settings" }), `Settings heading for ${label}`).toBeVisible();
    await expect(page.getByRole("heading", { name: "App permissions" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Install on your device" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Privacy" })).toHaveCount(0);
    const viewport = await page.locator('meta[name="viewport"]').getAttribute("content");
    expect(viewport).toContain("viewport-fit=cover");
    expect(viewport).toContain("user-scalable=no");
    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    await ctx.close();
  }
});
