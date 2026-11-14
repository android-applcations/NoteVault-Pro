import "fake-indexeddb/auto";
import Dexie from "dexie";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, VaultDB } from "@/data/db";
import { addFile } from "@/services/files";
import { createNote } from "@/services/notes";
import { auditDatabaseIntegrity, checkStorageQuota, cleanupOrphans } from "@/services/storage";

async function wipe() {
  for (const t of db.tables) await t.clear();
}

describe("Database v2 migration, quota guards & orphan cleanup", () => {
  beforeEach(async () => {
    await wipe();
    vi.restoreAllMocks();
  });

  it("migrates v1 IndexedDB to v2 cleanly and backfills pdfDocuments & schemaVersion", async () => {
    const dbName = `nv-mig-${Date.now()}`;
    const v1 = new Dexie(dbName);
    v1.version(1).stores({
      semesters: "id, archived, startDate, updatedAt",
      subjects: "id, semesterId, archived, deletedAt, trashId, updatedAt",
      lectures: "id, subjectId, week, date, archived, deletedAt, trashId, updatedAt",
      notes: "id, subjectId, lectureId, kind, pinned, favorite, archived, deletedAt, trashId, updatedAt",
      noteVersions: "id, noteId, createdAt",
      attachments: "id, subjectId, lectureId, noteId, blobId, hash, kind, category, size, deletedAt, trashId, createdAt",
      blobs: "id",
      pdfDocuments: "id",
      bookmarks: "id, attachmentId",
      highlights: "id, attachmentId",
      annotations: "id, attachmentId",
      flashcardDecks: "id, subjectId",
      flashcards: "id, deckId, subjectId, due, state",
      reviewLogs: "id, cardId, reviewedAt",
      quizzes: "id, subjectId, semesterId",
      quizQuestions: "id, quizId",
      quizAttempts: "id, quizId, finishedAt",
      references: "id, subjectId, type",
      tags: "id, &name",
      noteTags: "id, noteId, tagId, [noteId+tagId]",
      searchIndex: "id, kind, refId, subjectId",
      activities: "id, createdAt",
      appSettings: "key",
      trashItems: "id, kind, deletedAt",
      events: "id, date, subjectId",
    });
    await v1.open();
    await v1.table("pdfDocuments").put({
      id: "att-1",
      pages: 12,
      lastPage: 4,
      zoom: 1.5,
      pageTexts: ["hello"],
      indexed: true,
      updatedAt: 1000,
    });
    v1.close();

    const v2 = new VaultDB(dbName);
    await v2.open();
    const migrated = await v2.pdfDocuments.get("att-1");
    expect(migrated?.indexStatus).toBe("done");
    expect(migrated?.indexedPages).toBe(12);
    expect((await v2.appSettings.get("schemaVersion"))?.value).toBe(2);
    v2.close();
    await Dexie.delete(dbName);
  });

  it("audits and cleans orphan blobs and dangling derived records without touching valid user data", async () => {
    const note = await createNote({ title: "Kept Note" });
    const f = new File(["real text"], "real.txt", { type: "text/plain" });
    const uploaded = await addFile(f, { noteId: note.id });
    expect(uploaded.ok).toBe(true);

    // Seed orphans across multiple tables
    await db.blobs.put({ id: "orphan-blob-1", blob: new Blob(["1234567890"]) });
    await db.highlights.put({ id: "orphan-hl", attachmentId: "missing-att", page: 1, text: "x", color: "#fde047", createdAt: 1 });
    await db.bookmarks.put({ id: "orphan-bm", attachmentId: "missing-att", page: 2, label: "x", createdAt: 1 });
    await db.noteVersions.put({ id: "orphan-ver", noteId: "missing-note", title: "old", content: null, text: "", hash: "", createdAt: 1 });
    await db.trashItems.put({ id: "orphan-tr", kind: "note", refId: "missing-note", label: "x", deletedAt: 1 });

    const before = await auditDatabaseIntegrity();
    expect(before.orphanBlobs).toBe(1);
    expect(before.orphanBlobBytes).toBe(10);
    expect(before.orphanRecords).toBe(4);
    expect(before.missingBlobAttachments).toBe(0);

    const cleaned = await cleanupOrphans();
    expect(cleaned).toEqual({ blobsRemoved: 1, bytesReclaimed: 10, recordsRemoved: 4 });

    const after = await auditDatabaseIntegrity();
    expect(after).toEqual({ orphanBlobs: 0, orphanBlobBytes: 0, orphanRecords: 0, missingBlobAttachments: 0 });

    // Valid user data untouched
    expect(await db.notes.get(note.id)).toBeDefined();
    expect(await db.attachments.get(uploaded.attachment!.id)).toBeDefined();
    expect(await db.blobs.get(uploaded.attachment!.blobId)).toBeDefined();
  });

  it("enforces storage quota guard before large uploads", async () => {
    const prev = Object.getOwnPropertyDescriptor(navigator, "storage");
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: { estimate: vi.fn().mockResolvedValue({ usage: 99_000_000, quota: 100_000_000 }) },
    });
    try {
      expect((await checkStorageQuota(500_000)).ok).toBe(false);
      const f = new File(["small file"], "quota.txt", { type: "text/plain" });
      const res = await addFile(f);
      expect(res).toEqual({ name: "quota.txt", ok: false, reason: "quota" });
    } finally {
      if (prev) Object.defineProperty(navigator, "storage", prev);
      else delete (navigator as unknown as { storage?: unknown }).storage;
    }
  });
});
