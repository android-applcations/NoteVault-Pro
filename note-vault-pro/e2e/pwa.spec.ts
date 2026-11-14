import { expect, test } from "@playwright/test";

test.setTimeout(90_000);

test("PWA manifest, icons, CSP (no inline script errors), and full offline route navigation", async ({ page, context }) => {
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

  // Verify manifest & every referenced icon exists and returns 200
  const manifestRes = await page.request.get("/manifest.webmanifest");
  expect(manifestRes.status()).toBe(200);
  const manifest = (await manifestRes.json()) as {
    name: string;
    short_name: string;
    icons: Array<{ src: string; sizes?: string; type?: string }>;
  };
  expect(manifest.name).toBe("NoteVault Pro");
  expect(manifest.icons.length).toBeGreaterThanOrEqual(4);
  for (const ic of manifest.icons) {
    const r = await page.request.get(`/${ic.src.replace(/^\.\//, "")}`);
    expect(r.status(), `Icon missing: ${ic.src}`).toBe(200);
    expect((await r.body()).byteLength).toBeGreaterThan(100);
  }
  for (const extra of ["/apple-touch-icon.png", "/boot.js", "/offline.html", "/sw.js"]) {
    const r = await page.request.get(extra);
    expect(r.status(), `Asset missing: ${extra}`).toBe(200);
  }

  // Wait for SW activated & verify shell cache holds all assets cleanly
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

  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);

  // Go completely offline and visit ALL lazy routes that were NEVER visited online
  await context.setOffline(true);
  for (const route of [
    "#/subjects",
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

  // Verify settings install guidance renders cleanly
  await page.goto("/#/settings");
  await expect(page.getByRole("heading", { name: "Install on your device" })).toBeVisible();

  const recordedCsp = await page.evaluate(() => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? []);
  cspViolations.push(...recordedCsp);

  expect(cspViolations).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("Install guidance on Android and iOS & strict script-src CSP", async ({ browser }) => {
  for (const [label, ua, expected] of [
    ["android", "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36", /On Android \(Chrome\)/],
    ["ios", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1", /On iPhone\/iPad \(Safari\)/],
  ] as const) {
    const ctx = await browser.newContext({ userAgent: ua });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      localStorage.setItem("nv-prefs", JSON.stringify({ lang: "en", theme: "light" }));
    });
    await page.goto("/#/settings");
    await expect(page.getByText(expected), `Install guidance for ${label}`).toBeVisible();
    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    await ctx.close();
  }
});
