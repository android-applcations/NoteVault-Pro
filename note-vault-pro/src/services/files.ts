// Application services – attachments, file vault, PDF metadata.
import { db } from "@/data/db";
import type { Annotation, Attachment, Bookmark, FileCategory, Highlight, HighlightRect, PdfDocument } from "@/data/types";
import { safeHexColor } from "@/domain/sanitize";
import { sanitizeFileName } from "@/domain/text";
import { compressImage, imageThumb, sha256, validateFile, type ValidationResult } from "@/files/validate";
import { getSetting, logActivity, softDelete, uid } from "./core";
import { reindex } from "./search";
import { checkStorageQuota } from "./storage";

export interface FileLink {
  subjectId?: string;
  lectureId?: string;
  noteId?: string;
}
export type AddFailure = Exclude<ValidationResult, { ok: true }>["reason"] | "quota" | "error";
export interface AddResult {
  name: string;
  ok: boolean;
  attachment?: Attachment;
  reason?: AddFailure;
  deduped?: boolean;
}

async function resolveLink(link: FileLink): Promise<FileLink> {
  const out = { ...link };
  if (out.noteId) {
    const n = await db.notes.get(out.noteId);
    if (!n) throw new Error("NOT_FOUND");
    out.lectureId = out.lectureId ?? n.lectureId;
    out.subjectId = out.subjectId ?? n.subjectId;
  }
  if (out.lectureId) {
    const l = await db.lectures.get(out.lectureId);
    if (!l) throw new Error("NOT_FOUND");
    out.subjectId = l.subjectId;
  }
  return out;
}

export async function addFile(file: File, link: FileLink = {}, opts: { category?: FileCategory; keepOriginal?: boolean } = {}): Promise<AddResult> {
  const v = await validateFile(file);
  if (!v.ok) return { name: file.name, ok: false, reason: v.reason };
  try {
    const keepOriginal = opts.keepOriginal ?? (await getSetting<boolean>("keepOriginalImages", false));
    let blob: Blob = file.slice(0, file.size, v.mime); // MIME set from verified type
    const originalSize = blob.size;
    if (v.kind === "image" && !keepOriginal) blob = await compressImage(blob, v.mime);
    const hash = await sha256(blob);
    const linked = await resolveLink(link);
    const existing = await db.attachments.where("hash").equals(hash).first();
    if (!existing) {
      const q = await checkStorageQuota(blob.size);
      if (!q.ok) return { name: file.name, ok: false, reason: "quota" };
    }
    const t = Date.now();
    const att: Attachment = {
      id: uid(), name: v.name, kind: v.kind, mime: blob.type || v.mime, size: blob.size, category: opts.category ?? (v.kind === "image" ? "board" : "lecture"),
      description: "", ...linked, blobId: existing ? existing.blobId : "", hash, createdAt: t, updatedAt: t,
      originalSize: originalSize !== blob.size ? originalSize : undefined, thumb: existing?.thumb,
    };
    if (!att.blobId) att.blobId = att.id;
    if (v.kind === "image" && !att.thumb) att.thumb = await imageThumb(blob);
    await db.transaction("rw", [db.attachments, db.blobs], async () => {
      if (!existing) await db.blobs.put({ id: att.blobId, blob });
      await db.attachments.add(att);
    });
    await reindex("attachment", att.id);
    await logActivity("upload", att.name, "attachment", att.id);
    if (v.kind === "pdf") void processPdf(att.id).catch(() => undefined);
    return { name: att.name, ok: true, attachment: att, deduped: !!existing };
  } catch (e) {
    const quota = e instanceof DOMException && (e.name === "QuotaExceededError" || e.name === "DataError");
    return { name: file.name, ok: false, reason: quota || (e as { name?: string })?.name === "QuotaExceededError" ? "quota" : "error" };
  }
}

export async function addFiles(files: File[], link: FileLink = {}, opts: { category?: FileCategory } = {}): Promise<AddResult[]> {
  const out: AddResult[] = [];
  for (const f of files) out.push(await addFile(f, link, opts)); // sequential: bounded memory for large batches
  return out;
}

export const DEFAULT_PDF_INDEX_LIMIT = 1500;
const activePdfIndexers = new Map<string, AbortController>();

export function pausePdfIndexing(attId: string) {
  activePdfIndexers.get(attId)?.abort();
}

export function isPdfIndexing(attId: string): boolean {
  return activePdfIndexers.has(attId);
}

