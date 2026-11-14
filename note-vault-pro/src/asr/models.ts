// ASR catalog & integrity verification primitives.
import type { AsrModelRecord } from "@/data/types";

export const ASR_MODEL_CACHE = "nv-asr-models-v1";
export const ASR_LOCAL_ORIGIN = "https://nv-local-asr";

export interface AsrCatalogEntry {
  id: string;
  nameAr: string;
  nameEn: string;
  descriptionAr: string;
  descriptionEn: string;
  repoId: string;
  languages: string[];
  supportsArabic: boolean;
  supportsEnglish: boolean;
  supportsAuto: boolean;
  approxBytes: number;
  files: string[];
  expectedSha256?: Record<string, string>;
}

const WHISPER_COMMON_FILES = [
  "config.json",
  "generation_config.json",
  "preprocessor_config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "onnx/encoder_model_quantized.onnx",
  "onnx/decoder_model_merged_quantized.onnx",
];

export const ASR_CATALOG: AsrCatalogEntry[] = [
  {
    id: "whisper-tiny",
    nameAr: "Whisper Tiny (متعدد اللغات)",
    nameEn: "Whisper Tiny (Multilingual)",
    descriptionAr: "خفيف وسريع، يدعم العربية والإنجليزية والكشف التلقائي (~41 MB).",
    descriptionEn: "Fast & compact, supports Arabic, English, and auto-detect (~41 MB).",
    repoId: "Xenova/whisper-tiny",
    languages: ["ar", "en", "auto"],
    supportsArabic: true,
    supportsEnglish: true,
    supportsAuto: true,
    approxBytes: 43_000_000,
    files: WHISPER_COMMON_FILES,
  },
  {
    id: "whisper-base",
    nameAr: "Whisper Base (دقة أعلى للعربية)",
    nameEn: "Whisper Base (Higher accuracy)",
    descriptionAr: "دقة أفضل للمحاضرات العربية والمصطلحات المختلطة (~74 MB).",
    descriptionEn: "Higher accuracy for Arabic lectures and mixed terminology (~74 MB).",
    repoId: "Xenova/whisper-base",
    languages: ["ar", "en", "auto"],
    supportsArabic: true,
    supportsEnglish: true,
    supportsAuto: true,
    approxBytes: 78_000_000,
    files: WHISPER_COMMON_FILES,
  },
  {
    id: "whisper-tiny.en",
    nameAr: "Whisper Tiny English (إنجليزي فقط)",
    nameEn: "Whisper Tiny English (EN only)",
    descriptionAr: "مخصص للمحاضرات الإنجليزية فقط (~41 MB — لا يدعم العربية).",
    descriptionEn: "Dedicated to English-only lectures (~41 MB — does not support Arabic).",
    repoId: "Xenova/whisper-tiny.en",
    languages: ["en"],
    supportsArabic: false,
    supportsEnglish: true,
    supportsAuto: false,
    approxBytes: 43_000_000,
    files: WHISPER_COMMON_FILES,
  },
];

export function catalogFileUrl(repoId: string, filePath: string): string {
  return `https://huggingface.co/${repoId}/resolve/main/${filePath}`;
}

export function localCacheKey(modelId: string, filePath: string): string {
  const clean = filePath.replace(/^\/+/, "");
  return `${ASR_LOCAL_ORIGIN}/${encodeURIComponent(modelId)}/${clean}`;
}

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  }
  throw new Error("WEBCRYPTO_UNAVAILABLE");
}

/** Structural validation so HTML error pages / truncated payloads are rejected immediately. */
export function validateModelAssetBytes(filePath: string, bytes: Uint8Array): boolean {
  if (!bytes || bytes.byteLength === 0) return false;
  if (filePath.endsWith(".json")) {
    try {
      const txt = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const parsed = JSON.parse(txt) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
      if (filePath === "config.json" && parsed.model_type !== "whisper" && parsed.model_type !== "lite-whisper") {
        return false;
      }
      if (filePath === "tokenizer.json" && !("model" in parsed)) return false;
      return true;
    } catch {
      return false;
    }
  }
  if (filePath.endsWith(".onnx")) {
    // Reject obvious HTML/text responses disguised as .onnx
    const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, Math.min(64, bytes.byteLength))).trimStart().toLowerCase();
    if (head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("{")) return false;
    return bytes.byteLength >= 32;
  }
  return true;
}

export function modelSupportsLanguage(
  model: AsrModelRecord | undefined | null,
  lang: "auto" | "ar" | "en"
): boolean {
  if (!model || model.status !== "ready") return false;
  if (lang === "en") return model.languages.includes("en") || model.languages.includes("multilingual");
  if (lang === "ar") return model.languages.includes("ar") || model.languages.includes("multilingual");
  return model.languages.includes("auto") || model.languages.includes("ar");
}

export function detectLanguagesFromConfigs(
  config: Record<string, unknown>,
  genConfig?: Record<string, unknown>
): string[] {
  const isMultilingual = genConfig?.is_multilingual ?? config.is_multilingual;
  const langMap = (genConfig?.lang_to_id as Record<string, unknown> | undefined) ?? {};
  const langs = new Set<string>(["en"]);
  if (isMultilingual !== false) {
    if ("<|ar|>" in langMap || Object.keys(langMap).length === 0) {
      langs.add("ar");
    }
    langs.add("auto");
  }
  return Array.from(langs);
}
