import { expect, test, type Page } from "@playwright/test";

const english = (page: Page) =>
  page.addInitScript(() => {
    if (!localStorage.getItem("nv-prefs")) localStorage.setItem("nv-prefs", JSON.stringify({ lang: "en", theme: "light" }));
  });

async function saveDialog(page: Page) {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const btn = dialog.getByRole("button", { name: "Save", exact: true });
  await expect(btn).toBeEnabled();
  await page.waitForTimeout(350);
  await btn.click();
  await expect(dialog).toBeHidden();
}

async function readIdbStore<T = Record<string, unknown>>(page: Page, storeName: string): Promise<T[]> {
  return page.evaluate((name) => {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("notevault-pro");
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(name)) {
          db.close();
          resolve([]);
          return;
        }
        const tx = db.transaction(name, "readonly");
        const getAll = tx.objectStore(name).getAll();
        getAll.onerror = () => {
          db.close();
          reject(getAll.error);
        };
        getAll.onsuccess = () => {
          const res = getAll.result;
          db.close();
          resolve(res);
        };
      };
    });
  }, storeName);
}

function minimalPdf(text: string) {
  const content = `BT /F1 24 Tf 20 100 Td (${text}) Tj ET`;
  const body = `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length ${content.length}>>stream\n${content}\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R/Size 6>>\n%%EOF`;
  return Buffer.from(body);
}

