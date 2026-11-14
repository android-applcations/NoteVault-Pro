import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/data/db";
import { sanitizeDoc } from "@/domain/sanitize";
import { plainFromDoc } from "@/domain/text";
import { exportBackup, parseBackup, applyBackup } from "@/services/backup";
import { purgeTrash, restoreTrash, uid } from "@/services/core";
import { createSubject, createLecture } from "@/services/library";
import { createNote, getVersions } from "@/services/notes";
import {
  addRecordingMarker,
  appendRecordingChunk,
  createLinkedLectureNote,
  deleteRecording,
  deleteRecordingMarker,
  deleteTranscriptSegment,
  discardRecordingSession,
  finalizeRecordingSession,
  formatTranscriptExport,
  getRecordingBlob,
  insertTimestampIntoNote,
  insertTranscriptIntoNote,
  listIncompleteRecordings,
  mergeTranscriptWithNext,
  probeSupportedRecordingMime,
  recoverRecordingSession,
  renameRecording,
  saveTranscriptSegments,
  splitTranscriptSegment,
  startRecordingSessionRecord,
  updateRecordingMarker,
  updateTranscriptSegment,
} from "@/services/recordings";
import { rebuildIndex, search } from "@/services/search";
import { auditDatabaseIntegrity, cleanupOrphans, getStorageReport } from "@/services/storage";

// Valid minimal EBML/WebM audio header (includes DocType "webm") for realistic MIME sniffing & backup round-trip
function fakeWebmChunk(extraByte = 0x41): Blob {
  return new Blob(
    [
      new Uint8Array([
        0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01,
        0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d, // DocType: "webm"
        extraByte, 0x55, 0x66,
      ]),
    ],
    { type: "audio/webm" }
  );
}

async function clearDb() {
  await Promise.all(db.tables.map((t) => t.clear()));
}

