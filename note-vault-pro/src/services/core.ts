// Application services – shared primitives: ids, settings, activity log, trash (soft delete / restore / purge).
import { db } from "@/data/db";
import type { Activity, TrashItem, TrashKind } from "@/data/types";
import { reindex, removeDocs } from "./search";

export function uid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const r = await db.appSettings.get(key);
  return r ? (r.value as T) : fallback;
}
export async function setSetting(key: string, value: unknown) {
  await db.appSettings.put({ key, value });
}

export async function logActivity(kind: string, label: string, refKind?: string, refId?: string) {
  try {
    const a: Activity = { id: uid(), kind, label: label.slice(0, 200), refKind, refId, createdAt: Date.now() };
    await db.activities.add(a);
    const n = await db.activities.count();
    if (n > 600) {
      const old = await db.activities.orderBy("createdAt").limit(n - 500).primaryKeys();
      await db.activities.bulkDelete(old);
    }
  } catch {
    /* activity logging must never break user flows */
  }
}

// ---------------------------------------------------------------- Trash

export async function softDelete(kind: TrashKind, id: string): Promise<string> {
  const trashId = uid();
  const t = Date.now();
  let label = "";
  const subjectIds: string[] = [];
  const lectureIds: string[] = [];
  const noteIds: string[] = [];
  const attIds: string[] = [];
  const recIds: string[] = [];
  await db.transaction("rw", [db.subjects, db.lectures, db.notes, db.attachments, db.recordings, db.trashItems], async () => {
    const mark = { deletedAt: t, trashId };
    if (kind === "subject") {
      const s = await db.subjects.get(id);
      if (!s || s.deletedAt) throw new Error("NOT_FOUND");
      label = s.name;
      subjectIds.push(id);
      (await db.lectures.where("subjectId").equals(id).filter((x) => !x.deletedAt).primaryKeys()).forEach((k) => lectureIds.push(k));
      (await db.notes.where("subjectId").equals(id).filter((x) => !x.deletedAt).primaryKeys()).forEach((k) => noteIds.push(k));
      (await db.attachments.where("subjectId").equals(id).filter((x) => !x.deletedAt).primaryKeys()).forEach((k) => attIds.push(k));
      (await db.recordings.where("subjectId").equals(id).filter((x) => !x.deletedAt).primaryKeys()).forEach((k) => recIds.push(k));
    } else if (kind === "lecture") {
      const l = await db.lectures.get(id);
      if (!l || l.deletedAt) throw new Error("NOT_FOUND");
      label = l.title;
      lectureIds.push(id);
      (await db.notes.where("lectureId").equals(id).filter((x) => !x.deletedAt).primaryKeys()).forEach((k) => noteIds.push(k));
      (await db.attachments.where("lectureId").equals(id).filter((x) => !x.deletedAt).primaryKeys()).forEach((k) => attIds.push(k));
      (await db.recordings.where("lectureId").equals(id).filter((x) => !x.deletedAt).primaryKeys()).forEach((k) => recIds.push(k));
    } else if (kind === "note") {
      const n = await db.notes.get(id);
      if (!n || n.deletedAt) throw new Error("NOT_FOUND");
      label = n.title || "(untitled)";
      noteIds.push(id);
      (await db.attachments.where("noteId").equals(id).filter((x) => !x.deletedAt).primaryKeys()).forEach((k) => attIds.push(k));
    } else {
      const a = await db.attachments.get(id);
      if (!a || a.deletedAt) throw new Error("NOT_FOUND");
      label = a.name;
      attIds.push(id);
      (await db.recordings.where("attachmentId").equals(id).filter((x) => !x.deletedAt).primaryKeys()).forEach((k) => recIds.push(k));
    }
    await db.subjects.where("id").anyOf(subjectIds).modify(mark);
    await db.lectures.where("id").anyOf(lectureIds).modify(mark);
    await db.notes.where("id").anyOf(noteIds).modify(mark);
    await db.attachments.where("id").anyOf(attIds).modify(mark);
    if (recIds.length) await db.recordings.where("id").anyOf(recIds).modify(mark);
    const item: TrashItem = { id: trashId, kind, refId: id, label, deletedAt: t };
    await db.trashItems.add(item);
  });
  await removeDocs([
    ...subjectIds.map((i) => `subject:${i}`),
    ...lectureIds.map((i) => `lecture:${i}`),
    ...noteIds.map((i) => `note:${i}`),
    ...attIds.flatMap((i) => [`file:${i}`, `pdf:${i}`]),
  ]);
  await logActivity("delete", label, kind, id);
  return trashId;
}

