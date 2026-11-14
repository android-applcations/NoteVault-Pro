// File processing layer – validation (extension, size, magic bytes) and image compression.
import type { FileKind } from "@/data/types";
import { sanitizeFileName } from "@/domain/text";

export const MAX_FILE_BYTES = 250 * 1024 * 1024;

const EXT: Record<string, { kind: FileKind; mime: string }> = {
  pdf: { kind: "pdf", mime: "application/pdf" },
  png: { kind: "image", mime: "image/png" },
  jpg: { kind: "image", mime: "image/jpeg" },
  jpeg: { kind: "image", mime: "image/jpeg" },
  webp: { kind: "image", mime: "image/webp" },
  txt: { kind: "text", mime: "text/plain" },
  md: { kind: "markdown", mime: "text/markdown" },
  markdown: { kind: "markdown", mime: "text/markdown" },
  mp3: { kind: "audio", mime: "audio/mpeg" },
  wav: { kind: "audio", mime: "audio/wav" },
  ogg: { kind: "audio", mime: "audio/ogg" },
  oga: { kind: "audio", mime: "audio/ogg" },
  m4a: { kind: "audio", mime: "audio/mp4" },
  aac: { kind: "audio", mime: "audio/aac" },
  webm: { kind: "audio", mime: "audio/webm" },
  flac: { kind: "audio", mime: "audio/flac" },
};
export const ACCEPT_ATTR = Object.keys(EXT).map((e) => "." + e).join(",");
export const SUPPORTED_LABEL = "PDF, PNG, JPG, WebP, TXT, MD, MP3, WAV, OGG, M4A, AAC, FLAC, WebM(audio)";

const ascii = (b: Uint8Array, from: number, s: string) => s.split("").every((c, i) => b[from + i] === c.charCodeAt(0));

function sniffAudio(b: Uint8Array): boolean {
  if (ascii(b, 0, "ID3")) return true; // mp3 with tag
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return true; // mp3/aac frame
  if (ascii(b, 0, "RIFF") && ascii(b, 8, "WAVE")) return true;
  if (ascii(b, 0, "OggS")) return true;
  if (ascii(b, 0, "fLaC")) return true;
  if (ascii(b, 4, "ftyp")) return true;
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return true; // webm/matroska
  return false;
}

export interface Validated {
  ok: true;
  kind: FileKind;
  mime: string;
  name: string;
}
export type ValidationResult = Validated | { ok: false; reason: "type" | "size" | "empty" | "mismatch" | "binary_text" | "bad_encoding" };

/** Validates by extension, size and magic bytes. MIME reported by the browser is never trusted. */
export async function validateFile(file: File, maxBytes = MAX_FILE_BYTES): Promise<ValidationResult> {
  const name = sanitizeFileName(file.name);
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const def = EXT[ext];
  if (!def) return { ok: false, reason: "type" };
  if (file.size === 0) return { ok: false, reason: "empty" };
  if (file.size > maxBytes) return { ok: false, reason: "size" };
  const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  let ok = false;
  switch (def.kind) {
    case "pdf": {
      const first = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
      const s = Array.from(first, (c) => String.fromCharCode(c)).join("");
      ok = s.includes("%PDF-");
      break;
    }
    case "image":
      if (def.mime === "image/png") ok = head[0] === 0x89 && ascii(head, 1, "PNG");
      else if (def.mime === "image/jpeg") ok = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
      else ok = ascii(head, 0, "RIFF") && ascii(head, 8, "WEBP");
      break;
    case "audio":
      ok = sniffAudio(head);
      break;
    case "text":
    case "markdown": {
      const sample = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
      if (sample.includes(0)) return { ok: false, reason: "binary_text" };
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(sample.subarray(0, sample.length - 3 > 0 ? sample.length - 3 : sample.length));
        ok = true;
      } catch {
        return { ok: false, reason: "bad_encoding" };
      }
      break;
    }
  }
  if (!ok) return { ok: false, reason: "mismatch" };
  return { ok: true, kind: def.kind, mime: def.mime, name };
}

export async function sha256(blob: Blob): Promise<string> {
  try {
    if (crypto?.subtle) {
      const buf = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
      return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
    }
  } catch {
    /* fall through */
  }
  return `size-${blob.size}-${Date.now()}`;
}

async function loadBitmap(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") return createImageBitmap(blob);
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function toBlob(canvas: HTMLCanvasElement, type: string, q: number): Promise<Blob | null> {
  return new Promise((res) => canvas.toBlob(res, type, q));
}

/** Downscales large images; returns the original when compression would not help. */
export async function compressImage(blob: Blob, mime: string, maxDim = 2400): Promise<Blob> {
  try {
    if (blob.size < 1.2 * 1024 * 1024 && mime !== "image/png") return blob;
    const bmp = await loadBitmap(blob);
    const w = "width" in bmp ? bmp.width : 0;
    const h = "height" in bmp ? bmp.height : 0;
    const scale = Math.min(1, maxDim / Math.max(w, h));
    if (scale === 1 && blob.size < 3 * 1024 * 1024) return blob;
    const c = document.createElement("canvas");
    c.width = Math.round(w * scale);
    c.height = Math.round(h * scale);
    c.getContext("2d")!.drawImage(bmp as CanvasImageSource, 0, 0, c.width, c.height);
    const out = await toBlob(c, mime === "image/png" && blob.size < 4 * 1024 * 1024 ? "image/png" : "image/webp", 0.86);
    return out && out.size < blob.size ? out : blob;
  } catch {
    return blob;
  }
}

/** Creates a small JPEG data URL thumbnail from an image blob. */
export async function imageThumb(blob: Blob, size = 240): Promise<string | undefined> {
  try {
    const bmp = await loadBitmap(blob);
    const w = "width" in bmp ? bmp.width : 1;
    const h = "height" in bmp ? bmp.height : 1;
    const scale = Math.min(1, size / Math.max(w, h));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * scale));
    c.height = Math.max(1, Math.round(h * scale));
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp as CanvasImageSource, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.7);
  } catch {
    return undefined;
  }
}

/** Compresses a cover image to a small data URL. */
export async function coverFromFile(file: File): Promise<string | undefined> {
  const v = await validateFile(file, 20 * 1024 * 1024);
  if (!v.ok || v.kind !== "image") return undefined;
  return imageThumb(file, 720);
}
