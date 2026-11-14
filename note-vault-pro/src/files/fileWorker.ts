// Web Worker for offloading file validation, hashing, and image processing off the UI thread.
import { MAX_IMAGE_DIM, MAX_IMAGE_PIXELS, sha256Blob, validateBlobStructure, validateFileCore } from "./fileCore";

export type WorkerRequest =
  | { id: number; op: "validate"; file: File; maxBytes?: number }
  | { id: number; op: "sha256"; blob: Blob }
  | { id: number; op: "compressImage"; blob: Blob; mime: string; maxDim: number }
  | { id: number; op: "imageThumb"; blob: Blob; size: number };

export type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

async function decodeBoundedBitmap(blob: Blob): Promise<ImageBitmap> {
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
  return bmp;
}

async function compressInWorker(blob: Blob, mime: string, maxDim: number): Promise<Blob> {
  const struct = await validateBlobStructure(blob, "image", mime);
  if (!struct.ok) throw new Error(struct.reason);
  if (blob.size < 1.2 * 1024 * 1024 && mime !== "image/png") return blob;
  if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") return blob;

  let bmp: ImageBitmap | null = null;
  let canvas: OffscreenCanvas | null = null;
  try {
    bmp = await decodeBoundedBitmap(blob);
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    if (scale === 1 && blob.size < 3 * 1024 * 1024) return blob;
    canvas = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * scale)), Math.max(1, Math.round(bmp.height * scale)));
    const ctx = canvas.getContext("2d");
    if (!ctx) return blob;
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const targetMime = mime === "image/png" && blob.size < 4 * 1024 * 1024 ? "image/png" : "image/webp";
    const out = await canvas.convertToBlob({ type: targetMime, quality: 0.86 });
    return out && out.size < blob.size ? out : blob;
  } catch {
    return blob;
  } finally {
    bmp?.close();
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + CHUNK)));
  }
  return `data:${blob.type || "image/jpeg"};base64,${btoa(bin)}`;
}

async function thumbInWorker(blob: Blob, size: number): Promise<string | undefined> {
  if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") return undefined;
  let bmp: ImageBitmap | null = null;
  let canvas: OffscreenCanvas | null = null;
  try {
    bmp = await decodeBoundedBitmap(blob);
    const scale = Math.min(1, size / Math.max(bmp.width, bmp.height));
    canvas = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * scale)), Math.max(1, Math.round(bmp.height * scale)));
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.7 });
    return await blobToDataUrl(out);
  } catch {
    return undefined;
  } finally {
    bmp?.close();
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

self.addEventListener("message", async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  try {
    let result: unknown;
    switch (msg.op) {
      case "validate":
        result = await validateFileCore(msg.file, msg.maxBytes);
        break;
      case "sha256":
        result = await sha256Blob(msg.blob);
        break;
      case "compressImage":
        result = await compressInWorker(msg.blob, msg.mime, msg.maxDim);
        break;
      case "imageThumb":
        result = await thumbInWorker(msg.blob, msg.size);
        break;
    }
    self.postMessage({ id: msg.id, ok: true, result } satisfies WorkerResponse);
  } catch (e) {
    self.postMessage({
      id: msg.id,
      ok: false,
      error: e instanceof Error ? e.message : "WORKER_ERROR",
    } satisfies WorkerResponse);
  }
});
