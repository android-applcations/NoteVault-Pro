import { expect, test } from "@playwright/test";

function buildMultiPagePdf(pagesText: string[]): Buffer {
  const objs: string[] = [];
  const pageIds: number[] = [];
  for (let i = 0; i < pagesText.length; i++) {
    const pageObjId = 4 + i * 2;
    const contentObjId = 5 + i * 2;
    pageIds.push(pageObjId);
    const stream = `BT /F1 20 Tf 20 120 Td (${pagesText[i]}) Tj ET`;
    objs[pageObjId] = `${pageObjId} 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 400]/Contents ${contentObjId} 0 R/Resources<</Font<</F1 3 0 R>>>>>>endobj\n`;
    objs[contentObjId] = `${contentObjId} 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream endobj\n`;
  }
  objs[1] = `1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n`;
  objs[2] = `2 0 obj<</Type/Pages/Kids[${pageIds.map((id) => `${id} 0 R`).join(" ")}]/Count ${pagesText.length}>>endobj\n`;
  objs[3] = `3 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n`;

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

test.setTimeout(90_000);

test("PDF viewer uses true virtual scrolling, releases offscreen pages, and persists lastPage & zoom", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("nv-prefs", JSON.stringify({ lang: "en", theme: "light" }));
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/#/library");

  const texts = Array.from({ length: 60 }, (_, i) => `Virtual Page ${i + 1} Token${i + 1}`);
  await page.locator('input[type="file"]').first().setInputFiles({
    name: "sixty-pages.pdf",
    mimeType: "application/pdf",
    buffer: buildMultiPagePdf(texts),
  });

  await expect(page.getByText("sixty-pages.pdf").first()).toBeVisible();
  await page.getByRole("button", { name: "sixty-pages.pdf" }).first().click();

  await expect(page.getByText("/ 60")).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.pdf-page[data-page="1"] canvas')).toBeVisible({ timeout: 15000 });

  // True virtualization: far fewer than 60 .pdf-page nodes mounted in the DOM!
  const mountedCountInitial = await page.locator(".pdf-page").count();
  expect(mountedCountInitial).toBeGreaterThanOrEqual(1);
  expect(mountedCountInitial).toBeLessThanOrEqual(10);

  // Jump to page 48 and zoom in
  const pageInput = page.getByLabel("Page number");
  await pageInput.fill("48");
  await pageInput.press("Enter");
  await expect(page.locator('.pdf-page[data-page="48"] canvas')).toBeVisible({ timeout: 15000 });
  expect(await page.locator('.pdf-page[data-page="1"]').count()).toBe(0);

  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(page.getByText("135%")).toBeVisible();

  // Wait for debounced savePdfView and reload to confirm lastPage & zoom restoration
  await page.waitForTimeout(800);
  await page.reload();
  await expect(page.getByText("/ 60")).toBeVisible({ timeout: 15000 });
  await expect(page.getByLabel("Page number")).toHaveValue("48", { timeout: 10000 });
  await expect(page.getByText("135%")).toBeVisible();
  await expect(page.locator('.pdf-page[data-page="48"] canvas')).toBeVisible({ timeout: 15000 });

  // Search inside PDF for page 55
  await page.getByRole("button", { name: "Search in file" }).click();
  await page.getByLabel("Search in file").last().fill("Token55");
  await expect(page.getByText("p. 55")).toBeVisible({ timeout: 15000 });
});