/** Extracts text/page count/thumbnail incrementally from a stored PDF and updates the search index. */
export async function processPdf(
  attId: string,
  opts: { continueFrom?: boolean; limit?: number } = {}
) {
  if (activePdfIndexers.has(attId)) return;
  const att = await db.attachments.get(attId);
  if (!att || att.kind !== "pdf") return;
  const existing = await db.pdfDocuments.get(attId);
  if (existing?.indexed && (existing.indexedPages ?? existing.pageTexts.length) >= existing.pages) return;
  if (existing?.indexStatus === "paused" && !opts.continueFrom) return;
  if (existing?.indexStatus === "partial" && !opts.continueFrom) return;

  const rec = await db.blobs.get(att.blobId);
  if (!rec) return;

  const configuredLimit = Number(await getSetting<number>("pdfIndexLimit", DEFAULT_PDF_INDEX_LIMIT)) || DEFAULT_PDF_INDEX_LIMIT;
  const batchLimit = Math.max(50, Math.min(20_000, Math.round(opts.limit ?? configuredLimit)));
  const startPage = opts.continueFrom && existing ? (existing.indexedPages ?? existing.pageTexts.length) + 1 : 1;
  const maxPages = startPage - 1 + batchLimit;

  const ac = new AbortController();
  activePdfIndexers.set(attId, ac);
  const { extractPdfIncremental } = await import("@/files/pdf");

  try {
    await db.pdfDocuments.put({
      id: attId,
      pages: existing?.pages ?? 0,
      indexedPages: existing?.indexedPages ?? existing?.pageTexts.length ?? 0,
      indexStatus: "indexing",
      lastPage: existing?.lastPage ?? 1,
      zoom: existing?.zoom ?? 1.2,
      pageTexts: existing?.pageTexts ?? [],
      indexed: false,
      updatedAt: Date.now(),
    });

    const res = await extractPdfIncremental(rec.blob, {
      startPage,
      maxPages,
      existingTexts: existing?.pageTexts ?? [],
      signal: ac.signal,
      generateThumb: startPage === 1 && !att.thumb,
      batchSize: 25,
      onBatch: async (state) => {
        const cur = await db.pdfDocuments.get(attId);
        await db.pdfDocuments.put({
          id: attId,
          pages: state.pages,
          indexedPages: state.indexedPages,
          indexStatus: "indexing",
          lastPage: cur?.lastPage ?? existing?.lastPage ?? 1,
          zoom: cur?.zoom ?? existing?.zoom ?? 1.2,
          pageTexts: state.pageTexts,
          indexed: false,
          updatedAt: Date.now(),
        });
        if (state.thumb) {
          await db.attachments.where("blobId").equals(att.blobId).modify({ thumb: state.thumb });
        }
      },
    });

    const allDone = res.indexedPages >= res.pages;
    const status: PdfDocument["indexStatus"] = res.aborted
      ? "paused"
      : allDone
      ? "done"
      : "partial";
    const cur = await db.pdfDocuments.get(attId);
    const doc: PdfDocument = {
      id: attId,
      pages: res.pages,
      indexedPages: res.indexedPages,
      indexStatus: status,
      lastPage: cur?.lastPage ?? existing?.lastPage ?? 1,
      zoom: cur?.zoom ?? existing?.zoom ?? 1.2,
      pageTexts: res.pageTexts,
      indexed: allDone,
      updatedAt: Date.now(),
    };
    await db.transaction("rw", [db.pdfDocuments, db.attachments], async () => {
      await db.pdfDocuments.put(doc);
      if (res.thumb) await db.attachments.where("blobId").equals(att.blobId).modify({ thumb: res.thumb });
    });
  } catch {
    const cur = await db.pdfDocuments.get(attId);
    // Corrupt or unreadable PDF: keep already-extracted progress without crashing
    await db.pdfDocuments.put({
      id: attId,
      pages: cur?.pages ?? existing?.pages ?? 0,
      indexedPages: cur?.indexedPages ?? existing?.indexedPages ?? 0,
      indexStatus: "error",
      lastPage: cur?.lastPage ?? existing?.lastPage ?? 1,
      zoom: cur?.zoom ?? existing?.zoom ?? 1.2,
      pageTexts: cur?.pageTexts ?? existing?.pageTexts ?? [],
      indexed: true,
      updatedAt: Date.now(),
    });
  } finally {
    activePdfIndexers.delete(attId);
  }
  await reindex("attachment", attId);
}

export async function updateAttachment(id: string, patch: Partial<Pick<Attachment, "name" | "description" | "category" | "subjectId" | "lectureId" | "noteId">>) {
  const p = { ...patch, updatedAt: Date.now() };
  if (p.name !== undefined) {
    p.name = sanitizeFileName(p.name);
  }
  if (patch.lectureId) {
    const l = await db.lectures.get(patch.lectureId);
    if (l) p.subjectId = l.subjectId;
  }
  await db.attachments.update(id, p);
  await reindex("attachment", id);
}

