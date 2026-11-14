# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: app.spec.ts >> subjects, lectures, notes (autosave + reload), Arabic search, PDF, flashcards
- Location: e2e/app.spec.ts:21:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByText('Cell structure')
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" getByText('Cell structure') with timeout 5000ms
  - waiting for getByText('Cell structure')

```

```yaml
- link "Skip to content":
  - /url: "#main"
- complementary "Main navigation":
  - text: NoteVault PRO
  - navigation:
    - link "Home":
      - /url: "#/"
    - link "Subjects":
      - /url: "#/subjects"
    - link "Notes":
      - /url: "#/notes"
    - link "Library":
      - /url: "#/library"
    - link "Flashcards":
      - /url: "#/flashcards"
    - link "Quizzes":
      - /url: "#/quizzes"
    - link "References":
      - /url: "#/references"
    - link "Calendar":
      - /url: "#/calendar"
    - link "Semesters":
      - /url: "#/semesters"
    - link "Trash":
      - /url: "#/trash"
    - link "Settings":
      - /url: "#/settings"
  - button "Collapse sidebar"
- banner:
  - search:
    - textbox "Universal search":
      - /placeholder: Search everything… (Ctrl+K)
  - button "Quick capture (Alt+N)"
  - button "Switch language"
  - button "Toggle theme"
- main:
  - link "Subjects":
    - /url: "#/subjects"
  - button "Edit"
  - heading "Biology 101" [level=1]
  - paragraph
  - text: 0 Lectures 0 Notes 0 Files 0 Cards 0% Completion — Last activity
  - progressbar
  - tablist:
    - tab "Lectures 0" [selected]
    - tab "Notes 0"
    - tab "Files 0"
    - tab "Cards 0"
  - group "View mode":
    - button "Weekly" [pressed]
    - button "List"
    - button "Cards"
    - button "Timeline"
  - button "By date" [pressed]
  - button "By last update"
  - button "Archived"
  - button "Week"
  - button "Lecture"
  - heading "No lectures yet" [level=3]
  - button "Add a lecture"
