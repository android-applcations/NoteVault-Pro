import { expect, test, type Page } from "@playwright/test";

const english = (page: Page) => page.addInitScript(() => { if (!localStorage.getItem("nv-prefs")) localStorage.setItem("nv-prefs", JSON.stringify({ lang: "en", theme: "light" })); });

// Modals animate in (spring); wait for the dialog to settle, then press its Save button.
async function saveDialog(page: Page) {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(600);
  await dialog.getByRole("button", { name: "Save", exact: true }).click({ force: true });
  await expect(dialog).toBeHidden();
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

  // subject + lecture
  await page.getByRole("link", { name: "Subjects", exact: true }).first().click();
  await page.getByRole("button", { name: "New subject" }).first().click();
  await page.getByLabel("Subject name").fill("Biology 101");
  await saveDialog(page);
  await page.getByRole("link", { name: /Biology 101/ }).first().click();
  await page.getByRole("button", { name: "Lecture" }).first().click();
  await page.getByLabel("Lecture title").fill("Cell structure");
  await saveDialog(page);
  await expect(page.getByText("Cell structure")).toBeVisible();

  // note with autosave
  await page.getByRole("link", { name: "Notes", exact: true }).first().click();
  await page.getByRole("button", { name: "New note" }).first().click();
  await page.getByRole("button", { name: /Blank note/ }).click();
  await page.getByLabel("Note title").fill("Cells");
  const editor = page.locator(".ProseMirror");
  await editor.click();
  await page.keyboard.type("الخَلِيَّةُ هي وحدة البناء. Mitochondria are the powerhouse.");
  await expect(page.getByText("Unsaved changes…").or(page.getByText("Saving…")).or(page.getByText("Saved")).first()).toBeVisible();
  await page.waitForTimeout(1800); // debounce + IndexedDB transaction
  await page.reload();
  await expect(page.locator(".ProseMirror")).toContainText("Mitochondria are the powerhouse");

  // search (Arabic without diacritics + English partial)
  await page.goto("/#/search?q=الخلية");
  await expect(page.getByRole("list", { name: "Search results" })).toContainText("Cells");
  await page.goto("/#/search?q=powerh");
  await expect(page.getByRole("list", { name: "Search results" })).toContainText("Cells");

  // PDF upload + viewer + search inside file
  await page.goto("/#/library");
  await page.locator('input[type="file"]').first().setInputFiles({ name: "sample.pdf", mimeType: "application/pdf", buffer: minimalPdf("Hello Offline PDF") });
  await expect(page.getByText("sample.pdf").first()).toBeVisible();
  await page.getByRole("button", { name: "sample.pdf" }).first().click();
  await expect(page.locator(".pdf-page canvas").first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("/ 1")).toBeVisible();
  await page.getByRole("button", { name: "Search in file" }).click();
  await page.getByLabel("Search in file").last().fill("offline");
  await expect(page.getByText("p. 1")).toBeVisible({ timeout: 15000 });

  // fake file is rejected
  await page.goto("/#/library");
  await page.locator('input[type="file"]').first().setInputFiles({ name: "fake.pdf", mimeType: "application/pdf", buffer: Buffer.from("<html>not a pdf</html>") });
  await expect(page.getByText(/does not match its type/)).toBeVisible();

  // flashcards: create + review
  await page.goto("/#/flashcards");
  await page.getByRole("button", { name: "Card", exact: true }).click();
  await page.getByLabel("Question").fill("What is the powerhouse of the cell?");
  await page.getByLabel("Answer").fill("Mitochondria");
  await saveDialog(page);
  await page.getByRole("button", { name: /Review all due/ }).click();
  await page.getByRole("button", { name: /Show answer/ }).click();
  await expect(page.getByText("Mitochondria").first()).toBeVisible();
  await page.getByRole("button", { name: /Good/ }).click();
  await expect(page.getByText("Session complete!")).toBeVisible();
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
  // create and edit a note while offline
  await page.getByRole("button", { name: "New note" }).first().click();
  await page.getByLabel("Note title").fill("Offline note");
  await page.locator(".ProseMirror").click();
  await page.keyboard.type("written without network");
  await page.waitForTimeout(1800);
  await page.reload();
  await expect(page.locator(".ProseMirror")).toContainText("written without network");
});
