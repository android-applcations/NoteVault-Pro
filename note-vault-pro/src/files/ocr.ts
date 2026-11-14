// Offline OCR powered by local same-origin Tesseract.js worker + language packs in /ocr/.

export type OcrLang = "ara+eng" | "eng" | "ara";

const MAX_OCR_EDGE = 3000;

async function normalizeOcrInput(blob: Blob): Promise<Blob> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return blob;
  const bmp = await createImageBitmap(blob);
  try {
    const maxEdge = Math.max(bmp.width, bmp.height);
    if (maxEdge <= MAX_OCR_EDGE) return blob;
    const scale = MAX_OCR_EDGE / maxEdge;
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return blob;
    ctx.drawImage(bmp, 0, 0, w, h);
    const out = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
    canvas.width = 0;
    canvas.height = 0;
    return out ?? blob;
  } finally {
    bmp.close();
  }
}

export async function runImageOcr(
  blob: Blob,
  lang: OcrLang = "ara+eng",
  onProgress?: (percent: number) => void
): Promise<string> {
  const { createWorker } = await import("tesseract.js");
  const base = typeof document !== "undefined" ? document.baseURI : self.location.href;
  const workerPath = new URL("ocr/worker.min.js", base).href;
  const corePath = new URL("ocr", base).href;
  const langPath = new URL("ocr", base).href;

  const input = await normalizeOcrInput(blob);
  const worker = await createWorker(lang, 1, {
    workerPath,
    corePath,
    langPath,
    workerBlobURL: false,
    gzip: true,
    logger: (m) => {
      if (m?.status === "recognizing text" && typeof m.progress === "number") {
        onProgress?.(Math.round(m.progress * 100));
      }
    },
  });

  try {
    const {
      data: { text },
    } = await worker.recognize(input);
    return (text ?? "").trim();
  } finally {
    await worker.terminate().catch(() => undefined);
  }
}