export const deleteAttachment = (id: string) => softDelete("attachment", id);

/** Links an existing file to another note/lecture/subject without duplicating its stored blob. */
export async function linkAttachment(id: string, target: FileLink): Promise<Attachment> {
  const src = await db.attachments.get(id);
  if (!src) throw new Error("NOT_FOUND");
  const linked = await resolveLink(target);
  const t = Date.now();
  const copy: Attachment = { ...src, id: uid(), subjectId: linked.subjectId, lectureId: linked.lectureId, noteId: linked.noteId, createdAt: t, updatedAt: t };
  await db.attachments.add(copy);
  const pdf = await db.pdfDocuments.get(id);
  if (pdf) await db.pdfDocuments.put({ ...pdf, id: copy.id, updatedAt: t });
  await reindex("attachment", copy.id);
  return copy;
}

export async function getBlob(att: Attachment): Promise<Blob | null> {
  const r = await db.blobs.get(att.blobId);
  return r ? r.blob : null;
}

export async function downloadAttachment(att: Attachment) {
  const blob = await getBlob(att);
  if (!blob) throw new Error("NOT_FOUND");
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = sanitizeFileName(att.name);
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Generates a thumbnail on demand (used after "clean previews"). */
export async function ensureThumb(att: Attachment): Promise<string | undefined> {
  if (att.thumb) return att.thumb;
  if (att.kind === "image") {
    const b = await getBlob(att);
    if (!b) return undefined;
    const t = await imageThumb(b);
    if (t) await db.attachments.where("blobId").equals(att.blobId).modify({ thumb: t });
    return t;
  }
  if (att.kind === "pdf") {
    const b = await getBlob(att);
    if (!b) return undefined;
    const { extractPdfIncremental } = await import("@/files/pdf");
    const r = await extractPdfIncremental(b, { maxPages: 0, generateThumb: true });
    if (r.thumb) await db.attachments.where("blobId").equals(att.blobId).modify({ thumb: r.thumb });
    return r.thumb;
  }
  return undefined;
}

// ---------------------------------------------------------- PDF extras
export async function savePdfView(id: string, patch: { lastPage?: number; zoom?: number }) {
  const updated = await db.pdfDocuments.where("id").equals(id).modify({ ...patch, updatedAt: Date.now() });
  if (!updated) {
    await db.pdfDocuments.put({
      id,
      pages: 0,
      indexedPages: 0,
      indexStatus: "idle",
      lastPage: patch.lastPage ?? 1,
      zoom: patch.zoom ?? 1.2,
      pageTexts: [],
      indexed: false,
      updatedAt: Date.now(),
    });
  }
}
export async function toggleBookmark(attachmentId: string, page: number, label = ""): Promise<boolean> {
  const ex = await db.bookmarks.where("attachmentId").equals(attachmentId).filter((b) => b.page === page).first();
  if (ex) {
    await db.bookmarks.delete(ex.id);
    return false;
  }
  const b: Bookmark = { id: uid(), attachmentId, page, label: label.trim(), createdAt: Date.now() };
  await db.bookmarks.add(b);
  return true;
}
export async function addAnnotation(attachmentId: string, page: number, text: string) {
  const t = Date.now();
  const a: Annotation = { id: uid(), attachmentId, page, text: text.trim(), createdAt: t, updatedAt: t };
  if (!a.text) throw new Error("EMPTY");
  await db.annotations.add(a);
  return a;
}
export async function addHighlight(attachmentId: string, page: number, text: string, color = "#fde047", rects?: HighlightRect[]) {
  const clean = text.replace(/\s+/g, " ").trim().slice(0, 2000);
  if (!clean) throw new Error("EMPTY");
  const cleanRects = Array.isArray(rects) && rects.length
    ? rects
        .slice(0, 200)
        .map((r) => ({
          x: Math.min(1, Math.max(0, Number(r.x) || 0)),
          y: Math.min(1, Math.max(0, Number(r.y) || 0)),
          w: Math.min(1, Math.max(0, Number(r.w) || 0)),
          h: Math.min(1, Math.max(0, Number(r.h) || 0)),
        }))
        .filter((r) => r.w > 0 && r.h > 0)
    : undefined;
  const h: Highlight = {
    id: uid(),
    attachmentId,
    page,
    text: clean,
    color: safeHexColor(color, "#fde047"),
    ...(cleanRects?.length ? { rects: cleanRects } : {}),
    createdAt: Date.now(),
  };
  await db.highlights.add(h);
  return h;
}