export async function restoreTrash(trashId: string) {
  const item = await db.trashItems.get(trashId);
  if (!item) throw new Error("NOT_FOUND");
  const subj: string[] = [];
  const lec: string[] = [];
  const nts: string[] = [];
  const atts: string[] = [];
  const recs: string[] = [];
  await db.transaction("rw", [db.subjects, db.lectures, db.notes, db.attachments, db.recordings, db.trashItems], async () => {
    const q = { trashId };
    if (item.kind === "lecture") {
      const l = await db.lectures.get(item.refId);
      const s = l && (await db.subjects.get(l.subjectId));
      if (!s || s.deletedAt) throw new Error("PARENT_TRASHED");
    }
    const clear = (t: { deletedAt?: number; trashId?: string }) => {
      delete t.deletedAt;
      delete t.trashId;
    };
    (await db.subjects.where("trashId").equals(q.trashId).primaryKeys()).forEach((k) => subj.push(k));
    (await db.lectures.where("trashId").equals(q.trashId).primaryKeys()).forEach((k) => lec.push(k));
    (await db.notes.where("trashId").equals(q.trashId).primaryKeys()).forEach((k) => nts.push(k));
    (await db.attachments.where("trashId").equals(q.trashId).primaryKeys()).forEach((k) => atts.push(k));
    (await db.recordings.where("trashId").equals(q.trashId).primaryKeys()).forEach((k) => recs.push(k));
    await db.subjects.where("id").anyOf(subj).modify(clear);
    await db.lectures.where("id").anyOf(lec).modify(clear);
    await db.notes.where("id").anyOf(nts).modify(clear);
    await db.attachments.where("id").anyOf(atts).modify(clear);
    if (recs.length) await db.recordings.where("id").anyOf(recs).modify(clear);
    // Detach restored children from parents that are still in the trash (prevents dangling references)
    const live = async (table: typeof db.lectures | typeof db.subjects | typeof db.notes, id?: string) => {
      if (!id) return true;
      const r = await table.get(id);
      return !!r && !r.deletedAt;
    };
    for (const id of nts) {
      const n = await db.notes.get(id);
      if (!n) continue;
      const patch: Record<string, undefined> = {};
      if (n.lectureId && !(await live(db.lectures, n.lectureId))) patch.lectureId = undefined;
      if (n.subjectId && !(await live(db.subjects, n.subjectId))) patch.subjectId = undefined;
      if (Object.keys(patch).length) await db.notes.update(id, patch);
    }
    for (const id of atts) {
      const a = await db.attachments.get(id);
      if (!a) continue;
      const patch: Record<string, undefined> = {};
      if (a.noteId && !(await live(db.notes, a.noteId))) patch.noteId = undefined;
      if (a.lectureId && !(await live(db.lectures, a.lectureId))) patch.lectureId = undefined;
      if (a.subjectId && !(await live(db.subjects, a.subjectId))) patch.subjectId = undefined;
      if (Object.keys(patch).length) await db.attachments.update(id, patch);
    }
    await db.trashItems.delete(trashId);
  });
  for (const i of subj) await reindex("subject", i);
  for (const i of lec) await reindex("lecture", i);
  for (const i of nts) await reindex("note", i);
  for (const i of atts) await reindex("attachment", i);
  await logActivity("restore", item.label, item.kind, item.refId);
}

