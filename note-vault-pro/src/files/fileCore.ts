// Pure file validation, structural signature checks, and anti-bomb guards (safe for Workers & Node).
import type { FileKind } from "@/data/types";
import { sanitizeFileName } from "@/domain/text";

export const MAX_FILE_BYTES = 200 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
export const MAX_TEXT_BYTES = 10 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 120 * 1024 * 1024;
export const MAX_PDF_BYTES = 200 * 1024 * 1024;

export const MAX_IMAGE_DIM = 12_000;
export const MAX_IMAGE_PIXELS = 40_000_000; // 40 MP -> ~160 MB RGBA max
export const MAX_PNG_DEFLATE_RATIO = 2500; // Guard against extreme PNG IDAT decompression bombs

export const EXT_MAP: Record<string, { kind: FileKind; mime: string; maxBytes: number }> = {
  pdf: { kind: "pdf", mime: "application/pdf", maxBytes: MAX_PDF_BYTES },
  png: { kind: "image", mime: "image/png", maxBytes: MAX_IMAGE_BYTES },
  jpg: { kind: "image", mime: "image/jpeg", maxBytes: MAX_IMAGE_BYTES },
  jpeg: { kind: "image", mime: "image/jpeg", maxBytes: MAX_IMAGE_BYTES },
  webp: { kind: "image", mime: "image/webp", maxBytes: MAX_IMAGE_BYTES },
  txt: { kind: "text", mime: "text/plain", maxBytes: MAX_TEXT_BYTES },
  md: { kind: "markdown", mime: "text/markdown", maxBytes: MAX_TEXT_BYTES },
  markdown: { kind: "markdown", mime: "text/markdown", maxBytes: MAX_TEXT_BYTES },
  mp3: { kind: "audio", mime: "audio/mpeg", maxBytes: MAX_AUDIO_BYTES },
  wav: { kind: "audio", mime: "audio/wav", maxBytes: MAX_AUDIO_BYTES },
  ogg: { kind: "audio", mime: "audio/ogg", maxBytes: MAX_AUDIO_BYTES },
  oga: { kind: "audio", mime: "audio/ogg", maxBytes: MAX_AUDIO_BYTES },
  m4a: { kind: "audio", mime: "audio/mp4", maxBytes: MAX_AUDIO_BYTES },
  aac: { kind: "audio", mime: "audio/aac", maxBytes: MAX_AUDIO_BYTES },
  webm: { kind: "audio", mime: "audio/webm", maxBytes: MAX_AUDIO_BYTES },
  flac: { kind: "audio", mime: "audio/flac", maxBytes: MAX_AUDIO_BYTES },
};

export interface Validated {
  ok: true;
  kind: FileKind;
  mime: string;
  name: string;
  width?: number;
  height?: number;
}

export type ValidationFailureReason =
  | "type"
  | "size"
  | "empty"
  | "mismatch"
  | "binary_text"
  | "bad_encoding"
  | "dimensions"
  | "corrupt";

export type ValidationResult = Validated | { ok: false; reason: ValidationFailureReason };

const ascii = (b: Uint8Array, from: number, s: string): boolean => {
  if (from < 0 || from + s.length > b.length) return false;
  for (let i = 0; i < s.length; i++) {
    if (b[from + i] !== s.charCodeAt(i)) return false;
  }
  return true;
};

const u16be = (b: Uint8Array, o: number) => ((b[o] << 8) | b[o + 1]) >>> 0;
const u16le = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8)) >>> 0;
const u32be = (b: Uint8Array, o: number) =>
  (((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
const u32le = (b: Uint8Array, o: number) =>
  ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0);

function checkDims(width: number, height: number, fileSize: number, kindMime: string): { ok: true; width: number; height: number } | { ok: false; reason: "dimensions" | "corrupt" } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { ok: false, reason: "corrupt" };
  }
  if (width > MAX_IMAGE_DIM || height > MAX_IMAGE_DIM || width * height > MAX_IMAGE_PIXELS) {
    return { ok: false, reason: "dimensions" };
  }
  // If PNG raw uncompressed RGBA pixel payload exceeds compressed file by extreme ratio, reject decompression bomb
  if (kindMime === "image/png") {
    const rawBytes = width * height * 4;
    if (fileSize > 0 && rawBytes / fileSize > MAX_PNG_DEFLATE_RATIO && rawBytes > 48_000_000) {
      return { ok: false, reason: "dimensions" };
    }
  }
  return { ok: true, width, height };
}

