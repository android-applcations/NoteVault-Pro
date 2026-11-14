// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/data/db";
import Semesters from "@/pages/Semesters";
import { AppProvider } from "@/ui/app-context";
import { I18nProvider } from "@/ui/i18n";

function renderSemesters(lang: "ar" | "en" = "ar") {
  localStorage.setItem("nv-prefs", JSON.stringify({ lang, theme: "light", reduceMotion: true }));
  return render(
    <MotionConfig reducedMotion="always">
      <I18nProvider>
        <AppProvider>
          <MemoryRouter>
            <Semesters />
          </MemoryRouter>
        </AppProvider>
      </I18nProvider>
    </MotionConfig>
  );
}

describe("Semesters creation modal stability (no jitter / focus loss)", () => {
  beforeEach(async () => {
    await db.open();
    await Promise.all(db.tables.map((t) => t.clear()));
    document.body.style.overflow = "";
  });

  afterEach(async () => {
    cleanup();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    document.body.style.overflow = "";
  });

  it("keeps focus, DOM node identity, and body overflow lock stable on every Arabic and English keystroke", async () => {
    renderSemesters("ar");
    const openBtn = await screen.findByRole("button", { name: "فصل جديد" });
    openBtn.focus();
    fireEvent.click(openBtn);

    const dialog = await screen.findByRole("dialog");
    const nameInput = screen.getByLabelText("اسم الفصل") as HTMLInputElement;
    // Wait once for modal initial autofocus
    await waitFor(() => expect(document.activeElement).toBe(nameInput), { timeout: 1000 });
    expect(document.body.style.overflow).toBe("hidden");

    const spyFocus = vi.spyOn(nameInput, "focus");
    const arabicSample = "الفصل الأول 2026 - علوم الحاسوب";
    let acc = "";
    for (const ch of arabicSample) {
      acc += ch;
      fireEvent.change(nameInput, { target: { value: acc } });
      expect(screen.getByRole("dialog")).toBe(dialog);
      expect(screen.getByLabelText("اسم الفصل")).toBe(nameInput);
      expect(document.activeElement).toBe(nameInput);
      expect(document.body.style.overflow).toBe("hidden");
    }
    // Re-focus timer must NEVER re-run during typing
    expect(spyFocus).not.toHaveBeenCalled();
    expect(nameInput.value).toBe(arabicSample);

    // Double-click create creates only ONE record cleanly
    const createBtn = screen.getByRole("button", { name: "إنشاء" });
    fireEvent.click(createBtn);
    fireEvent.click(createBtn);

    await waitFor(async () => {
      const rows = await db.semesters.toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe(arabicSample);
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.style.overflow).toBe("");
    await waitFor(() => expect(document.activeElement).toBe(openBtn));
  });

  it("handles empty validation, cancel, reopen clean reset, and English typing cleanly", async () => {
    renderSemesters("en");
    const openBtn = await screen.findByRole("button", { name: "New semester" });
    fireEvent.click(openBtn);

    const nameInput = (await screen.findByLabelText("Name")) as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(nameInput));

    // Empty name should NOT save or close modal
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await db.semesters.count()).toBe(0);
    expect(screen.getByRole("dialog")).toBeTruthy();

    // Type text then Cancel -> Reopen resets cleanly
    fireEvent.change(nameInput, { target: { value: "Temporary Draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(openBtn);
    const freshInput = (await screen.findByLabelText("Name")) as HTMLInputElement;
    expect(freshInput.value).toBe("");
    await waitFor(() => expect(document.activeElement).toBe(freshInput));

    let en = "";
    for (const ch of "Spring Semester 2027") {
      en += ch;
      fireEvent.change(freshInput, { target: { value: en } });
      expect(document.activeElement).toBe(freshInput);
    }
    fireEvent.submit(freshInput.closest("form")!);

    await waitFor(async () => {
      const rows = await db.semesters.toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe("Spring Semester 2027");
    });
  });
});
