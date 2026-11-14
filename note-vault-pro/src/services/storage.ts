// Application services – storage manager, quota checks, and orphan/integrity diagnostics.
import { db } from "@/data/db";
import { purgeAttachments } from "./core";

export interface StorageReport {
  notesBytes: number;
  pdfBytes: number;
  imageBytes: number;
  audioBytes: number;
  textBytes: number;
  filesBytes: number;
  previewBytes: number;
  total: number;
  usage?: number;
  quota?: number;
  persisted?: boolean;
  unlinked: { count: number; bytes: number };
}

export interface IntegrityReport {
  orphanBlobs: number;
  orphanBlobBytes: number;
  orphanRecords: number;
  missingBlobAttachments: number;
}

export async function checkStorageQuota(
  incomingBytes: number
): Promise<{ ok: boolean; usage?: number; quota?: number }> {
  try {
    const est = await navigator.storage?.estimate?.();
    const usage = est?.usage;
    const quota = est?.quota;
    if (typeof quota === "number" && quota > 0 && typeof usage === "number") {
      if (usage + incomingBytes > quota * 0.98) {
        return { ok: false, usage, quota };
      }
    }
    return { ok: true, usage, quota };
  } catch {
    return { ok: true };
  }
}

export async function getStorageReport(): Promise<StorageReport> {
  const notes = await db.notes.toArray();
  const versions = await db.noteVersions.toArray();
  const notesBytes =
    notes.reduce((s, n) => s + JSON.stringify(n.content ?? "").length * 2, 0) +
    versions.reduce((s, v) => s + JSON.stringify(v.content ?? "").length * 2, 0);
  const atts = await db.attachments.toArray();
  const seen = new Set<string>();
  const by = { pdf: 0, image: 0, audio: 0, text: 0 };
  let previewBytes = 0;
  for (const a of atts) {
    previewBytes += a.thumb ? a.thumb.length : 0;
    if (seen.has(a.blobId)) continue;
    seen.add(a.blobId);
    if (a.kind === "pdf") by.pdf += a.size;
    else if (a.kind === "image") by.image += a.size;
    else if (a.kind === "audio") by.audio += a.size;
    else by.text += a.size;
  }
  const pdfs = await db.pdfDocuments.toArray();
  const pdfTextBytes = pdfs.reduce((s, p) => s + p.pageTexts.reduce((x, t) => x + t.length * 2, 0), 0);
  const filesBytes = by.pdf + by.image + by.audio + by.text;
  const unl = atts.filter((a) => !a.deletedAt && !a.subjectId && !a.lectureId && !a.noteId);
  let usage: number | undefined, quota: number | undefined, persisted: boolean | undefined;
  try {
    const est = await navigator.storage?.estimate?.();
    usage = est?.usage;
    quota = est?.quota;
    persisted = await navigator.storage?.persisted?.();
  } catch {
    /* unsupported */
  }
  return {
    notesBytes,
    pdfBytes: by.pdf,
    imageBytes: by.image,
    audioBytes: by.audio,
    textBytes: by.text,
    filesBytes,
    previewBytes,
    total: notesBytes + filesBytes + previewBytes + pdfTextBytes,
    usage,
    quota,
    persisted,
    unlinked: { count: unl.length, bytes: unl.reduce((s, a) => s + a.size, 0) },
  };
}