export function inspectPng(b: Uint8Array, totalSize: number): { ok: true; width: number; height: number } | { ok: false; reason: "mismatch" | "dimensions" | "corrupt" } {
  // 8-byte PNG signature + 4-byte len + 4-byte "IHDR" + 13-byte IHDR + 4-byte CRC = 33 bytes min
  if (b.length < 33) return { ok: false, reason: "mismatch" };
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < sig.length; i++) {
    if (b[i] !== sig[i]) return { ok: false, reason: "mismatch" };
  }
  const ihdrLen = u32be(b, 8);
  if (ihdrLen !== 13 || !ascii(b, 12, "IHDR")) return { ok: false, reason: "corrupt" };
  const width = u32be(b, 16);
  const height = u32be(b, 20);
  const bitDepth = b[24];
  const colorType = b[25];
  const comp = b[26];
  const filter = b[27];
  const interlace = b[28];
  if (![1, 2, 4, 8, 16].includes(bitDepth)) return { ok: false, reason: "corrupt" };
  if (![0, 2, 3, 4, 6].includes(colorType)) return { ok: false, reason: "corrupt" };
  if (comp !== 0 || filter !== 0 || (interlace !== 0 && interlace !== 1)) return { ok: false, reason: "corrupt" };
  return checkDims(width, height, totalSize, "image/png");
}

export function inspectJpeg(b: Uint8Array, totalSize: number): { ok: true; width: number; height: number } | { ok: false; reason: "mismatch" | "dimensions" | "corrupt" } {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) {
    return { ok: false, reason: "mismatch" };
  }
  let pos = 2;
  while (pos + 3 < b.length) {
    if (b[pos] !== 0xff) return { ok: false, reason: "corrupt" };
    while (pos < b.length && b[pos] === 0xff) pos++;
    if (pos >= b.length) break;
    const marker = b[pos++];
    if (marker === 0xd9 || marker === 0xda) break; // EOI or SOS (headers finished)
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    if (pos + 1 >= b.length) return { ok: false, reason: "corrupt" };
    const segLen = u16be(b, pos);
    if (segLen < 2 || pos + segLen > b.length) {
      // Segment extends past our header sample; if huge header > 64KB, cannot safely verify SOF or malformed
      return { ok: false, reason: "corrupt" };
    }
    // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      if (segLen < 7) return { ok: false, reason: "corrupt" };
      const height = u16be(b, pos + 3);
      const width = u16be(b, pos + 5);
      return checkDims(width, height, totalSize, "image/jpeg");
    }
    pos += segLen;
  }
  return { ok: false, reason: "corrupt" };
}

export function inspectWebp(b: Uint8Array, totalSize: number): { ok: true; width: number; height: number } | { ok: false; reason: "mismatch" | "dimensions" | "corrupt" } {
  if (b.length < 30 || !ascii(b, 0, "RIFF") || !ascii(b, 8, "WEBP")) {
    return { ok: false, reason: "mismatch" };
  }
  const riffSize = u32le(b, 4);
  if (riffSize < 12 || riffSize + 8 > totalSize + 8) return { ok: false, reason: "corrupt" };

  let width = 0;
  let height = 0;
  if (ascii(b, 12, "VP8X") && b.length >= 30) {
    width = (b[24] | (b[25] << 8) | (b[26] << 16)) + 1;
    height = (b[27] | (b[28] << 8) | (b[29] << 16)) + 1;
  } else if (ascii(b, 12, "VP8L") && b.length >= 25) {
    if (b[20] !== 0x2f) return { ok: false, reason: "corrupt" };
    const bits = u32le(b, 21);
    width = (bits & 0x3fff) + 1;
    height = ((bits >> 14) & 0x3fff) + 1;
  } else if (ascii(b, 12, "VP8 ") && b.length >= 30) {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return { ok: false, reason: "corrupt" };
    width = u16le(b, 26) & 0x3fff;
    height = u16le(b, 28) & 0x3fff;
  } else {
    return { ok: false, reason: "corrupt" };
  }
  return checkDims(width, height, totalSize, "image/webp");
}

