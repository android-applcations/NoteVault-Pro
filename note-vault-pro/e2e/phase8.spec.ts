import { expect, test } from "@playwright/test";

function buildSinglePagePdf(text: string): Buffer {
  const stream = `BT /F1 20 Tf 30 300 Td (${text}) Tj ET`;
  const objs: string[] = [
    "",
    `1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n`,
    `2 0 obj<</Type/Pages/Kids[4 0 R]/Count 1>>endobj\n`,
    `3 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n`,
    `4 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 500]/Contents 5 0 R/Resources<</Font<</F1 3 0 R>>>>>>endobj\n`,
    `5 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream endobj\n`,
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let id = 1; id < objs.length; id++) {
    offsets[id] = body.length;
    body += objs[id];
  }
  const xrefPos = body.length;
  body += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objs.length; id++) {
    body += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer<</Root 1 0 R/Size ${objs.length}>>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(body);
}

test.setTimeout(120_000);

test("Phase 8: KaTeX formulas in flashcards & editor, coordinate PDF highlights, and offline OCR", async ({ page }) => {
  const cspViolations: string[] = [];
  const externalRequests: string[] = [];
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (/^(http:\/\/(127\.0\.0\.1|localhost):\d+|data:|blob:)/.test(url)) {
      return route.continue();
    }
    externalRequests.push(url);
    return route.abort();
  });
  await page.addInitScript(() => {
    localStorage.setItem("nv-prefs", JSON.stringify({ lang: "en", theme: "light" }));
    window.addEventListener("securitypolicyviolation", (e) => {
      const w = window as unknown as { __cspViolations?: string[] };
      w.__cspViolations = w.__cspViolations ?? [];
      w.__cspViolations.push(`${e.violatedDirective}:${e.blockedURI}`);
    });
  });

  // 1. KaTeX math in Flashcards + Note Editor
  await page.goto("/#/flashcards");
  await page.getByRole("button", { name: "Card", exact: true }).click();
  await page.getByLabel("Card type").selectOption("formula");
  await page.getByLabel("Formula name / question").fill("Energy relation $E = mc^2$");
  await page.getByLabel("Answer").fill("\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}");
  await page.getByRole("button", { name: "Save" }).click();

  await page.getByRole("tab", { name: /Cards/ }).click();
  await expect(page.locator(".katex").first()).toBeVisible({ timeout: 10000 });

  await page.goto("/#/notes");
  await expect(page.getByRole("heading", { name: "Notes", exact: true })).toBeVisible();
  await page.getByRole("main").getByRole("button", { name: "New note" }).first().click();
  await page.getByRole("button", { name: /Blank note/ }).click();
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 10000 });

  await page.getByRole("button", { name: "Math formula" }).click();
  await page.getByLabel("Formula expression").fill("\\int_{0}^{1} x^2\\,dx");
  await expect(page.locator("[role='dialog'] .katex").first()).toBeVisible();
  await page.getByRole("button", { name: "Insert", exact: true }).click();
  await expect(page.locator(".ProseMirror span[data-formula]")).toContainText("\\int_{0}^{1}");

  // 2. Coordinate-based PDF visual highlights + scale & reload persistence
  await page.goto("/#/library");
  await page.locator('input[type="file"]').first().setInputFiles({
    name: "highlight-demo.pdf",
    mimeType: "application/pdf",
    buffer: buildSinglePagePdf("HighlightTarget 2026"),
  });
  await page.getByRole("button", { name: "highlight-demo.pdf" }).first().click();
  const textSpan = page.locator('.pdf-page[data-page="1"] .textLayer span').filter({ hasText: "HighlightTarget" }).first();
  await expect(textSpan).toBeVisible({ timeout: 15000 });

  await page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll('.pdf-page[data-page="1"] .textLayer span'));
    const target = spans.find((s) => s.textContent?.includes("HighlightTarget"));
    if (!target) throw new Error("Missing PDF text span");
    const range = document.createRange();
    range.selectNodeContents(target);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  });

  await page.getByRole("button", { name: "Highlight color #86efac" }).click();
  await page.getByRole("button", { name: "Highlight selected text" }).click();

  const overlay = page.locator('.pdf-page[data-page="1"] span[style*="rgb(134, 239, 172)"]').first();
  await expect(overlay).toBeVisible({ timeout: 10000 });
  const initialStyle = await overlay.getAttribute("style");
  expect(initialStyle).toContain("%");

  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(overlay).toBeVisible();
  await page.reload();
  await expect(page.locator('.pdf-page[data-page="1"] span[style*="rgb(134, 239, 172)"]').first()).toBeVisible({ timeout: 15000 });

  // 3. Offline Tesseract OCR inside FileViewer ImageView
  await page.goto("/#/library");
  const pngBytes = await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 720;
    c.height = 180;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = "#000000";
    ctx.font = "bold 64px sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText("NOTEVAULT 2026", 48, 90);
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), "image/png"));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });

  await page.locator('input[type="file"]').first().setInputFiles({
    name: "ocr-sample.png",
    mimeType: "image/png",
    buffer: Buffer.from(pngBytes),
  });
  await page.getByRole("button", { name: "ocr-sample.png" }).first().click();
  await expect(page.getByLabel("Text language")).toBeVisible({ timeout: 10000 });
  await page.getByLabel("Text language").selectOption("eng");
  await page.getByRole("button", { name: "Extract text" }).click();

  const ocrArea = page.locator("textarea").first();
  await expect(ocrArea).toBeVisible({ timeout: 45000 });
  const extracted = await ocrArea.inputValue();
  expect(extracted.toUpperCase()).toMatch(/NOTEVAULT|2026/);

  const pageViolations = await page.evaluate(() => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? []);
  cspViolations.push(...pageViolations);
  expect(cspViolations).toEqual([]);
  expect(externalRequests).toEqual([]);
});
