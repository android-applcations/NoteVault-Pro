// File processing layer – workerized validation, bomb guards, hashing, and image processing.
import {
  EXT_MAP,
  MAX_IMAGE_DIM,
  MAX_IMAGE_PIXELS,
  sha256Blob,
  validateBlobStructure,
  validateFileCore,
  type ValidationResult,
} from "./fileCore";
import type { WorkerRequest, WorkerResponse } from "./fileWorker";

export {
  EXT_MAP,
  MAX_AUDIO_BYTES,
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIM,
  MAX_IMAGE_PIXELS,
  MAX_PDF_BYTES,
  MAX_TEXT_BYTES,
  validateBlobStructure,
  type Validated,
  type ValidationFailureReason,
  type ValidationResult,
} from "./fileCore";

export const ACCEPT_ATTR = Object.keys(EXT_MAP)
  .map((e) => "." + e)
  .join(",");
export const SUPPORTED_LABEL = "PDF, PNG, JPG, WebP, TXT, MD, MP3, WAV, OGG, M4A, AAC, FLAC, WebM(audio)";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function resetWorker(err: Error) {
  if (worker) {
    try {
      worker.terminate();
    } catch {
      /* ignore */
    }
    worker = null;
  }
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.reject(err);
  }
  pending.clear();
}

function getWorker(): Worker | null {
  if (typeof window === "undefined" || typeof Worker === "undefined") return null;
  if (!worker) {
    try {
      worker = new Worker(new URL("./fileWorker.ts", import.meta.url), { type: "module" });
      worker.addEventListener("message", (ev: MessageEvent<WorkerResponse>) => {
        const msg = ev.data;
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error));
      });
      worker.addEventListener("error", () => resetWorker(new Error("FILE_WORKER_FAILED")));
    } catch {
      worker = null;
    }
  }
  return worker;
}

async function runWorker<T>(
  build: (id: number) => WorkerRequest,
  fallback: () => Promise<T>,
  timeoutMs = 30_000
): Promise<T> {
  const w = getWorker();
  if (!w) return fallback();
  const id = nextId++;
  try {
    return (await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resetWorker(new Error("FILE_WORKER_TIMEOUT"));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      w.postMessage(build(id));
    })) as T;
  } catch {
    return fallback();
  }
}

/** Validates by extension, per-kind size limit, structural signatures, and pre-decode dimension bounds. */
export async function validateFile(file: File, maxBytes?: number): Promise<ValidationResult> {
  return runWorker(
    (id) => ({ id, op: "validate", file, maxBytes }),
    () => validateFileCore(file, maxBytes)
  );
}

export async function sha256(blob: Blob): Promise<string> {
  return runWorker(
    (id) => ({ id, op: "sha256", blob }),
    () => sha256Blob(blob)
  );
}

async function loadBitmapMain(blob: Blob): Promise<{ src: ImageBitmap | HTMLImageElement; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === "function") {
    const bmp = await createImageBitmap(blob);
    if (
      !Number.isFinite(bmp.width) ||
      !Number.isFinite(bmp.height) ||
      bmp.width <= 0 ||
      bmp.height <= 0 ||
      bmp.width > MAX_IMAGE_DIM ||
      bmp.height > MAX_IMAGE_DIM ||
      bmp.width * bmp.height > MAX_IMAGE_PIXELS
    ) {
      bmp.close();
      throw new Error("IMAGE_DIMENSIONS_EXCEEDED");
    }
    return { src: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    if (
      img.naturalWidth <= 0 ||
      img.naturalHeight <= 0 ||
      img.naturalWidth > MAX_IMAGE_DIM ||
      img.naturalHeight > MAX_IMAGE_DIM ||
      img.naturalWidth * img.naturalHeight > MAX_IMAGE_PIXELS
    ) {
      throw new Error("IMAGE_DIMENSIONS_EXCEEDED");
    }
    return {
      src: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      close: () => {
        img.src = "";
      },
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function toBlob(canvas: HTMLCanvasElement, type: string, q: number): Promise<Blob | null> {
  return new Promise((res) => canvas.toBlob(res, type, q));
}

async function compressImageFallback(blob: Blob, mime: string, maxDim = 2400): Promise<Blob> {
  if (typeof document === "undefined") return blob;
  const struct = await validateBlobStructure(blob, "image", mime);
  if (!struct.ok) return blob;
  if (blob.size < 1.2 * 1024 * 1024 && mime !== "image/png") return blob;
  let loaded: Awaited<ReturnType<typeof loadBitmapMain>> | null = null;
  let c: HTMLCanvasElement | null = null;
  try {
    loaded = await loadBitmapMain(blob);
    const scale = Math.min(1, maxDim / Math.max(loaded.width, loaded.height));
    if (scale === 1 && blob.size < 3 * 1024 * 1024) return blob;
    c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(loaded.width * scale));
    c.height = Math.max(1, Math.round(loaded.height * scale));
    const ctx = c.getContext("2d");
    if (!ctx) return blob;
    ctx.drawImage(loaded.src, 0, 0, c.width, c.height);
    const out = await toBlob(c, mime === "image/png" && blob.size < 4 * 1024 * 1024 ? "image/png" : "image/webp", 0.86);
    return out && out.size < blob.size ? out : blob;
  } catch {
    return blob;
  } finally {
    loaded?.close();
    if (c) {
      c.width = 0;
      c.height = 0;
    }
  }
}

async function imageThumbFallback(blob: Blob, size = 240): Promise<string | undefined> {
  if (typeof document === "undefined") return undefined;
  let loaded: Awaited<ReturnType<typeof loadBitmapMain>> | null = null;
  let c: HTMLCanvasElement | null = null;
  try {
    loaded = await loadBitmapMain(blob);
    const scale = Math.min(1, size / Math.max(loaded.width, loaded.height));
    c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(loaded.width * scale));
    c.height = Math.max(1, Math.round(loaded.height * scale));
    const ctx = c.getContext("2d");
    if (!ctx) return undefined;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(loaded.src, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.7);
  } catch {
    return undefined;
  } finally {
    loaded?.close();
    if (c) {
      c.width = 0;
      c.height = 0;
    }
  }
}

/** Downscales large images inside a Web Worker when available; enforces pre-decode dimension bounds. */
export async function compressImage(blob: Blob, mime: string, maxDim = 2400): Promise<Blob> {
  const struct = await validateBlobStructure(blob, "image", mime);
  if (!struct.ok) throw new Error(struct.reason);
  if (typeof OffscreenCanvas !== "undefined") {
    return runWorker(
      (id) => ({ id, op: "compressImage", blob, mime, maxDim }),
      () => compressImageFallback(blob, mime, maxDim)
    );
  }
  return compressImageFallback(blob, mime, maxDim);
}

/** Creates a small JPEG data URL thumbnail from an image blob inside a Web Worker when available. */
export async function imageThumb(blob: Blob, size = 240): Promise<string | undefined> {
  if (typeof OffscreenCanvas !== "undefined") {
    return runWorker(
      (id) => ({ id, op: "imageThumb", blob, size }),
      () => imageThumbFallback(blob, size)
    );
  }
  return imageThumbFallback(blob, size);
}

/** Compresses a cover image to a small data URL. */
export async function coverFromFile(file: File): Promise<string | undefined> {
  const v = await validateFile(file, 20 * 1024 * 1024);
  if (!v.ok || v.kind !== "image") return undefined;
  return imageThumb(file, 720);
}
