import { zipSync } from "fflate";
import { beforeEach, describe, expect, it } from "vitest";
import { buildPcmWindows, resampleTo16kMono, TARGET_SAMPLE_RATE } from "@/asr/audioDecode";
import { collapseWhisperRepetitions, deduplicateOverlapText, mergeWindowSegments } from "@/asr/chunkMerge";
import {
  _clearMemoryModelCacheForTests,
  cacheGetBytes,
  deleteInstalledModel,
  importLocalModelPack,
  verifyInstalledModel,
} from "@/asr/modelManager";
import { ASR_CATALOG, localCacheKey, modelSupportsLanguage, sha256Bytes, validateModelAssetBytes } from "@/asr/models";
import { computeSlaneyMelFilterbank, computeWhisperMelFeatures, WHISPER_N_FRAMES } from "@/asr/whisperInference";
import { db } from "@/data/db";

function buildMockModelFiles(opts: { multilingual: boolean; manifestSha?: boolean }): Record<string, Uint8Array> {
  const enc = new TextEncoder();
  const files: Record<string, Uint8Array> = {
    "config.json": enc.encode(
      JSON.stringify({
        model_type: "whisper",
        is_multilingual: opts.multilingual,
        num_mel_bins: 80,
        d_model: 384,
      })
    ),
    "generation_config.json": enc.encode(
      JSON.stringify({
        is_multilingual: opts.multilingual,
        lang_to_id: opts.multilingual ? { "<|en|>": 50259, "<|ar|>": 50272 } : { "<|en|>": 50259 },
      })
    ),
    "preprocessor_config.json": enc.encode(JSON.stringify({ feature_size: 80, sampling_rate: 16000 })),
    "tokenizer.json": enc.encode(JSON.stringify({ version: "1.0", model: { type: "BPE", vocab: {} } })),
    "onnx/encoder_model_quantized.onnx": new Uint8Array(64).fill(0x08),
    "onnx/decoder_model_merged_quantized.onnx": new Uint8Array(64).fill(0x09),
  };
  return files;
}