export function sniffAudio(b: Uint8Array, rawMime: string): boolean {
  if (b.length < 12) return false;
  const mime = rawMime.split(";")[0].trim().toLowerCase();
  if (mime === "audio/mpeg") {
    if (ascii(b, 0, "ID3")) return true;
    // MPEG audio frame sync: 11 set bits + valid version (!= 01) + layer (!= 00)
    if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) {
      const version = (b[1] >> 3) & 0x03;
      const layer = (b[1] >> 1) & 0x03;
      return version !== 1 && layer !== 0;
    }
    return false;
  }
  if (mime === "audio/aac") {
    if (ascii(b, 0, "ID3")) return true;
    return b[0] === 0xff && (b[1] & 0xf6) === 0xf0; // ADTS sync
  }
  if (mime === "audio/wav") {
    return ascii(b, 0, "RIFF") && ascii(b, 8, "WAVE");
  }
  if (mime === "audio/ogg") {
    return ascii(b, 0, "OggS");
  }
  if (mime === "audio/flac") {
    return ascii(b, 0, "fLaC");
  }
  if (mime === "audio/mp4") {
    return ascii(b, 4, "ftyp");
  }
  if (mime === "audio/webm") {
    if (b[0] !== 0x1a || b[1] !== 0x45 || b[2] !== 0xdf || b[3] !== 0xa3) return false;
    const s = Array.from(b.subarray(0, Math.min(256, b.length)), (c) => String.fromCharCode(c)).join("");
    return s.includes("webm") || s.includes("matroska");
  }
  return false;
}

function asciiPrintable(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

export async function validateBlobStructure(
  blob: Blob,
  kind: FileKind,
  mime: string
): Promise<{ ok: true; width?: number; height?: number } | { ok: false; reason: ValidationFailureReason }> {
  if (blob.size === 0) return { ok: false, reason: "empty" };

  switch (kind) {
    case "pdf": {
      const headBytes = new Uint8Array(await blob.slice(0, Math.min(1024, blob.size)).arrayBuffer());
      const headStr = asciiPrintable(headBytes);
      if (!/%PDF-[12]\.\d/.test(headStr)) return { ok: false, reason: "mismatch" };
      const tailStart = Math.max(0, blob.size - 4096);
      const tailBytes = new Uint8Array(await blob.slice(tailStart, blob.size).arrayBuffer());
      const tailStr = asciiPrintable(tailBytes);
      if (!tailStr.includes("%%EOF")) return { ok: false, reason: "corrupt" };
      return { ok: true };
    }
    case "image": {
      const sampleSize = mime === "image/jpeg" ? 262_144 : 4096;
      const head = new Uint8Array(await blob.slice(0, Math.min(sampleSize, blob.size)).arrayBuffer());
      const res =
        mime === "image/png"
          ? inspectPng(head, blob.size)
          : mime === "image/jpeg"
          ? inspectJpeg(head, blob.size)
          : inspectWebp(head, blob.size);
      if (!res.ok) return { ok: false, reason: res.reason };
      return { ok: true, width: res.width, height: res.height };
    }
    case "audio": {
      const head = new Uint8Array(await blob.slice(0, Math.min(256, blob.size)).arrayBuffer());
      if (!sniffAudio(head, mime)) return { ok: false, reason: "mismatch" };
      return { ok: true };
    }
    case "text":
    case "markdown": {
      const dec = new TextDecoder("utf-8", { fatal: true });
      const CHUNK = 65_536;
      for (let off = 0; off < blob.size; off += CHUNK) {
        const chunk = new Uint8Array(await blob.slice(off, Math.min(blob.size, off + CHUNK)).arrayBuffer());
        if (chunk.includes(0)) return { ok: false, reason: "binary_text" };
        try {
          dec.decode(chunk, { stream: off + CHUNK < blob.size });
        } catch {
          return { ok: false, reason: "bad_encoding" };
        }
      }
      return { ok: true };
    }
  }
}

export async function validateFileCore(file: File, maxBytes?: number): Promise<ValidationResult> {
  const name = sanitizeFileName(file.name);
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const def = EXT_MAP[ext];
  if (!def) return { ok: false, reason: "type" };
  if (file.size === 0) return { ok: false, reason: "empty" };
  const cap = maxBytes !== undefined ? Math.min(maxBytes, def.maxBytes) : def.maxBytes;
  if (file.size > cap) return { ok: false, reason: "size" };

  const check = await validateBlobStructure(file, def.kind, def.mime);
  if (!check.ok) return check;
  return {
    ok: true,
    kind: def.kind,
    mime: def.mime,
    name,
    width: check.width,
    height: check.height,
  };
}

export async function sha256Blob(blob: Blob): Promise<string> {
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