test.setTimeout(120_000);
test("subjects, lectures, notes (autosave + reload), Arabic search, PDF, flashcards", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await english(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /All your lectures/ })).toBeVisible();

  // 1. Create subject & verify real IndexedDB persistence
  await page.getByRole("link", { name: "Subjects", exact: true }).first().click();
  await page.getByRole("button", { name: "New subject" }).first().click();
  await page.getByLabel("Subject name").fill("Biology 101");
  await saveDialog(page);
  await expect.poll(async () => {
    const subjects = await readIdbStore<{ name: string; deletedAt?: number }>(page, "subjects");
    return subjects.some((s) => s.name === "Biology 101" && !s.deletedAt);
  }).toBe(true);

  // 2. Create lecture & verify UI + real IndexedDB persistence
  await page.getByRole("link", { name: /Biology 101/ }).first().click();
  await page.getByRole("button", { name: "Lecture" }).first().click();
  await page.getByLabel("Lecture title").fill("Cell structure");
  await saveDialog(page);
  await expect(page.getByText("Cell structure")).toBeVisible();
  await expect.poll(async () => {
    const lectures = await readIdbStore<{ title: string; deletedAt?: number }>(page, "lectures");
    return lectures.some((l) => l.title === "Cell structure" && !l.deletedAt);
  }).toBe(true);

  // 3. Create note + autosave + verify IndexedDB BEFORE reload + reload restore
  await page.getByRole("link", { name: "Notes", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Notes", exact: true })).toBeVisible();
  await page.getByRole("main").getByRole("button", { name: "New note" }).first().click();
  await page.getByRole("button", { name: /Blank note/ }).click();
  await page.getByLabel("Note title").fill("Cells");
  const editor = page.locator(".ProseMirror");
  await editor.click();
  await page.keyboard.type("الخَلِيَّةُ هي وحدة البناء. Mitochondria are the powerhouse.");
  await expect(page.getByText("Saved").first()).toBeVisible({ timeout: 5000 });
  await expect.poll(async () => {
    const notes = await readIdbStore<{ title: string; text: string }>(page, "notes");
    return notes.some((n) => n.title === "Cells" && n.text.includes("Mitochondria are the powerhouse"));
  }).toBe(true);

  await page.reload();
  await expect(page.locator(".ProseMirror")).toContainText("Mitochondria are the powerhouse");
  await expect.poll(async () => {
    const notes = await readIdbStore<{ title: string; text: string }>(page, "notes");
    return notes.some((n) => n.title === "Cells" && n.text.includes("Mitochondria are the powerhouse"));
  }).toBe(true);

  // 4. Search (Arabic without diacritics + English partial) + verify searchIndex in IndexedDB
  await expect.poll(async () => {
    const idx = await readIdbStore<{ title: string }>(page, "searchIndex");
    return idx.some((d) => d.title === "Cells");
  }).toBe(true);
  await page.goto("/#/search?q=الخلية");
  await expect(page.getByRole("list", { name: "Search results" })).toContainText("Cells");
  await page.goto("/#/search?q=powerh");
  await expect(page.getByRole("list", { name: "Search results" })).toContainText("Cells");

  // 5. PDF upload + IndexedDB persistence + viewer + search inside file
  await page.goto("/#/library");
  await page.locator('input[type="file"]').first().setInputFiles({ name: "sample.pdf", mimeType: "application/pdf", buffer: minimalPdf("Hello Offline PDF") });
  await expect(page.getByText("sample.pdf").first()).toBeVisible();
  await expect.poll(async () => {
    const atts = await readIdbStore<{ id: string; name: string }>(page, "attachments");
    const pdfs = await readIdbStore<{ id: string; pages: number; pageTexts: string[] }>(page, "pdfDocuments");
    const blobs = await readIdbStore<{ id: string }>(page, "blobs");
    const att = atts.find((a) => a.name === "sample.pdf");
    const pdf = att ? pdfs.find((p) => p.id === att.id) : undefined;
    return Boolean(att && blobs.length >= 1 && pdf && pdf.pages === 1 && pdf.pageTexts[0]?.includes("Hello Offline PDF"));
  }).toBe(true);

  await page.getByRole("button", { name: "sample.pdf" }).first().click();
  await expect(page.locator(".pdf-page canvas").first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("/ 1")).toBeVisible();
  await page.getByRole("button", { name: "Search in file" }).click();
  await page.getByLabel("Search in file").last().fill("offline");
  await expect(page.getByText("p. 1")).toBeVisible({ timeout: 15000 });

  // 6. Fake file is rejected and NOT stored in IndexedDB
  await page.goto("/#/library");
  const countBeforeFake = (await readIdbStore(page, "attachments")).length;
  await page.locator('input[type="file"]').first().setInputFiles({ name: "fake.pdf", mimeType: "application/pdf", buffer: Buffer.from("<html>not a pdf</html>") });
  await expect(page.getByText(/does not match its type/)).toBeVisible();
  expect((await readIdbStore(page, "attachments")).length).toBe(countBeforeFake);

  // 7. Flashcards: create + verify in IndexedDB + complete review + verify reviewLogs in IndexedDB
  await page.goto("/#/flashcards");
  await page.getByRole("button", { name: "Card", exact: true }).click();
  await page.getByLabel("Question").fill("What is the powerhouse of the cell?");
  await page.getByLabel("Answer").fill("Mitochondria");
  await saveDialog(page);
  await expect.poll(async () => {
    const cards = await readIdbStore<{ front: string }>(page, "flashcards");
    return cards.some((c) => c.front === "What is the powerhouse of the cell?");
  }).toBe(true);

  await page.getByRole("button", { name: /Review all due/ }).click();
  await page.getByRole("button", { name: /Show answer/ }).click();
  await expect(page.getByText("Mitochondria").first()).toBeVisible();
  await page.getByRole("button", { name: /Good/ }).click();
  // FSRS learning step (<20m) re-queues the card in the same session; answer again to graduate
  await page.getByRole("button", { name: /Show answer/ }).click();
  await page.getByRole("button", { name: /Good/ }).click();
  await expect(page.getByText("Session complete!")).toBeVisible();
  await expect.poll(async () => {
    const logs = await readIdbStore<{ cardId: string; rating: number }>(page, "reviewLogs");
    const cards = await readIdbStore<{ front: string; reps: number; successCount: number; due: number }>(page, "flashcards");
    const c = cards.find((x) => x.front === "What is the powerhouse of the cell?");
    return Boolean(logs.length >= 2 && c && c.reps >= 2 && c.successCount >= 2 && c.due > Date.now() + 20 * 60000);
  }).toBe(true);

  expect(errors).toEqual([]);
});

test("works offline after first load (service worker)", async ({ page, context }) => {
  await english(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /All your lectures/ })).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); // now controlled by the service worker
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: /All your lectures/ })).toBeVisible();
  // create and edit a note while offline and confirm real IndexedDB persistence
  await page.getByRole("button", { name: "New note" }).first().click();
  await page.getByLabel("Note title").fill("Offline note");
  await page.locator(".ProseMirror").click();
  await page.keyboard.type("written without network");
  await expect(page.getByText("Saved").first()).toBeVisible({ timeout: 5000 });
  await expect.poll(async () => {
    const notes = await readIdbStore<{ title: string; text: string }>(page, "notes");
    return notes.some((n) => n.title === "Offline note" && n.text.includes("written without network"));
  }).toBe(true);
  await page.reload();
  await expect(page.locator(".ProseMirror")).toContainText("written without network");
  await expect.poll(async () => {
    const notes = await readIdbStore<{ title: string; text: string }>(page, "notes");
    return notes.some((n) => n.title === "Offline note" && n.text.includes("written without network"));
  }).toBe(true);
});