describe("Lecture recording engine, recovery, markers, transcripts & note integration", () => {
  beforeEach(async () => {
    await clearDb();
  });

  it("probes recording MIME safely even when MediaRecorder is unavailable", () => {
    const choice = probeSupportedRecordingMime();
    expect(choice.baseMime).toMatch(/^audio\//);
    expect(["webm", "m4a", "ogg"]).toContain(choice.ext);
  });

  it("records chunks sequentially, tracks live storage bytes, finalizes cleanly, and removes temporary chunks", async () => {
    const subj = await createSubject({ name: "Algorithms", code: "CS301" });
    const lec = await createLecture({ subjectId: subj.id, title: "Dynamic Programming", week: 2, date: "2026-11-14" });

    const rec = await startRecordingSessionRecord({
      lectureId: lec.id,
      subjectId: subj.id,
      title: "DP Lecture Part 1",
      mime: "audio/webm",
      ext: "webm",
    });

    await appendRecordingChunk({
      recordingId: rec.id,
      seq: 0,
      blob: fakeWebmChunk(0x11),
      mime: "audio/webm",
      durationMs: 15000,
      startMs: 0,
      endMs: 15000,
    });
    await appendRecordingChunk({
      recordingId: rec.id,
      seq: 1,
      blob: fakeWebmChunk(0x22),
      mime: "audio/webm",
      durationMs: 12000,
      startMs: 15000,
      endMs: 27000,
    });

    const reportMid = await getStorageReport();
    expect(reportMid.audioBytes).toBe(38);
    expect((await auditDatabaseIntegrity()).orphanBlobs).toBe(0);

    const { recording, attachment } = await finalizeRecordingSession(rec.id, 27000);
    expect(recording.status).toBe("ready");
    expect(recording.durationMs).toBe(27000);
    expect(attachment.kind).toBe("audio");
    expect(attachment.size).toBe(38);
    expect(await db.recordingChunks.where("recordingId").equals(rec.id).count()).toBe(0);
    expect((await auditDatabaseIntegrity()).orphanBlobs).toBe(0);

    const combined = await getRecordingBlob(recording);
    expect(combined?.size).toBe(38);
  });

  it("recovers interrupted recordings across simulated reload and cleans discarded sessions", async () => {
    const subj = await createSubject({ name: "Physics", code: "PH101" });
    const lec = await createLecture({ subjectId: subj.id, title: "Optics", week: 1, date: "2026-11-14" });

    const rec1 = await startRecordingSessionRecord({
      lectureId: lec.id,
      subjectId: subj.id,
      title: "Recovered Optics",
      mime: "audio/webm",
      ext: "webm",
    });
    await appendRecordingChunk({
      recordingId: rec1.id,
      seq: 0,
      blob: fakeWebmChunk(0x33),
      mime: "audio/webm",
      durationMs: 8000,
      startMs: 0,
      endMs: 8000,
    });

    const incomplete = await listIncompleteRecordings(lec.id);
    expect(incomplete.map((x) => x.id)).toEqual([rec1.id]);

    const recovered = await recoverRecordingSession(rec1.id);
    expect(recovered.recording.status).toBe("ready");
    expect(await listIncompleteRecordings(lec.id)).toHaveLength(0);

    const rec2 = await startRecordingSessionRecord({
      lectureId: lec.id,
      subjectId: subj.id,
      title: "Aborted Session",
      mime: "audio/webm",
      ext: "webm",
    });
    await appendRecordingChunk({
      recordingId: rec2.id,
      seq: 0,
      blob: fakeWebmChunk(0x44),
      mime: "audio/webm",
      durationMs: 4000,
      startMs: 0,
      endMs: 4000,
    });
    await discardRecordingSession(rec2.id);
    expect(await db.recordings.get(rec2.id)).toBeUndefined();
    expect((await auditDatabaseIntegrity()).orphanBlobs).toBe(0);
  });

  it("rejects empty finalize without losing metadata and guards against quota exhaustion", async () => {
    const subj = await createSubject({ name: "Chemistry", code: "CH101" });
    const lec = await createLecture({ subjectId: subj.id, title: "Bonds", week: 1, date: "2026-11-14" });
    const rec = await startRecordingSessionRecord({
      lectureId: lec.id,
      subjectId: subj.id,
      title: "Empty Check",
      mime: "audio/webm",
      ext: "webm",
    });
    await expect(finalizeRecordingSession(rec.id)).rejects.toThrow("EMPTY_RECORDING");

    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: {
        estimate: vi.fn().mockResolvedValue({ usage: 999_999_995, quota: 1_000_000_000 }),
      },
    });
    await expect(
      appendRecordingChunk({
        recordingId: rec.id,
        seq: 0,
        blob: fakeWebmChunk(0x55),
        mime: "audio/webm",
        durationMs: 1000,
        startMs: 0,
        endMs: 1000,
      })
    ).rejects.toThrow("QUOTA_EXCEEDED");

    Object.defineProperty(navigator, "storage", { configurable: true, value: undefined });
  });

  it("manages markers, transcript edits/splits/merges/exports, search indexing, and note timestamp insertion", async () => {
    const subj = await createSubject({ name: "Operating Systems", code: "CS320" });
    const lec = await createLecture({ subjectId: subj.id, title: "Paging", week: 4, date: "2026-11-14" });
    const rec = await startRecordingSessionRecord({
      lectureId: lec.id,
      subjectId: subj.id,
      title: "Virtual Memory Lecture",
      mime: "audio/webm",
      ext: "webm",
    });
    await appendRecordingChunk({
      recordingId: rec.id,
      seq: 0,
      blob: fakeWebmChunk(0x66),
      mime: "audio/webm",
      durationMs: 25000,
      startMs: 0,
      endMs: 25000,
    });
    const { recording, attachment } = await finalizeRecordingSession(rec.id, 25000);

    await renameRecording(recording.id, "Paging & TLB Cache");
    expect((await db.attachments.get(attachment.id))?.name).toBe("Paging & TLB Cache.webm");

    const marker = await addRecordingMarker({
      recordingId: recording.id,
      timeMs: 12000,
      label: "TLB Miss Explanation",
    });
    await updateRecordingMarker(marker.id, { label: "TLB Shootdown Diagram" });

    const savedSegs = await saveTranscriptSegments(recording.id, [
      { startMs: 0, endMs: 10000, text: "First part about page tables and second part about TLB hits", lang: "en" },
      { startMs: 10000, endMs: 20000, text: "شرح الذاكرة الافتراضية", lang: "ar" },
    ]);
    expect(savedSegs).toHaveLength(2);

    await splitTranscriptSegment(savedSegs[0].id);
    let allSegs = await db.transcriptSegments.where("recordingId").equals(recording.id).sortBy("order");
    expect(allSegs).toHaveLength(3);
    expect(allSegs.every((s) => s.editedManually || s.order === 2)).toBe(true);

    await mergeTranscriptWithNext(allSegs[0].id);
    allSegs = await db.transcriptSegments.where("recordingId").equals(recording.id).sortBy("order");
    expect(allSegs).toHaveLength(2);

    await updateTranscriptSegment(allSegs[1].id, { text: "شرح جدول الصفحات والذاكرة الافتراضية" });
    allSegs = await db.transcriptSegments.where("recordingId").equals(recording.id).sortBy("order");
    expect(allSegs[1].editedManually).toBe(true);

    // Search finds recording transcript and marker text under the audio attachment
    await rebuildIndex();
    const hitsAr = await search("جدول الصفحات");
    expect(hitsAr.some((h) => h.doc.refId === attachment.id)).toBe(true);
    const hitsMarker = await search("Shootdown");
    expect(hitsMarker.some((h) => h.doc.refId === attachment.id)).toBe(true);

    // Transcript exports (TXT / MD / SRT / VTT)
    const srt = formatTranscriptExport("Paging", allSegs, "srt");
    expect(srt).toContain("00:00:00,000 -->");
    const vtt = formatTranscriptExport("Paging", allSegs, "vtt");
    expect(vtt.startsWith("WEBVTT")).toBe(true);
    const md = formatTranscriptExport("Paging", allSegs, "md");
    expect(md).toContain("# Paging");

    // Note integration + audioTimestamp sanitization + plainFromDoc
    const note = await createLinkedLectureNote(lec.id, recording.id);
    await insertTimestampIntoNote(note.id, {
      recordingId: recording.id,
      attachmentId: attachment.id,
      timeMs: 12000,
      label: "Key formula",
    });
    await insertTranscriptIntoNote(note.id, {
      recordingId: recording.id,
      attachmentId: attachment.id,
      title: "Paging & TLB Cache",
      segments: allSegs,
    });
    const updatedNote = await db.notes.get(note.id);
    const sanitized = sanitizeDoc(updatedNote?.content);
    const plain = plainFromDoc(sanitized);
    expect(plain).toContain("[00:12 Key formula]");
    expect(plain).toContain("شرح جدول الصفحات");
    expect((await getVersions(note.id)).some((v) => v.label === "transcript")).toBe(true);

    // Delete transcript segment
    await deleteTranscriptSegment(allSegs[0].id);
    await deleteRecordingMarker(marker.id);
    expect(await db.transcriptSegments.where("recordingId").equals(recording.id).count()).toBe(1);

    // Export -> Replace Backup preserves v3 recording + transcript data
    const zip = await exportBackup();
    const file = new File([zip], "backup.zip", { type: "application/zip" });
    const parsed = await parseBackup(file);
    await clearDb();
    await applyBackup(parsed, "replace");
    expect(await db.recordings.get(recording.id)).toBeDefined();
    expect(await db.transcriptSegments.where("recordingId").equals(recording.id).count()).toBe(1);

    // Trash + Restore + Purge cascade cleanup
    await deleteRecording(recording.id);
    expect((await db.recordings.get(recording.id))?.deletedAt).toBeDefined();
    const trash = await db.trashItems.toArray();
    await restoreTrash(trash[0].id);
    expect((await db.recordings.get(recording.id))?.deletedAt).toBeUndefined();

    await deleteRecording(recording.id);
    const trash2 = await db.trashItems.toArray();
    await purgeTrash(trash2[0].id);
    expect(await db.recordings.get(recording.id)).toBeUndefined();
    expect(await db.transcriptSegments.where("recordingId").equals(recording.id).count()).toBe(0);
    expect((await auditDatabaseIntegrity()).orphanBlobs).toBe(0);
  });

  it("cleanupOrphans deletes dangling orphan chunks while protecting active chunk blobs", async () => {
    const subj = await createSubject({ name: "Bio", code: "BI101" });
    const lec = await createLecture({ subjectId: subj.id, title: "Cells", week: 1, date: "2026-11-14" });
    const rec = await startRecordingSessionRecord({
      lectureId: lec.id,
      subjectId: subj.id,
      title: "Active Session",
      mime: "audio/webm",
      ext: "webm",
    });
    const activeChunk = await appendRecordingChunk({
      recordingId: rec.id,
      seq: 0,
      blob: fakeWebmChunk(0x77),
      mime: "audio/webm",
      durationMs: 3000,
      startMs: 0,
      endMs: 3000,
    });

    // Inject dangling chunk pointing to non-existent recordingId
    const ghostRecId = uid();
    const ghostBlobId = uid();
    await db.blobs.put({ id: ghostBlobId, blob: fakeWebmChunk(0x88) });
    await db.recordingChunks.add({
      id: uid(),
      recordingId: ghostRecId,
      seq: 0,
      blobId: ghostBlobId,
      mime: "audio/webm",
      size: 12,
      durationMs: 1000,
      startMs: 0,
      endMs: 1000,
      createdAt: Date.now(),
    });

    const auditBefore = await auditDatabaseIntegrity();
    expect(auditBefore.orphanRecords).toBeGreaterThanOrEqual(1);

    await cleanupOrphans();
    expect(await db.blobs.get(activeChunk.blobId)).toBeDefined();
    expect(await db.blobs.get(ghostBlobId)).toBeUndefined();

    const note = await createNote({ title: "Temp Note", subjectId: subj.id });
    expect(note.id).toBeTruthy();
  });

  it("persists standalone recordings (without lectureId) through finalization and backup roundtrip", async () => {
    const rec = await startRecordingSessionRecord({
      title: "Standalone Physics Lecture",
      mime: "audio/webm",
      ext: "webm",
    });
    expect(rec.lectureId).toBeUndefined();

    await appendRecordingChunk({
      recordingId: rec.id,
      seq: 0,
      blob: fakeWebmChunk(0x91),
      mime: "audio/webm",
      durationMs: 2500,
      startMs: 0,
      endMs: 2500,
    });

    const finalized = await finalizeRecordingSession(rec.id, 2500);
    expect(finalized.recording.status).toBe("ready");
    expect(finalized.recording.lectureId).toBeUndefined();
    expect(finalized.attachment.lectureId).toBeUndefined();

    const archive = await exportBackup();
    const parsed = await parseBackup(new Uint8Array(await archive.arrayBuffer()));
    for (const t of db.tables) await t.clear();
    await applyBackup(parsed, "replace");

    const restored = await db.recordings.get(rec.id);
    expect(restored?.title).toBe("Standalone Physics Lecture");
    expect(restored?.lectureId).toBeUndefined();
  });
});
