// File processing layer – PDF.js wrapper. Loaded lazily (dynamic import) and fully local.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import workerCode from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?raw";

export type PDFDocumentProxy = pdfjs.PDFDocumentProxy;
export type PDFPageProxy = pdfjs.PDFPageProxy;
export { pdfjs };

let workerUrl: string | null = null;
function ensureWorker() {
  if (!workerUrl) {
    workerUrl = URL.createObjectURL(new Blob([workerCode], { type: "text/javascript" }));
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  }
}

export async function openPdf(blob: Blob): Promise<PDFDocumentProxy> {
  ensureWorker();
  const data = new Uint8Array(await blob.arrayBuffer());
  return pdfjs.getDocument({
    data,
    isEvalSupported: false, // never compile code from document content
    enableXfa: false,
    useSystemFonts: true,
    stopAtErrors: false,
  }).promise;
}

export interface PdfExtract {
  pages: number;
  pageTexts: string[];
  thumb?: string;
}

const MAX_PAGES_TO_INDEX = 1500;

export async function extractPdf(blob: Blob, onProgress?: (done: number, total: number) => void): Promise<PdfExtract> {
  const doc = await openPdf(blob);
  try {
    const pageTexts: string[] = [];
    const limit = Math.min(doc.numPages, MAX_PAGES_TO_INDEX);
    for (let i = 1; i <= limit; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      const text = tc.items.map((it) => ("str" in it ? it.str : "")).join(" ").replace(/\s+/g, " ").trim();
      pageTexts.push(text.slice(0, 60_000));
      page.cleanup();
      onProgress?.(i, limit);
      if (i % 5 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    for (let i = limit + 1; i <= doc.numPages; i++) pageTexts.push("");
    let thumb: string | undefined;
    try {
      const p1 = await doc.getPage(1);
      const v0 = p1.getViewport({ scale: 1 });
      const scale = 240 / Math.max(v0.width, v0.height);
      const vp = p1.getViewport({ scale });
      const c = document.createElement("canvas");
      c.width = Math.ceil(vp.width);
      c.height = Math.ceil(vp.height);
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      await p1.render({ canvasContext: ctx, viewport: vp, canvas: c }).promise;
      thumb = c.toDataURL("image/jpeg", 0.7);
    } catch {
      thumb = undefined;
    }
    return { pages: doc.numPages, pageTexts, thumb };
  } finally {
    void doc.destroy();
  }
}
