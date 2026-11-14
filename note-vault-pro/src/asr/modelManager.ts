// Local ASR model cache manager: opt-in download, local ZIP/files import, SHA-256 verification & CacheStorage persistence.
import { Unzip, UnzipInflate, UnzipPassThrough } from "fflate";
import { db } from "@/data/db";
import type { AsrModelFileInfo, AsrModelRecord } from "@/data/types";
import { checkStorageQuota } from "@/services/storage";
import {
  ASR_CATALOG,
  ASR_MODEL_CACHE,
  catalogFileUrl,
  detectLanguagesFromConfigs,
  localCacheKey,
  sha256Bytes,
  validateModelAssetBytes,
  type AsrCatalogEntry,
} from "./models";

const REQUIRED_MODEL_FILES = [
  "config.json",
  "generation_config.json",
  "preprocessor_config.json",
  "tokenizer.json",
  "onnx/encoder_model_quantized.onnx",
  "onnx/decoder_model_merged_quantized.onnx",
];

// Fallback store for environments without CacheStorage (e.g., jsdom tests)
const memoryFallbackCache = new Map<string, { bytes: Uint8Array; type: string }>();

async function cachePutBytes(key: string, bytes: Uint8Array, contentType: string) {
  if (typeof caches !== "undefined") {
    const cache = await caches.open(ASR_MODEL_CACHE);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    await cache.put(
      key,
      new Response(copy.buffer, {
        status: 200,
        headers: { "Content-Type": contentType, "Content-Length": String(bytes.byteLength) },
      })
    );
    return;
  }
  memoryFallbackCache.set(key, { bytes: new Uint8Array(bytes), type: contentType });
}

export async function cacheGetBytes(key: string): Promise<Uint8Array | null> {
  if (typeof caches !== "undefined") {
    const cache = await caches.open(ASR_MODEL_CACHE);
    const res = await cache.match(key);
    if (!res) return null;
    return new Uint8Array(await res.arrayBuffer());
  }
  const hit = memoryFallbackCache.get(key);
  return hit ? new Uint8Array(hit.bytes) : null;
}

async function cacheDeleteModel(modelId: string, files: string[]) {
  if (typeof caches !== "undefined") {
    const cache = await caches.open(ASR_MODEL_CACHE);
    await Promise.all(files.map((f) => cache.delete(localCacheKey(modelId, f))));
  }
  for (const f of files) {
    memoryFallbackCache.delete(localCacheKey(modelId, f));
  }
}

function contentTypeFor(filePath: string): string {
  return filePath.endsWith(".json") ? "application/json; charset=utf-8" : "application/octet-stream";
}