- button "New note"
- status
```

# Test source

```ts
  1   | import { expect, test, type Page } from "@playwright/test";
  2   | 
  3   | const english = (page: Page) => page.addInitScript(() => { if (!localStorage.getItem("nv-prefs")) localStorage.setItem("nv-prefs", JSON.stringify({ lang: "en", theme: "light" })); });
  4   | 
  5   | // Modals animate in (spring); wait for the dialog to settle, then press its Save button.
  6   | async function saveDialog(page: Page) {
  7   |   const dialog = page.getByRole("dialog");
  8   |   await expect(dialog).toBeVisible();
  9   |   await page.waitForTimeout(600);
  10  |   await dialog.getByRole("button", { name: "Save", exact: true }).click({ force: true });
  11  |   await expect(dialog).toBeHidden();
  12  | }
  13  | 
  14  | function minimalPdf(text: string) {
  15  |   const content = `BT /F1 24 Tf 20 100 Td (${text}) Tj ET`;
  16  |   const body = `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length ${content.length}>>stream\n${content}\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R/Size 6>>\n%%EOF`;
  17  |   return Buffer.from(body);
  18  | }
  19  | 
  20  | test.setTimeout(120_000);
  21  | test("subjects, lectures, notes (autosave + reload), Arabic search, PDF, flashcards", async ({ page }) => {
  22  |   const errors: string[] = [];
  23  |   page.on("pageerror", (e) => errors.push(e.message));
  24  |   await english(page);
  25  |   await page.setViewportSize({ width: 1280, height: 900 });
  26  |   await page.goto("/");
  27  |   await expect(page.getByRole("heading", { name: /All your lectures/ })).toBeVisible();
  28  | 
  29  |   // subject + lecture
  30  |   await page.getByRole("link", { name: "Subjects", exact: true }).first().click();
  31  |   await page.getByRole("button", { name: "New subject" }).first().click();
  32  |   await page.getByLabel("Subject name").fill("Biology 101");
  33  |   await saveDialog(page);
  34  |   await page.getByRole("link", { name: /Biology 101/ }).first().click();
  35  |   await page.getByRole("button", { name: "Lecture" }).first().click();
  36  |   await page.getByLabel("Lecture title").fill("Cell structure");
  37  |   await saveDialog(page);
> 38  |   await expect(page.getByText("Cell structure")).toBeVisible();
      |                                                  ^ Error: expect(locator).toBeVisible() failed
  39  | 
  40  |   // note with autosave
  41  |   await page.getByRole("link", { name: "Notes", exact: true }).first().click();
  42  |   await page.getByRole("button", { name: "New note" }).first().click();
  43  |   await page.getByRole("button", { name: /Blank note/ }).click();
  44  |   await page.getByLabel("Note title").fill("Cells");
  45  |   const editor = page.locator(".ProseMirror");
  46  |   await editor.click();
  47  |   await page.keyboard.type("الخَلِيَّةُ هي وحدة البناء. Mitochondria are the powerhouse.");
  48  |   await expect(page.getByText("Unsaved changes…").or(page.getByText("Saving…")).or(page.getByText("Saved")).first()).toBeVisible();
  49  |   await page.waitForTimeout(1800); // debounce + IndexedDB transaction
  50  |   await page.reload();
  51  |   await expect(page.locator(".ProseMirror")).toContainText("Mitochondria are the powerhouse");
  52  | 
  53  |   // search (Arabic without diacritics + English partial)
  54  |   await page.goto("/#/search?q=الخلية");
  55  |   await expect(page.getByRole("list", { name: "Search results" })).toContainText("Cells");
  56  |   await page.goto("/#/search?q=powerh");
  57  |   await expect(page.getByRole("list", { name: "Search results" })).toContainText("Cells");
  58  | 
  59  |   // PDF upload + viewer + search inside file
  60  |   await page.goto("/#/library");
  61  |   await page.locator('input[type="file"]').first().setInputFiles({ name: "sample.pdf", mimeType: "application/pdf", buffer: minimalPdf("Hello Offline PDF") });
  62  |   await expect(page.getByText("sample.pdf").first()).toBeVisible();
  63  |   await page.getByRole("button", { name: "sample.pdf" }).first().click();
  64  |   await expect(page.locator(".pdf-page canvas").first()).toBeVisible({ timeout: 15000 });
  65  |   await expect(page.getByText("/ 1")).toBeVisible();
  66  |   await page.getByRole("button", { name: "Search in file" }).click();
  67  |   await page.getByLabel("Search in file").last().fill("offline");
  68  |   await expect(page.getByText("p. 1")).toBeVisible({ timeout: 15000 });
  69  | 
  70  |   // fake file is rejected
  71  |   await page.goto("/#/library");
  72  |   await page.locator('input[type="file"]').first().setInputFiles({ name: "fake.pdf", mimeType: "application/pdf", buffer: Buffer.from("<html>not a pdf</html>") });
  73  |   await expect(page.getByText(/does not match its type/)).toBeVisible();
  74  | 
  75  |   // flashcards: create + review
  76  |   await page.goto("/#/flashcards");
  77  |   await page.getByRole("button", { name: "Card", exact: true }).click();
  78  |   await page.getByLabel("Question").fill("What is the powerhouse of the cell?");
  79  |   await page.getByLabel("Answer").fill("Mitochondria");
  80  |   await saveDialog(page);
  81  |   await page.getByRole("button", { name: /Review all due/ }).click();
  82  |   await page.getByRole("button", { name: /Show answer/ }).click();
  83  |   await expect(page.getByText("Mitochondria").first()).toBeVisible();
  84  |   await page.getByRole("button", { name: /Good/ }).click();
  85  |   await expect(page.getByText("Session complete!")).toBeVisible();
  86  |   expect(errors).toEqual([]);
  87  | });
  88  | 
  89  | test("works offline after first load (service worker)", async ({ page, context }) => {
  90  |   await english(page);
  91  |   await page.goto("/");
  92  |   await expect(page.getByRole("heading", { name: /All your lectures/ })).toBeVisible();
  93  |   await page.evaluate(() => navigator.serviceWorker.ready);
  94  |   await page.reload(); // now controlled by the service worker
  95  |   await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  96  |   await context.setOffline(true);
  97  |   await page.reload();
  98  |   await expect(page.getByRole("heading", { name: /All your lectures/ })).toBeVisible();
  99  |   // create and edit a note while offline
  100 |   await page.getByRole("button", { name: "New note" }).first().click();
  101 |   await page.getByLabel("Note title").fill("Offline note");
  102 |   await page.locator(".ProseMirror").click();
  103 |   await page.keyboard.type("written without network");
  104 |   await page.waitForTimeout(1800);
  105 |   await page.reload();
  106 |   await expect(page.locator(".ProseMirror")).toContainText("written without network");
  107 | });
  108 | 
```