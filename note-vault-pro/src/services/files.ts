// Application services – attachments, file vault, PDF metadata.
import { db } from "@/data/db";
import type { Annotation, Attachment, Bookmark, FileCategory, Highlight, PdfDocument } from "@/data/types";
import { sanitizeFileName } from "@/domain/text";
import { compressImage, imageThumb, sha256, validateFile, type ValidationResult } from "@/files/validate";
import { getSetting, logActivity, softDelete, uid } from "./core";
import { reindex } from "./search";

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

/** Extracts text/page count/thumbnail from a stored PDF and updates the search index. */
export async function processPdf(attId: string) {
  const att = await db.attachments.get(attId);
  if (!att || att.kind !== "pdf") return;
  const existing = await db.pdfDocuments.get(attId);
  if (existing?.indexed) return;
  const rec = await db.blobs.get(att.blobId);
  if (!rec) return;
  const { extractPdf } = await import("@/files/pdf");
  try {
    const res = await extractPdf(rec.blob);
    const doc: PdfDocument = {
      id: attId, pages: res.pages, lastPage: existing?.lastPage ?? 1, zoom: existing?.zoom ?? 1.2,
      pageTexts: res.pageTexts, indexed: true, updatedAt: Date.now(),
    };
    await db.transaction("rw", [db.pdfDocuments, db.attachments], async () => {
      await db.pdfDocuments.put(doc);
      if (res.thumb) await db.attachments.where("blobId").equals(att.blobId).modify({ thumb: res.thumb });
    });
  } catch {
    // Corrupt or unreadable PDF: keep the file, mark as processed without text
    await db.pdfDocuments.put({ id: attId, pages: existing?.pages ?? 0, lastPage: 1, zoom: 1.2, pageTexts: [], indexed: true, updatedAt: Date.now() });
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
    const { extractPdf } = await import("@/files/pdf");
    const r = await extractPdf(b);
    if (r.thumb) await db.attachments.where("blobId").equals(att.blobId).modify({ thumb: r.thumb });
    return r.thumb;
  }
  return undefined;
}

// ---------------------------------------------------------- PDF extras
export async function savePdfView(id: string, patch: { lastPage?: number; zoom?: number }) {
  await db.pdfDocuments.where("id").equals(id).modify(patch);
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
export async function addHighlight(attachmentId: string, page: number, text: string, color = "#fde047") {
  const clean = text.replace(/\s+/g, " ").trim().slice(0, 2000);
  if (!clean) throw new Error("EMPTY");
  const h: Highlight = { id: uid(), attachmentId, page, text: clean, color, createdAt: Date.now() };
  await db.highlights.add(h);
  return h;
}