async function readStreamWithProgress(
  res: Response,
  onDelta: (bytes: number) => void,
  signal?: AbortSignal
): Promise<Uint8Array> {
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onDelta(buf.byteLength);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    if (signal?.aborted) {
      await reader.cancel().catch(() => undefined);
      throw new DOMException("Aborted", "AbortError");
    }
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.byteLength > 0) {
      chunks.push(value);
      total += value.byteLength;
      onDelta(value.byteLength);
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export interface DownloadProgress {
  phase: "downloading" | "verifying" | "ready";
  currentFile: string;
  downloadedBytes: number;
  totalBytes: number;
}

/** Downloads an opt-in ASR model from the verified catalog, verifies integrity, and caches it locally. */
export async function downloadCatalogModel(
  modelId: string,
  opts: { signal?: AbortSignal; onProgress?: (p: DownloadProgress) => void } = {}
): Promise<AsrModelRecord> {
  const entry: AsrCatalogEntry | undefined = ASR_CATALOG.find((m) => m.id === modelId);
  if (!entry) throw new Error("UNKNOWN_MODEL");

  const quota = await checkStorageQuota(entry.approxBytes);
  if (!quota.ok) throw new Error("QUOTA_EXCEEDED");

  try {
    await navigator.storage?.persist?.();
  } catch {
    /* optional */
  }

  const now = Date.now();
  const rec: AsrModelRecord = {
    id: entry.id,
    name: entry.nameEn,
    repoId: entry.repoId,
    languages: [...entry.languages],
    sizeBytes: entry.approxBytes,
    downloadedBytes: 0,
    status: "downloading",
    fileHashes: {},
    updatedAt: now,
  };
  await db.asrModels.put(rec);

  let downloadedBytes = 0;
  const fileHashes: Record<string, AsrModelFileInfo> = {};

  try {
    for (const filePath of entry.files) {
      if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const url = catalogFileUrl(entry.repoId, filePath);
      const res = await fetch(url, { signal: opts.signal, mode: "cors", credentials: "omit" });
      if (!res.ok) {
        throw new Error(`DOWNLOAD_FAILED_${res.status}`);
      }
      const bytes = await readStreamWithProgress(
        res,
        (delta) => {
          downloadedBytes += delta;
          opts.onProgress?.({
            phase: "downloading",
            currentFile: filePath,
            downloadedBytes,
            totalBytes: Math.max(entry.approxBytes, downloadedBytes),
          });
        },
        opts.signal
      );

      if (!validateModelAssetBytes(filePath, bytes)) {
        throw new Error(`INVALID_MODEL_FILE:${filePath}`);
      }

      opts.onProgress?.({
        phase: "verifying",
        currentFile: filePath,
        downloadedBytes,
        totalBytes: Math.max(entry.approxBytes, downloadedBytes),
      });

      const digest = await sha256Bytes(bytes);
      const pinned = entry.expectedSha256?.[filePath];
      if (pinned && digest !== pinned.toLowerCase()) {
        throw new Error(`SHA256_MISMATCH:${filePath}`);
      }

      await cachePutBytes(localCacheKey(entry.id, filePath), bytes, contentTypeFor(filePath));
      fileHashes[filePath] = { url, size: bytes.byteLength, sha256: digest };
    }

    // Also verify runtime config languages directly from downloaded config
    const cfgBytes = await cacheGetBytes(localCacheKey(entry.id, "config.json"));
    const genBytes = await cacheGetBytes(localCacheKey(entry.id, "generation_config.json"));
    const cfgJson = cfgBytes ? (JSON.parse(new TextDecoder().decode(cfgBytes)) as Record<string, unknown>) : {};
    const genJson = genBytes ? (JSON.parse(new TextDecoder().decode(genBytes)) as Record<string, unknown>) : undefined;
    const detectedLangs = detectLanguagesFromConfigs(cfgJson, genJson);

    const exactBytes = Object.values(fileHashes).reduce((s, f) => s + f.size, 0);
    const readyRec: AsrModelRecord = {
      ...rec,
      languages: detectedLangs,
      sizeBytes: exactBytes,
      downloadedBytes: exactBytes,
      status: "ready",
      fileHashes,
      verifiedAt: Date.now(),
      error: undefined,
      updatedAt: Date.now(),
    };
    await db.asrModels.put(readyRec);

    // Warm local WASM runtime assets so offline transcription works immediately without prior online run
    for (const wasmAsset of ["./asr/ort-wasm-simd-threaded.mjs", "./asr/ort-wasm-simd-threaded.wasm"]) {
      await fetch(wasmAsset).catch(() => undefined);
    }

    opts.onProgress?.({ phase: "ready", currentFile: "", downloadedBytes: exactBytes, totalBytes: exactBytes });
    return readyRec;
  } catch (e) {
    await cacheDeleteModel(entry.id, entry.files).catch(() => undefined);
    const aborted = e instanceof DOMException && e.name === "AbortError";
    const errMsg = aborted ? "DOWNLOAD_CANCELLED" : e instanceof Error ? e.message : String(e);
    await db.asrModels.put({
      ...rec,
      status: aborted ? "not_installed" : "error",
      downloadedBytes: 0,
      error: errMsg,
      updatedAt: Date.now(),
    });
    throw e;
  }
}

function normalizeImportedPath(rawPath: string): string {
  const clean = rawPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const fileName = clean.split("/").pop() || clean;
  if (clean.endsWith("onnx/encoder_model_quantized.onnx") || fileName === "encoder_model_quantized.onnx") {
    return "onnx/encoder_model_quantized.onnx";
  }
  if (clean.endsWith("onnx/decoder_model_merged_quantized.onnx") || fileName === "decoder_model_merged_quantized.onnx") {
    return "onnx/decoder_model_merged_quantized.onnx";
  }
  return fileName;
}

const MAX_PACK_UNCOMPRESSED = 250 * 1024 * 1024;

async function extractZipEntries(zipFile: File): Promise<Map<string, Uint8Array>> {
  const entries = new Map<string, Uint8Array>();
  let totalBytes = 0;
  let fatal: Error | null = null;

  const unzip = new Unzip((file) => {
    const name = normalizeImportedPath(file.name);
    if (!name || file.name.endsWith("/") || file.name.includes("..")) return;
    const chunks: Uint8Array[] = [];
    let size = 0;
    file.ondata = (err, data, final) => {
      if (fatal) return;
      if (err) {
        fatal = new Error("INVALID_ZIP");
        return;
      }
      if (data.byteLength > 0) {
        size += data.byteLength;
        totalBytes += data.byteLength;
        if (totalBytes > MAX_PACK_UNCOMPRESSED) {
          fatal = new Error("PACK_TOO_LARGE");
          file.terminate();
          return;
        }
        const copy = new Uint8Array(data.byteLength);
        copy.set(data);
        chunks.push(copy);
      }
      if (final) {
        const merged = new Uint8Array(size);
        let off = 0;
        for (const c of chunks) {
          merged.set(c, off);
          off += c.byteLength;
        }
        entries.set(name, merged);
      }
    };
    file.start();
  });
  unzip.register(UnzipPassThrough);
  unzip.register(UnzipInflate);

  const CHUNK = 512 * 1024;
  for (let off = 0; off < zipFile.size; off += CHUNK) {
    if (fatal) break;
    const end = Math.min(zipFile.size, off + CHUNK);
    const buf = new Uint8Array(await zipFile.slice(off, end).arrayBuffer());
    unzip.push(buf, end >= zipFile.size);
  }
  if (fatal) throw fatal;
  return entries;
}

/** Imports an offline Whisper ONNX model bundle (.zip or set of model files) with structural & SHA-256 checks. */
export async function importLocalModelPack(
  input: File | File[],
  opts: { modelId?: string; name?: string } = {}
): Promise<AsrModelRecord> {
  const fileMap = new Map<string, Uint8Array>();
  if (!Array.isArray(input) && input.name.toLowerCase().endsWith(".zip")) {
    const zipEntries = await extractZipEntries(input);
    for (const [k, v] of zipEntries) fileMap.set(k, v);
  } else {
    const arr = Array.isArray(input) ? input : [input];
    for (const f of arr) {
      const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
      const key = normalizeImportedPath(rel);
      fileMap.set(key, new Uint8Array(await f.arrayBuffer()));
    }
  }

  // Optional manifest.json with expected sha256 map
  let manifestMeta: { id?: string; name?: string; repoId?: string; sha256?: Record<string, string> } = {};
  const manifestBytes = fileMap.get("manifest.json");
  if (manifestBytes) {
    try {
      manifestMeta = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)) as typeof manifestMeta;
    } catch {
      throw new Error("INVALID_MODEL_MANIFEST");
    }
  }

  for (const req of REQUIRED_MODEL_FILES) {
    if (!fileMap.has(req)) {
      throw new Error(`MISSING_MODEL_FILE:${req}`);
    }
  }

  const totalSize = Array.from(fileMap.values()).reduce((s, b) => s + b.byteLength, 0);
  const quota = await checkStorageQuota(totalSize);
  if (!quota.ok) throw new Error("QUOTA_EXCEEDED");

  const modelId = (opts.modelId || manifestMeta.id || `custom-whisper-${Date.now()}`).replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 64);
  const fileHashes: Record<string, AsrModelFileInfo> = {};

  for (const [filePath, bytes] of fileMap) {
    if (filePath === "manifest.json") continue;
    if (!validateModelAssetBytes(filePath, bytes)) {
      throw new Error(`INVALID_MODEL_FILE:${filePath}`);
    }
    const digest = await sha256Bytes(bytes);
    const expected = manifestMeta.sha256?.[filePath];
    if (expected && digest !== expected.toLowerCase()) {
      await cacheDeleteModel(modelId, Array.from(fileMap.keys()));
      throw new Error(`SHA256_MISMATCH:${filePath}`);
    }
    await cachePutBytes(localCacheKey(modelId, filePath), bytes, contentTypeFor(filePath));
    fileHashes[filePath] = { url: `local://${filePath}`, size: bytes.byteLength, sha256: digest };
  }

  const cfgJson = JSON.parse(new TextDecoder().decode(fileMap.get("config.json")!)) as Record<string, unknown>;
  const genJson = JSON.parse(new TextDecoder().decode(fileMap.get("generation_config.json")!)) as Record<string, unknown>;
  const languages = detectLanguagesFromConfigs(cfgJson, genJson);

  const rec: AsrModelRecord = {
    id: modelId,
    name: (opts.name || manifestMeta.name || modelId).slice(0, 120),
    repoId: manifestMeta.repoId || "local-import",
    languages,
    sizeBytes: totalSize,
    downloadedBytes: totalSize,
    status: "ready",
    fileHashes,
    verifiedAt: Date.now(),
    updatedAt: Date.now(),
  };
  await db.asrModels.put(rec);
  return rec;
}

