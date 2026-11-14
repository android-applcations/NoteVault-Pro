import { expect, test } from "@playwright/test";

test.setTimeout(90_000);

const VIEWPORTS = [
  { name: "mobile-320", width: 320, height: 568 },
  { name: "mobile-390", width: 390, height: 844 },
  { name: "ipad-portrait-768", width: 768, height: 1024 },
  { name: "ipad-landscape-1024", width: 1024, height: 768 },
  { name: "ipad-pro-1180", width: 1180, height: 820 },
] as const;

const ROUTES = ["/", "/#/record", "/#/subjects", "/#/notes", "/#/library", "/#/flashcards", "/#/quizzes", "/#/calendar", "/#/semesters", "/#/settings", "/#/more"];

test("Responsive zero-overflow across phone (320px-390px) and iPad (768px-1180px), selection guards, and status bar", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("nv-prefs", JSON.stringify({ lang: "ar", theme: "light" }));
  });

  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    for (const route of ROUTES) {
      await page.goto(route);
      await expect(page.locator("main")).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `Horizontal overflow on ${vp.name} at ${route}`).toBeLessThanOrEqual(1);
    }
  }

  // Verify Settings removed sections & clean copy
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/settings");
  await expect(page.getByRole("heading", { name: "التثبيت على الجهاز" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "الخصوصية" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "التفريغ الصوتي للمحاضرات" })).toBeVisible();

  // Verify dynamic theme-color status-bar sync + standalone manifest
  const lightThemeColor = await page.locator('meta[name="theme-color"]').getAttribute("content");
  expect(lightThemeColor).toBe("#f6f4ef");
  await page.getByRole("button", { name: "ليلي" }).click();
  const darkThemeColor = await page.locator('meta[name="theme-color"]').getAttribute("content");
  expect(darkThemeColor).toBe("#0d0e1d");

  // Verify UI chrome blocks accidental text selection while editor & inputs stay selectable & >=16px
  const styles = await page.evaluate(() => {
    const header = document.querySelector("header")!;
    const searchInput = document.querySelector('input[aria-label]')!;
    const btn = document.querySelector("button")!;
    return {
      headerSelect: getComputedStyle(header).userSelect,
      btnSelect: getComputedStyle(btn).userSelect,
      inputSelect: getComputedStyle(searchInput).userSelect,
      inputFontPx: parseFloat(getComputedStyle(searchInput).fontSize),
    };
  });
  expect(styles.headerSelect).toBe("none");
  expect(styles.btnSelect).toBe("none");
  expect(styles.inputSelect).toBe("text");
  expect(styles.inputFontPx).toBeGreaterThanOrEqual(16);

  // Verify RichEditor note body stays fully selectable on mobile
  await page.goto("/#/notes");
  await page.getByRole("main").getByRole("button").first().click();
  const blankBtn = page.getByRole("button", { name: /ملاحظة فارغة|Blank note/ });
  if (await blankBtn.isVisible()) await blankBtn.click();
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 10_000 });
  const editorSelect = await page.locator(".ProseMirror").evaluate((el) => getComputedStyle(el).userSelect);
  expect(editorSelect).toBe("text");
});
