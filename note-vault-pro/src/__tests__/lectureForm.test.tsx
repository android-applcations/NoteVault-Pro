// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/data/db";
import { createLecture, createSubject } from "@/services/library";
import SubjectPage from "@/pages/SubjectPage";
import { AppProvider } from "@/ui/app-context";
import { I18nProvider } from "@/ui/i18n";
import { LectureForm } from "@/ui/LectureForm";

function wrap(ui: React.ReactNode, initialPath = "/") {
  localStorage.setItem("nv-prefs", JSON.stringify({ lang: "en", theme: "light", reduceMotion: true, textSize: "md" }));
  return render(
    <MotionConfig reducedMotion="always">
      <MemoryRouter initialEntries={[initialPath]}>
        <I18nProvider>
          <AppProvider>{ui}</AppProvider>
        </I18nProvider>
      </MemoryRouter>
    </MotionConfig>
  );
}

describe("LectureForm & SubjectPage lecture creation", () => {
  beforeEach(async () => {
    localStorage.clear();
    await db.delete();
    await db.open();
  });

  afterEach(() => {
    cleanup();
  });

  it("creates and persists a lecture in IndexedDB even when onSaved is NOT provided", async () => {
    const subj = await createSubject({ name: "Anatomy" });
    const onClose = vi.fn();

    wrap(<LectureForm open subjectId={subj.id} onClose={onClose} />);

    const input = await screen.findByLabelText("Lecture title");
    fireEvent.change(input, { target: { value: "Cranial Nerves" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    const rows = await db.lectures.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Cranial Nerves");
    expect(rows[0].subjectId).toBe(subj.id);
    expect(await screen.findByText("Saved")).toBeTruthy();
  });

  it("calls onSaved with the persisted lecture when provided and supports defaultWeek", async () => {
    const subj = await createSubject({ name: "Physics" });
    const onClose = vi.fn();
    const onSaved = vi.fn();

    wrap(<LectureForm open subjectId={subj.id} defaultWeek={4} onClose={onClose} onSaved={onSaved} />);

    fireEvent.change(await screen.findByLabelText("Lecture title"), { target: { value: "Quantum Mechanics" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledTimes(1);
    });
    const savedArg = onSaved.mock.calls[0][0];
    expect(savedArg.title).toBe("Quantum Mechanics");
    expect(savedArg.week).toBe(4);
    const dbRow = await db.lectures.get(savedArg.id);
    expect(dbRow?.title).toBe("Quantum Mechanics");
    expect(dbRow?.week).toBe(4);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("edits an existing lecture without onSaved and updates IndexedDB", async () => {
    const subj = await createSubject({ name: "Math" });
    const lec = await createLecture({ subjectId: subj.id, title: "Linear Algebra I", week: 1 });
    const onClose = vi.fn();

    wrap(<LectureForm open subjectId={subj.id} lecture={lec} onClose={onClose} />);

    fireEvent.change(await screen.findByLabelText("Lecture title"), { target: { value: "Linear Algebra II" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    const updated = await db.lectures.get(lec.id);
    expect(updated?.title).toBe("Linear Algebra II");
  });

  it("keeps modal open, shows error toast, and writes nothing when title is blank", async () => {
    const subj = await createSubject({ name: "Chemistry" });
    const onClose = vi.fn();

    wrap(<LectureForm open subjectId={subj.id} onClose={onClose} />);

    fireEvent.change(await screen.findByLabelText("Lecture title"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Enter a lecture title")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(await db.lectures.count()).toBe(0);
  });

  it("keeps modal open and shows error toast when subject does not exist", async () => {
    const onClose = vi.fn();

    wrap(<LectureForm open subjectId="missing-subject-id" onClose={onClose} />);

    fireEvent.change(await screen.findByLabelText("Lecture title"), { target: { value: "Orphan Lecture" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Subject or lecture was not found")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(await db.lectures.count()).toBe(0);
  });

  it("updates SubjectPage views immediately from both EmptyState and week/header buttons", async () => {
    const subj = await createSubject({ name: "Biology 101" });

    wrap(
      <Routes>
        <Route path="/subjects/:id" element={<SubjectPage />} />
      </Routes>,
      `/subjects/${subj.id}`
    );

    // Path 1: EmptyState "Add a lecture" button
    const addEmptyBtn = await screen.findByRole("button", { name: "Add a lecture" });
    fireEvent.click(addEmptyBtn);
    fireEvent.change(await screen.findByLabelText("Lecture title"), { target: { value: "Cell structure" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByText("Cell structure")).toBeTruthy();
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    // Path 2: Week section "Lecture" button (creates in Week 1)
    const lecBtns = screen.getAllByRole("button", { name: "Lecture" });
    fireEvent.click(lecBtns[lecBtns.length - 1]);
    fireEvent.change(await screen.findByLabelText("Lecture title"), { target: { value: "Membrane transport" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByText("Membrane transport")).toBeTruthy();
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    // Path 3: Switch to List / Cards / Timeline views and confirm both lectures appear
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(screen.getByText("Cell structure")).toBeTruthy();
    expect(screen.getByText("Membrane transport")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cards" }));
    expect(screen.getByText("Cell structure")).toBeTruthy();
    expect(screen.getByText("Membrane transport")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Timeline" }));
    expect(screen.getByText("Cell structure")).toBeTruthy();
    expect(screen.getByText("Membrane transport")).toBeTruthy();

    // Verify real IndexedDB state
    const stored = await db.lectures.where("subjectId").equals(subj.id).toArray();
    expect(stored.map((l) => l.title).sort()).toEqual(["Cell structure", "Membrane transport"]);
  });
});
