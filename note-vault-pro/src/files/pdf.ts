// File processing layer – PDF.js wrapper. Loaded lazily (dynamic import) and fully local.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

export type PDFDocumentProxy = pdfjs.PDFDocumentProxy;
export type PDFPageProxy = pdfjs.PDFPageProxy;
export { pdfjs };

export const DEFAULT_PDF_INDEX_LIMIT = 1500;
const RANGE_THRESHOLD_BYTES = 2 * 1024 * 1024;
const RANGE_CHUNK_SIZE = 65_536;

let workerConfigured = false;
function ensureWorker() {
  if (!workerConfigured && typeof window !== "undefined") {
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
    workerConfigured = true;
  }
}

export class BlobRangeTransport extends pdfjs.PDFDataRangeTransport {
  private readonly blob: Blob;
  constructor(blob: Blob) {
    super(blob.size, null);
    this.blob = blob;
  }
  override requestDataRange(begin: number, end: number) {
    const start = Math.max(0, begin);
    const stop = Math.min(this.blob.size, end);
    this.blob
      .slice(start, stop)
      .arrayBuffer()
      .then((buf) => {
        this.onDataRange(start, new Uint8Array(buf));
      })
      .catch(() => undefined);
  }
}

export async function openPdf(blob: Blob): Promise<PDFDocumentProxy> {
  ensureWorker();
  if (blob.size <= RANGE_THRESHOLD_BYTES) {
    const data = new Uint8Array(await blob.arrayBuffer());
    return pdfjs.getDocument({
      data,
      isEvalSupported: false, // never compile code from document content
      enableXfa: false,
      useSystemFonts: true,
      stopAtErrors: false,
    }).promise;
  }
  // Stream ranges on demand for large PDFs so the whole file is never duplicated in RAM.
  return pdfjs.getDocument({
    range: new BlobRangeTransport(blob),
    rangeChunkSize: RANGE_CHUNK_SIZE,
    disableStream: true,
    disableAutoFetch: true,
    isEvalSupported: false,
    enableXfa: false,
    useSystemFonts: true,
    stopAtErrors: false,
  }).promise;
}

export interface PdfExtract {
  pages: number;
  indexedPages: number;
  pageTexts: string[];
  thumb?: string;
  aborted?: boolean;
}

export interface IncrementalPdfOptions {
  startPage?: number;
  maxPages?: number;
  existingTexts?: string[];
  signal?: AbortSignal;
  generateThumb?: boolean;
  batchSize?: number;
  onBatch?: (state: {
    pages: number;
    indexedPages: number;
    pageTexts: string[];
    thumb?: string;
    done: boolean;
  }) => Promise<void> | void;
}

export async function extractPdfIncremental(
  blob: Blob,
  opts: IncrementalPdfOptions = {}
): Promise<PdfExtract> {
  const doc = await openPdf(blob);
  try {
    const totalPages = doc.numPages;
    const startPage = Math.max(1, Math.min(totalPages + 1, opts.startPage ?? 1));
    const maxLimit = opts.maxPages ?? DEFAULT_PDF_INDEX_LIMIT;
    const targetEnd = Math.min(totalPages, maxLimit);
    const batchSize = Math.max(1, opts.batchSize ?? 25);

    const pageTexts = (opts.existingTexts ?? []).slice(0, startPage - 1);
    let thumb: string | undefined;

    if (opts.generateThumb !== false && startPage === 1 && totalPages >= 1 && typeof document !== "undefined") {
      try {
        const p1 = await doc.getPage(1);
        const v0 = p1.getViewport({ scale: 1 });
        const scale = 240 / Math.max(v0.width, v0.height);
        const vp = p1.getViewport({ scale });
        const c = document.createElement("canvas");
        c.width = Math.ceil(vp.width);
        c.height = Math.ceil(vp.height);
        const ctx = c.getContext("2d");
        if (ctx) {
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, c.width, c.height);
          await p1.render({ canvasContext: ctx, viewport: vp, canvas: c }).promise;
          thumb = c.toDataURL("image/jpeg", 0.7);
        }
        c.width = 0;
        c.height = 0;
        p1.cleanup();
      } catch {
        thumb = undefined;
      }
    }

    let aborted = false;
    for (let i = startPage; i <= targetEnd; i++) {
      if (opts.signal?.aborted) {
        aborted = true;
        break;
      }
      const page = await doc.getPage(i);
      try {
        const tc = await page.getTextContent();
        const text = tc.items
          .map((it) => ("str" in it ? it.str : ""))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        pageTexts.push(text.slice(0, 60_000));
      } finally {
        page.cleanup();
      }

      if (i % 50 === 0 && typeof doc.cleanup === "function") {
        await doc.cleanup();
      }

      const isBatchEnd = (i - startPage + 1) % batchSize === 0 || i === targetEnd;
      if (isBatchEnd && opts.onBatch) {
        await opts.onBatch({
          pages: totalPages,
          indexedPages: pageTexts.length,
          pageTexts: pageTexts.slice(),
          thumb,
          done: i === totalPages,
        });
      }
      if (i % 5 === 0) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    if (aborted && opts.onBatch) {
      await opts.onBatch({
        pages: totalPages,
        indexedPages: pageTexts.length,
        pageTexts: pageTexts.slice(),
        thumb,
        done: pageTexts.length >= totalPages,
      });
    } else if (startPage > targetEnd && opts.onBatch) {
      await opts.onBatch({
        pages: totalPages,
        indexedPages: pageTexts.length,
        pageTexts: pageTexts.slice(),
        thumb,
        done: pageTexts.length >= totalPages,
      });
    }

    return {
      pages: totalPages,
      indexedPages: pageTexts.length,
      pageTexts,
      thumb,
      aborted,
    };
  } finally {
    await doc.destroy().catch(() => undefined);
  }
}

export async function extractPdf(
  blob: Blob,
  onProgress?: (done: number, total: number) => void,
  opts?: { maxPages?: number; signal?: AbortSignal }
): Promise<PdfExtract> {
  return extractPdfIncremental(blob, {
    maxPages: opts?.maxPages,
    signal: opts?.signal,
    batchSize: 5,
    onBatch: (s) => onProgress?.(s.indexedPages, Math.min(s.pages, opts?.maxPages ?? DEFAULT_PDF_INDEX_LIMIT)),
  });
}
