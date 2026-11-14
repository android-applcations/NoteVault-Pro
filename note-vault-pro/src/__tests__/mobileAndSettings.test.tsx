// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/data/db";
import type { LectureRecording } from "@/data/types";
import Settings from "@/pages/Settings";
import { AppProvider } from "@/ui/app-context";
import { I18nProvider } from "@/ui/i18n";
import { Shell } from "@/ui/Shell";
import { TranscriptPanel } from "@/ui/TranscriptPanel";

const ROOT = path.resolve(__dirname, "..", "..");

function wrap(ui: React.ReactNode, lang: "ar" | "en" = "ar") {
  localStorage.setItem("nv-prefs", JSON.stringify({ lang, theme: "light", reduceMotion: true }));
  return render(
    <MotionConfig reducedMotion="always">
      <I18nProvider>
        <AppProvider>
          <MemoryRouter>{ui}</MemoryRouter>
        </AppProvider>
      </I18nProvider>
    </MotionConfig>
  );
}

describe("Mobile/iPad experience, zoom/selection/status-bar contracts, and Settings cleanup", () => {
  beforeEach(async () => {
    await db.open();
    await Promise.all(db.tables.map((t) => t.clear()));
    document.head.innerHTML = '<meta name="theme-color" content="#f6f4ef" />';
  });

  afterEach(() => {
    cleanup();
  });

  it("enforces viewport zoom lock, standalone status bar, dynamic theme-color, and balanced CSS rules", () => {
    const html = readFileSync(path.join(ROOT, "index.html"), "utf8");
    expect(html).toContain(
      'content="width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no, viewport-fit=cover"'
    );
    expect(html).toContain('<meta name="apple-mobile-web-app-status-bar-style" content="default" />');

    const manifest = JSON.parse(readFileSync(path.join(ROOT, "public/manifest.webmanifest"), "utf8")) as {
      display: string;
    };
    expect(manifest.display).toBe("standalone");

    const boot = readFileSync(path.join(ROOT, "public/boot.js"), "utf8");
    expect(boot).toContain('meta[name="theme-color"]');
    expect(boot).toContain("#0d0e1d");
    expect(boot).toContain("#f6f4ef");

    const css = readFileSync(path.join(ROOT, "src/index.css"), "utf8");
    expect(css).toContain("touch-action: pan-x pan-y;");
    expect(css).toContain("overscroll-behavior-y: contain;");
    expect(css).toContain("overflow-x: clip;");
    expect(css).toContain("font-size: max(16px, 1em);");
    expect(css).toContain("user-select: none;");
    expect(css).toContain("user-select: text;");
    expect(css).toContain(".ProseMirror");
    expect(css).toContain(".textLayer");
    expect(css).toContain(".nv-selectable");

    const pdfViewer = readFileSync(path.join(ROOT, "src/pages/PdfViewer.tsx"), "utf8");
    expect(pdfViewer).not.toMatch(/requestFullscreen|exitFullscreen|fullscreenElement|fullscreenchange/);
  });

  it("removes Install and Privacy UI sections and technical jargon from Settings while keeping all controls functional", async () => {
    wrap(<Settings />, "ar");
    await screen.findByRole("heading", { name: "الإعدادات" });

    expect(screen.queryByRole("heading", { name: "التثبيت على الجهاز" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "الخصوصية" })).toBeNull();
    expect(screen.queryByText(/تخزين المتصفح|SHA-256|Whisper|Safari|Chrome/)).toBeNull();

    expect(screen.getByRole("heading", { name: "مساحة التخزين" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "النسخ الاحتياطي والاستعادة" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "التفريغ الصوتي للمحاضرات" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "تصدير نسخة كاملة" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "فحص سلامة البيانات" })).toBeTruthy();

    // Toggling dark mode syncs <meta name="theme-color"> dynamically
    fireEvent.click(screen.getByRole("button", { name: "ليلي" }));
    await waitFor(() => {
      expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#0d0e1d");
    });

    cleanup();
    wrap(<Settings />, "en");
    await screen.findByRole("heading", { name: "Settings" });
    expect(screen.queryByRole("heading", { name: "Install on your device" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Privacy" })).toBeNull();
    expect(screen.queryByText(/browser storage|SHA-256|Whisper|Add to Home Screen/i)).toBeNull();
    expect(screen.getByRole("heading", { name: "Lecture Transcription" })).toBeTruthy();
  });

  it("renders clean non-technical Transcription empty copy and responsive Shell chrome", async () => {
    const rec: LectureRecording = {
      id: "rec-test",
      subjectId: "s1",
      lectureId: "l1",
      attachmentId: "att1",
      title: "Lecture 1",
      mime: "audio/webm",
      ext: "webm",
      durationMs: 12000,
      totalBytes: 2048,
      chunkCount: 1,
      status: "ready",
      transcriptionStatus: "idle",
      transcriptionLang: "auto",
      transcriptionProgress: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    wrap(
      <Shell>
        <TranscriptPanel recording={rec} currentTimeMs={0} onSeekMs={() => undefined} />
      </Shell>,
      "en"
    );

    expect(await screen.findByRole("heading", { name: "Transcription" })).toBeTruthy();
    expect(screen.getByText("Transcription is not ready yet")).toBeTruthy();
    expect(screen.queryByText(/Whisper|SHA-256|16kHz|in your browser/i)).toBeNull();
  });
});