export async function requestPersistence(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

/** Permanently deletes files not linked to any subject, lecture or note (explicit user action only). */
export async function deleteUnlinkedFiles(): Promise<number> {
  const ids = await db.attachments.filter((a) => !a.deletedAt && !a.subjectId && !a.lectureId && !a.noteId).primaryKeys();
  await purgeAttachments(ids);
  return ids.length;
}

export async function cleanPreviews(): Promise<number> {
  return db.attachments.filter((a) => !!a.thumb).modify({ thumb: undefined });
}

async function scanOrphans() {
  const [
    atts,
    blobKeys,
    notesKeys,
    tagKeys,
    cardKeys,
    quizKeys,
    subjectKeys,
    lectureKeys,
    pdfs,
    bookmarks,
    highlights,
    annotations,
    versions,
    noteTags,
    reviewLogs,
    questions,
    attempts,
    trashItems,
  ] = await Promise.all([
    db.attachments.toArray(),
    db.blobs.toCollection().primaryKeys(),
    db.notes.toCollection().primaryKeys(),
    db.tags.toCollection().primaryKeys(),
    db.flashcards.toCollection().primaryKeys(),
    db.quizzes.toCollection().primaryKeys(),
    db.subjects.toCollection().primaryKeys(),
    db.lectures.toCollection().primaryKeys(),
    db.pdfDocuments.toCollection().primaryKeys(),
    db.bookmarks.toArray(),
    db.highlights.toArray(),
    db.annotations.toArray(),
    db.noteVersions.toArray(),
    db.noteTags.toArray(),
    db.reviewLogs.toArray(),
    db.quizQuestions.toArray(),
    db.quizAttempts.toArray(),
    db.trashItems.toArray(),
  ]);

  const attSet = new Set(atts.map((a) => a.id));
  const usedBlobSet = new Set(atts.map((a) => a.blobId));
  const blobSet = new Set(blobKeys);
  const noteSet = new Set(notesKeys);
  const tagSet = new Set(tagKeys);
  const cardSet = new Set(cardKeys);
  const quizSet = new Set(quizKeys);
  const subjectSet = new Set(subjectKeys);
  const lectureSet = new Set(lectureKeys);

  const orphanBlobIds = blobKeys.filter((id) => !usedBlobSet.has(id));
  let orphanBlobBytes = 0;
  for (const id of orphanBlobIds) {
    const rec = await db.blobs.get(id);
    if (rec) orphanBlobBytes += rec.blob.size;
  }

  const missingBlobAttachments = atts.filter((a) => !blobSet.has(a.blobId)).length;
  const orphanPdfIds = pdfs.filter((id) => !attSet.has(id));
  const orphanBookmarkIds = bookmarks.filter((r) => !attSet.has(r.attachmentId)).map((r) => r.id);
  const orphanHighlightIds = highlights.filter((r) => !attSet.has(r.attachmentId)).map((r) => r.id);
  const orphanAnnotationIds = annotations.filter((r) => !attSet.has(r.attachmentId)).map((r) => r.id);
  const orphanVersionIds = versions.filter((r) => !noteSet.has(r.noteId)).map((r) => r.id);
  const orphanNoteTagIds = noteTags.filter((r) => !noteSet.has(r.noteId) || !tagSet.has(r.tagId)).map((r) => r.id);
  const orphanReviewLogIds = reviewLogs.filter((r) => !cardSet.has(r.cardId)).map((r) => r.id);
  const orphanQuestionIds = questions.filter((r) => !quizSet.has(r.quizId)).map((r) => r.id);
  const orphanAttemptIds = attempts.filter((r) => !quizSet.has(r.quizId)).map((r) => r.id);
  const orphanTrashIds = trashItems
    .filter((t) => {
      if (t.kind === "subject") return !subjectSet.has(t.refId);
      if (t.kind === "lecture") return !lectureSet.has(t.refId);
      if (t.kind === "note") return !noteSet.has(t.refId);
      return !attSet.has(t.refId);
    })
    .map((t) => t.id);

  const orphanRecords =
    orphanPdfIds.length +
    orphanBookmarkIds.length +
    orphanHighlightIds.length +
    orphanAnnotationIds.length +
    orphanVersionIds.length +
    orphanNoteTagIds.length +
    orphanReviewLogIds.length +
    orphanQuestionIds.length +
    orphanAttemptIds.length +
    orphanTrashIds.length;

  return {
    orphanBlobIds,
    orphanBlobBytes,
    orphanRecords,
    missingBlobAttachments,
    orphanPdfIds,
    orphanBookmarkIds,
    orphanHighlightIds,
    orphanAnnotationIds,
    orphanVersionIds,
    orphanNoteTagIds,
    orphanReviewLogIds,
    orphanQuestionIds,
    orphanAttemptIds,
    orphanTrashIds,
  };
}

export async function auditDatabaseIntegrity(): Promise<IntegrityReport> {
  const s = await scanOrphans();
  return {
    orphanBlobs: s.orphanBlobIds.length,
    orphanBlobBytes: s.orphanBlobBytes,
    orphanRecords: s.orphanRecords,
    missingBlobAttachments: s.missingBlobAttachments,
  };
}

export async function cleanupOrphans(): Promise<{ blobsRemoved: number; bytesReclaimed: number; recordsRemoved: number }> {
  const s = await scanOrphans();
  if (!s.orphanBlobIds.length && !s.orphanRecords) {
    return { blobsRemoved: 0, bytesReclaimed: 0, recordsRemoved: 0 };
  }
  await db.transaction(
    "rw",
    [
      db.blobs,
      db.pdfDocuments,
      db.bookmarks,
      db.highlights,
      db.annotations,
      db.noteVersions,
      db.noteTags,
      db.reviewLogs,
      db.quizQuestions,
      db.quizAttempts,
      db.trashItems,
    ],
    async () => {
      if (s.orphanBlobIds.length) await db.blobs.bulkDelete(s.orphanBlobIds);
      if (s.orphanPdfIds.length) await db.pdfDocuments.bulkDelete(s.orphanPdfIds);
      if (s.orphanBookmarkIds.length) await db.bookmarks.bulkDelete(s.orphanBookmarkIds);
      if (s.orphanHighlightIds.length) await db.highlights.bulkDelete(s.orphanHighlightIds);
      if (s.orphanAnnotationIds.length) await db.annotations.bulkDelete(s.orphanAnnotationIds);
      if (s.orphanVersionIds.length) await db.noteVersions.bulkDelete(s.orphanVersionIds);
      if (s.orphanNoteTagIds.length) await db.noteTags.bulkDelete(s.orphanNoteTagIds);
      if (s.orphanReviewLogIds.length) await db.reviewLogs.bulkDelete(s.orphanReviewLogIds);
      if (s.orphanQuestionIds.length) await db.quizQuestions.bulkDelete(s.orphanQuestionIds);
      if (s.orphanAttemptIds.length) await db.quizAttempts.bulkDelete(s.orphanAttemptIds);
      if (s.orphanTrashIds.length) await db.trashItems.bulkDelete(s.orphanTrashIds);
    }
  );
  return {
    blobsRemoved: s.orphanBlobIds.length,
    bytesReclaimed: s.orphanBlobBytes,
    recordsRemoved: s.orphanRecords,
  };
}
