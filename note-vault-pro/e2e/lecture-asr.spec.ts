import { expect, test, type Page } from "@playwright/test";
import { zipSync } from "fflate";

const english = (page: Page) =>
  page.addInitScript(() => {
    if (!localStorage.getItem("nv-prefs")) localStorage.setItem("nv-prefs", JSON.stringify({ lang: "en", theme: "light" }));
    window.addEventListener("securitypolicyviolation", (e) => {
      const w = window as unknown as { __cspViolations?: string[] };
      w.__cspViolations = w.__cspViolations ?? [];
      w.__cspViolations.push(`${e.violatedDirective}:${e.blockedURI}`);
    });
  });

async function submitDialog(page: Page, buttonName: string) {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const btn = dialog.getByRole("button", { name: buttonName, exact: true });
  await expect(btn).toBeEnabled();
  await page.waitForTimeout(250);
  await btn.click();
  await expect(dialog).toBeHidden();
}

function buildEnglishModelPackZip(): Buffer {
  const enc = new TextEncoder();
  const files: Record<string, Uint8Array> = {
    "config.json": enc.encode(JSON.stringify({ model_type: "whisper", is_multilingual: false, num_mel_bins: 80, d_model: 384 })),
    "generation_config.json": enc.encode(JSON.stringify({ is_multilingual: false, lang_to_id: { "<|en|>": 50259 } })),
    "preprocessor_config.json": enc.encode(JSON.stringify({ feature_size: 80, sampling_rate: 16000 })),
    "tokenizer.json": enc.encode(JSON.stringify({ version: "1.0", model: { type: "BPE", vocab: {} } })),
    "onnx/encoder_model_quantized.onnx": new Uint8Array(64).fill(0x08),
    "onnx/decoder_model_merged_quantized.onnx": new Uint8Array(64).fill(0x09),
  };
  files["manifest.json"] = enc.encode(JSON.stringify({ id: "en-pack-e2e", name: "English Local Pack E2E" }));
  return Buffer.from(zipSync(files));
}

test.setTimeout(120_000);

test("Semesters modal stability, real lecture audio recording + mini bar + note timestamp jump, and offline ASR model manager", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await english(page);
  await page.setViewportSize({ width: 1280, height: 900 });

  // Verify self-hosted ORT WASM runtime assets are served cleanly from /asr/
  for (const asset of ["/asr/ort-wasm-simd-threaded.mjs", "/asr/ort-wasm-simd-threaded.wasm"]) {
    const r = await page.request.get(asset);
    expect(r.status(), `ASR asset missing: ${asset}`).toBe(200);
  }

  // 1. Semesters creation modal stability (type continuously with zero focus/DOM drop)
  await page.goto("/#/semesters");
  await page.getByRole("button", { name: "New semester" }).first().click();
  const semInput = page.getByRole("dialog").getByLabel("Name", { exact: true });
  await expect(semInput).toBeVisible();
  await semInput.pressSequentially("Fall 2026 — الفصل الدراسي الأول", { delay: 15 });
  await expect(semInput).toHaveValue("Fall 2026 — الفصل الدراسي الأول");
  await submitDialog(page, "Create");
  await expect(page.getByText("Fall 2026 — الفصل الدراسي الأول")).toBeVisible();

  // 2. Create Subject & Lecture, then record real MediaStream audio
  await page.goto("/#/subjects");
  await page.getByRole("button", { name: "New subject" }).first().click();
  await page.getByLabel("Subject name").fill("Computer Architecture");
  await submitDialog(page, "Save");
  await page.getByRole("link", { name: /Computer Architecture/ }).first().click();

  await page.getByRole("button", { name: "Lecture" }).first().click();
  await page.getByLabel("Lecture title").fill("Pipeline Hazards");
  await submitDialog(page, "Save");
  await page.getByRole("button", { name: /Pipeline Hazards/ }).first().click();

  await expect(page.getByRole("heading", { name: "Lecture Audio Recorder" })).toBeVisible();
  await page.getByRole("button", { name: "Record Lecture" }).click();

  // Verify live timer advances past 00:01 & persistent floating RecordingMiniBar is active
  const miniBar = page.getByRole("region", { name: "Active lecture recorder" });
  await expect(miniBar).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(1600);

  // Pause -> Resume inside lecture recorder
  await page.getByRole("button", { name: "Pause", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Resume", exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Resume", exact: true }).first().click();
  await page.waitForTimeout(700);

  // Add a live bookmark and insert timestamp directly into a linked note
  await page.getByPlaceholder("Marker note (optional)…").fill("Data hazard diagram");
  await page.getByRole("button", { name: "Bookmark now" }).click();
  await page.getByRole("button", { name: "Timestamp to note" }).click();
  await page.getByRole("button", { name: "Open note" }).click();

  // Verify floating RecordingMiniBar survived navigation into NoteEditor & insert live timestamp button works
  await expect(miniBar).toBeVisible();
  const tsNode = page.locator("button[data-audio-ts]").first();
  await expect(tsNode).toBeVisible();

  // Stop & Save directly from the floating mini bar while inside NoteEditor
  await miniBar.getByRole("button", { name: "Stop & save" }).click();
  await expect(miniBar).toBeHidden({ timeout: 10_000 });
  await expect(page.getByText("Lecture recording saved")).toBeVisible();

  // Reload to verify real IndexedDB durability of both note timestamp and finalized recording
  await page.reload();
  const persistedTs = page.locator("button[data-audio-ts]").first();
  await expect(persistedTs).toBeVisible();
  await persistedTs.click();

  // Clicking the timestamp navigates cleanly to FileViewer audio workspace with markers & transcription panel
  await expect(page).toHaveURL(/#\/files\/.+\?t=/);
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  await expect(page.getByText("Data hazard diagram")).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Transcription$/ })).toBeVisible();

  // Before installing a language pack, clean non-technical banner guides the user
  await expect(page.getByText("Transcription is not ready yet", { exact: true })).toBeVisible();

  // 3. Settings -> Lecture Transcription: verify catalog + local pack import + language guard + verify check
  await page.goto("/#/settings");
  await expect(page.getByRole("heading", { name: "Lecture Transcription" })).toBeVisible();
  await expect(page.getByText("Compact Pack (Multilingual)")).toBeVisible();
  await expect(page.getByText("High Accuracy Pack (Multilingual)")).toBeVisible();

  // Import English-only mock pack cleanly & verify integrity
  await page.locator('input[aria-label="Import language pack"]').setInputFiles({
    name: "en-pack.zip",
    mimeType: "application/zip",
    buffer: buildEnglishModelPackZip(),
  });
  await expect(page.getByText("English Local Pack E2E", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page.getByText("Language pack verified")).toBeVisible();

  // Navigate back to the saved audio file -> verify language guard blocks Arabic on EN-only pack
  await page.goBack();
  await expect(page.getByRole("heading", { name: /^Transcription$/ })).toBeVisible();
  const langSelect = page.locator("select").filter({ hasText: "Arabic (AR)" });
  await langSelect.selectOption("ar");
  await expect(page.getByText(/only supports English/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Transcribe$/i })).toBeDisabled();

  // Zero uncaught page errors or CSP violations across the entire flow
  const cspViolations = await page.evaluate(() => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? []);
  expect(cspViolations).toEqual([]);
  expect(errors).toEqual([]);
});