/** Permanently deletes attachments, their derived data and unreferenced blobs. */
export async function purgeAttachments(ids: string[]) {
  if (!ids.length) return;
  const atts = (await db.attachments.bulkGet(ids)).filter(Boolean);
  const linkedRecs = await db.recordings.where("attachmentId").anyOf(ids).toArray();
  const recIds = linkedRecs.map((r) => r.id);
  const chunks = recIds.length ? await db.recordingChunks.where("recordingId").anyOf(recIds).toArray() : [];
  const blobIds = Array.from(new Set([...atts.map((a) => a!.blobId), ...chunks.map((c) => c.blobId)]));
  await db.transaction(
    "rw",
    [db.attachments, db.blobs, db.pdfDocuments, db.bookmarks, db.highlights, db.annotations, db.flashcards, db.recordings, db.recordingChunks, db.recordingMarkers, db.transcriptSegments],
    async () => {
      await db.attachments.bulkDelete(ids);
      await db.pdfDocuments.bulkDelete(ids);
      await db.bookmarks.where("attachmentId").anyOf(ids).delete();
      await db.highlights.where("attachmentId").anyOf(ids).delete();
      await db.annotations.where("attachmentId").anyOf(ids).delete();
      await db.flashcards.where("deckId").notEqual("").filter((c) => !!c.imageId && ids.includes(c.imageId)).modify({ imageId: undefined });
      if (recIds.length) {
        await db.recordings.bulkDelete(recIds);
        await db.recordingChunks.where("recordingId").anyOf(recIds).delete();
        await db.recordingMarkers.where("recordingId").anyOf(recIds).delete();
        await db.transcriptSegments.where("recordingId").anyOf(recIds).delete();
      }
      for (const b of blobIds) {
        const stillAtt = await db.attachments.where("blobId").equals(b).count();
        const stillChunk = await db.recordingChunks.where("blobId").equals(b).count();
        if (stillAtt === 0 && stillChunk === 0) await db.blobs.delete(b);
      }
    }
  );
  await removeDocs(ids.flatMap((i) => [`file:${i}`, `pdf:${i}`]));
}

export async function purgeTrash(trashId: string) {
  const item = await db.trashItems.get(trashId);
  const [subj, lec, nts, atts, recs] = await Promise.all([
    db.subjects.where("trashId").equals(trashId).primaryKeys(),
    db.lectures.where("trashId").equals(trashId).primaryKeys(),
    db.notes.where("trashId").equals(trashId).primaryKeys(),
    db.attachments.where("trashId").equals(trashId).primaryKeys(),
    db.recordings.where("trashId").equals(trashId).primaryKeys(),
  ]);
  await purgeAttachments(atts);
  const extraChunks = recs.length ? await db.recordingChunks.where("recordingId").anyOf(recs).toArray() : [];
  await db.transaction(
    "rw",
    [db.subjects, db.lectures, db.notes, db.noteVersions, db.noteTags, db.trashItems, db.flashcardDecks, db.quizzes, db.references, db.events, db.flashcards, db.recordings, db.recordingChunks, db.recordingMarkers, db.transcriptSegments, db.blobs, db.attachments],
    async () => {
      await db.noteVersions.where("noteId").anyOf(nts).delete();
      await db.noteTags.where("noteId").anyOf(nts).delete();
      await db.notes.bulkDelete(nts);
      await db.lectures.bulkDelete(lec);
      if (recs.length) {
        await db.recordings.bulkDelete(recs);
        await db.recordingChunks.where("recordingId").anyOf(recs).delete();
        await db.recordingMarkers.where("recordingId").anyOf(recs).delete();
        await db.transcriptSegments.where("recordingId").anyOf(recs).delete();
        for (const c of extraChunks) {
          const stillAtt = await db.attachments.where("blobId").equals(c.blobId).count();
          const stillChunk = await db.recordingChunks.where("blobId").equals(c.blobId).count();
          if (stillAtt === 0 && stillChunk === 0) await db.blobs.delete(c.blobId);
        }
      }
      if (subj.length) {
        await db.flashcardDecks.where("subjectId").anyOf(subj).modify({ subjectId: undefined });
        await db.flashcards.where("subjectId").anyOf(subj).modify({ subjectId: undefined });
        await db.quizzes.where("subjectId").anyOf(subj).modify({ subjectId: undefined });
        await db.references.where("subjectId").anyOf(subj).modify({ subjectId: undefined });
        await db.events.where("subjectId").anyOf(subj).modify({ subjectId: undefined });
      }
      await db.subjects.bulkDelete(subj);
      await db.trashItems.delete(trashId);
    }
  );
  if (item) await logActivity("purge", item.label, item.kind);
}

export async function emptyTrash() {
  const items = await db.trashItems.toArray();
  for (const i of items) await purgeTrash(i.id);
}
