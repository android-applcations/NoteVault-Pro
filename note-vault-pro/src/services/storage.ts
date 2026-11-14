// Application services – storage manager.
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

export async function getStorageReport(): Promise<StorageReport> {
  const notes = await db.notes.toArray();
  const versions = await db.noteVersions.toArray();
  const notesBytes = notes.reduce((s, n) => s + JSON.stringify(n.content ?? "").length * 2, 0) + versions.reduce((s, v) => s + JSON.stringify(v.content ?? "").length * 2, 0);
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
    notesBytes, pdfBytes: by.pdf, imageBytes: by.image, audioBytes: by.audio, textBytes: by.text, filesBytes, previewBytes,
    total: notesBytes + filesBytes + previewBytes + pdfTextBytes, usage, quota, persisted,
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