/** Re-verifies every cached model file in CacheStorage against its stored SHA-256 digest. */
export async function verifyInstalledModel(modelId: string): Promise<AsrModelRecord> {
  const rec = await db.asrModels.get(modelId);
  if (!rec || rec.status !== "ready") {
    throw new Error("MODEL_NOT_INSTALLED");
  }
  const files = Object.entries(rec.fileHashes);
  if (!files.length) {
    await db.asrModels.update(modelId, { status: "error", error: "MISSING_MODEL_FILES", updatedAt: Date.now() });
    throw new Error("MODEL_INTEGRITY_FAILED");
  }
  for (const [filePath, info] of files) {
    const bytes = await cacheGetBytes(localCacheKey(modelId, filePath));
    if (!bytes) {
      await db.asrModels.update(modelId, { status: "error", error: `MISSING:${filePath}`, updatedAt: Date.now() });
      throw new Error("MODEL_INTEGRITY_FAILED");
    }
    const actual = await sha256Bytes(bytes);
    if (actual !== info.sha256) {
      await db.asrModels.update(modelId, { status: "error", error: `CORRUPT:${filePath}`, updatedAt: Date.now() });
      throw new Error("MODEL_INTEGRITY_FAILED");
    }
  }
  const verified: AsrModelRecord = { ...rec, verifiedAt: Date.now(), updatedAt: Date.now(), error: undefined };
  await db.asrModels.put(verified);
  return verified;
}

export async function deleteInstalledModel(modelId: string) {
  const rec = await db.asrModels.get(modelId);
  const files = rec ? Object.keys(rec.fileHashes) : [];
  const catalogFiles = ASR_CATALOG.find((m) => m.id === modelId)?.files ?? [];
  await cacheDeleteModel(modelId, Array.from(new Set([...files, ...catalogFiles])));
  await db.asrModels.delete(modelId);
}

/** Used internally by unit tests & diagnostics to verify fallback cache behavior. */
export function _clearMemoryModelCacheForTests() {
  memoryFallbackCache.clear();
}