describe("Offline ASR Engine: DSP, Chunk Merging, Language Guard & SHA-256 Cache Security", () => {
  beforeEach(async () => {
    await db.asrModels.clear();
    _clearMemoryModelCacheForTests();
  });

  it("downmixes stereo 48kHz audio to 16kHz mono and slices bounded overlapping PCM windows", () => {
    const rate = 48000;
    const durationSec = 65;
    const n = rate * durationSec;
    const left = new Float32Array(n);
    const right = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      left[i] = 0.5;
      right[i] = -0.1;
    }

    const mono16k = resampleTo16kMono([left, right], rate);
    expect(mono16k.length).toBe(TARGET_SAMPLE_RATE * durationSec);
    expect(mono16k[1000]).toBeCloseTo(0.2, 4);

    // 65s with window=28s, overlap=4s -> stride 24s: [0..28], [24..52], [48..65]
    const windows = buildPcmWindows(mono16k, 28, 4, TARGET_SAMPLE_RATE);
    expect(windows).toHaveLength(3);
    expect(windows[0].startSec).toBe(0);
    expect(windows[0].endSec).toBe(28);
    expect(windows[1].startSec).toBe(24);
    expect(windows[1].endSec).toBe(52);
    expect(windows[2].startSec).toBe(48);
    expect(windows[2].endSec).toBe(65);
  });

  it("computes exact 80x3000 Slaney log-mel Whisper spectrogram and localizes frequency peaks", () => {
    const filters = computeSlaneyMelFilterbank(400, 80, 16000);
    expect(filters.length).toBe(80 * 201);

    // 1 second of 3000 Hz sine wave vs 200 Hz sine wave
    const sr = 16000;
    const lowPcm = new Float32Array(sr);
    const highPcm = new Float32Array(sr);
    for (let i = 0; i < sr; i++) {
      lowPcm[i] = Math.sin((2 * Math.PI * 200 * i) / sr);
      highPcm[i] = Math.sin((2 * Math.PI * 3000 * i) / sr);
    }

    const melLow = computeWhisperMelFeatures(lowPcm, filters, 80);
    const melHigh = computeWhisperMelFeatures(highPcm, filters, 80);
    expect(melLow.length).toBe(80 * WHISPER_N_FRAMES);
    expect(melHigh.length).toBe(80 * WHISPER_N_FRAMES);

    // Check normalized Whisper dynamic range bounds [-1.x, +1.x]
    let minVal = Infinity;
    let maxVal = -Infinity;
    for (let i = 0; i < melHigh.length; i++) {
      if (melHigh[i] < minVal) minVal = melHigh[i];
      if (melHigh[i] > maxVal) maxVal = melHigh[i];
    }
    expect(maxVal - minVal).toBeCloseTo(2.0, 2); // clamped max - (max - 8) / 4 = 2.0 exact

    // Find peak mel bin in frame 20 (middle of active 1s tone)
    const peakMel = (mel: Float32Array) => {
      let bestM = 0;
      let bestV = -Infinity;
      for (let m = 0; m < 80; m++) {
        const v = mel[m * WHISPER_N_FRAMES + 20];
        if (v > bestV) {
          bestV = v;
          bestM = m;
        }
      }
      return bestM;
    };
    expect(peakMel(melHigh)).toBeGreaterThan(peakMel(melLow) + 25);
  });

  it("deduplicates Arabic & English chunk overlaps and collapses silence repetition loops", () => {
    // English boundary overlap
    expect(deduplicateOverlapText("we compute the matrix inverse quickly", "the matrix inverse quickly and return")).toBe(
      "and return"
    );

    // Arabic boundary overlap with diacritics & alef variants
    const arPrev = "نتعلم اليوم أساسيات الذكاء الاصطناعي";
    const arNext = "اساسيات الذكاء الاصطناعى وتطبيقاتها العملية";
    expect(deduplicateOverlapText(arPrev, arNext)).toBe("وتطبيقاتها العملية");

    // Whisper loop hallucination collapse
    expect(collapseWhisperRepetitions("شكرا لكم شكرا لكم شكرا لكم شكرا لكم")).toBe("شكرا لكم");
    expect(collapseWhisperRepetitions("Normal lecture sentence with distinct words")).toBe(
      "Normal lecture sentence with distinct words"
    );

    const merged = mergeWindowSegments([
      {
        windowIndex: 0,
        segments: [
          { startSec: 0, endSec: 25, text: "First part of the lecture" },
          { startSec: 25, endSec: 27.8, text: "moving to the next topic" },
        ],
      },
      {
        windowIndex: 1,
        segments: [
          { startSec: 24.5, endSec: 32, text: "the next topic which covers sorting" },
        ],
      },
    ]);
    expect(merged).toHaveLength(3);
    expect(merged[2].startSec).toBeGreaterThanOrEqual(merged[1].endSec);
    expect(merged[2].text).toBe("which covers sorting");
  });

  it("rejects malformed/HTML model assets and enforces language capability guards", () => {
    const htmlPayload = new TextEncoder().encode("<!DOCTYPE html><html><body>404</body></html>");
    expect(validateModelAssetBytes("onnx/encoder_model_quantized.onnx", htmlPayload)).toBe(false);
    expect(validateModelAssetBytes("config.json", htmlPayload)).toBe(false);
    expect(
      validateModelAssetBytes("config.json", new TextEncoder().encode(JSON.stringify({ model_type: "bert" })))
    ).toBe(false);

    const enModel = {
      id: "whisper-tiny.en",
      name: "Whisper Tiny EN",
      repoId: "Xenova/whisper-tiny.en",
      languages: ["en"],
      sizeBytes: 100,
      downloadedBytes: 100,
      status: "ready" as const,
      fileHashes: {},
      updatedAt: Date.now(),
    };
    expect(modelSupportsLanguage(enModel, "en")).toBe(true);
    expect(modelSupportsLanguage(enModel, "ar")).toBe(false);
    expect(modelSupportsLanguage(enModel, "auto")).toBe(false);
    expect(ASR_CATALOG.find((m) => m.id === "whisper-base")?.supportsArabic).toBe(true);
  });

  it("imports local model ZIP bundle, verifies SHA-256 digests, and detects cache tampering", async () => {
    const rawFiles = buildMockModelFiles({ multilingual: true });
    const manifestSha: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawFiles)) {
      manifestSha[k] = await sha256Bytes(v);
    }
    rawFiles["manifest.json"] = new TextEncoder().encode(
      JSON.stringify({ id: "whisper-local-test", name: "Local Whisper Test", sha256: manifestSha })
    );

    const zipped = zipSync(rawFiles);
    const packFile = new File([new Uint8Array(zipped)], "whisper-pack.zip", { type: "application/zip" });
    const rec = await importLocalModelPack(packFile);

    expect(rec.id).toBe("whisper-local-test");
    expect(rec.status).toBe("ready");
    expect(rec.languages).toContain("ar");
    expect(rec.languages).toContain("en");

    // Verify succeeds when intact
    const verified = await verifyInstalledModel(rec.id);
    expect(verified.verifiedAt).toBeDefined();

    // Tamper with expected sha256 metadata (simulates mismatched cache / corrupted asset)
    await db.asrModels.update(rec.id, {
      fileHashes: {
        ...verified.fileHashes,
        "config.json": { ...verified.fileHashes["config.json"], sha256: "0".repeat(64) },
      },
    });
    await expect(verifyInstalledModel(rec.id)).rejects.toThrow("MODEL_INTEGRITY_FAILED");
    expect((await db.asrModels.get(rec.id))?.status).toBe("error");

    // Delete wipes cache + metadata
    await deleteInstalledModel(rec.id);
    expect(await db.asrModels.get(rec.id)).toBeUndefined();
    expect(await cacheGetBytes(localCacheKey(rec.id, "config.json"))).toBeNull();
  });
});
