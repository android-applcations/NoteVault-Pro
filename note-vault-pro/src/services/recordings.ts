// Application services – progressive chunked lecture recording, crash recovery, markers, transcripts & note integration.
import type { JSONContent } from "@tiptap/core";
import { db } from "@/data/db";
import type {
  Attachment,
  LectureRecording,
  RecordingChunk,
  RecordingMarker,
  TranscriptSegment,
} from "@/data/types";
import { sanitizeDoc, safeHexColor } from "@/domain/sanitize";
import { formatDuration, sanitizeFileName } from "@/domain/text";
import { sha256 } from "@/files/validate";
import { logActivity, softDelete, uid } from "./core";
import { createNote, saveNoteContent } from "./notes";
import { reindex } from "./search";
import { checkStorageQuota } from "./storage";

export interface RecordingMimeChoice {
  mime: string;
  baseMime: string;
  ext: string;
}

const CANDIDATE_MIMES: RecordingMimeChoice[] = [
  { mime: "audio/webm;codecs=opus", baseMime: "audio/webm", ext: "webm" },
  { mime: "audio/webm", baseMime: "audio/webm", ext: "webm" },
  { mime: "audio/mp4;codecs=mp4a.40.2", baseMime: "audio/mp4", ext: "m4a" },
  { mime: "audio/mp4", baseMime: "audio/mp4", ext: "m4a" },
  { mime: "audio/ogg;codecs=opus", baseMime: "audio/ogg", ext: "ogg" },
  { mime: "audio/ogg", baseMime: "audio/ogg", ext: "ogg" },
];

/** Probes MediaRecorder support in browser preference order without allocating any stream. */
export function probeSupportedRecordingMime(): RecordingMimeChoice {
  if (typeof MediaRecorder === "undefined") {
    return CANDIDATE_MIMES[0];
  }
  const check = typeof MediaRecorder.isTypeSupported === "function" ? (m: string) => MediaRecorder.isTypeSupported(m) : null;
  if (check) {
    for (const c of CANDIDATE_MIMES) {
      try {
        if (check(c.mime)) return c;
      } catch {
        /* try next candidate */
      }
    }
  }
  return CANDIDATE_MIMES[1];
}

export async function startRecordingSessionRecord(input: {
  lectureId?: string;
  subjectId?: string;
  noteId?: string;
  title: string;
  mime: string;
  ext: string;
  deviceLabel?: string;
}): Promise<LectureRecording> {
  const now = Date.now();
  const cleanTitle = input.title.trim().slice(0, 200) || `Lecture Recording ${new Date(now).toLocaleTimeString()}`;
  const rec: LectureRecording = {
    id: uid(),
    lectureId: input.lectureId || undefined,
    subjectId: input.subjectId || undefined,
    noteId: input.noteId || undefined,
    title: cleanTitle,
    mime: input.mime,
    ext: input.ext,
    status: "recording",
    durationMs: 0,
    chunkCount: 0,
    totalBytes: 0,
    deviceLabel: input.deviceLabel?.slice(0, 180),
    transcriptionStatus: "idle",
    transcriptionLang: "auto",
    transcriptionProgress: 0,
    createdAt: now,
    updatedAt: now,
  };
  await db.recordings.add(rec);
  return rec;
}

export async function appendRecordingChunk(input: {
  recordingId: string;
  seq: number;
  blob: Blob;
  mime: string;
  durationMs: number;
  startMs: number;
  endMs: number;
}): Promise<RecordingChunk> {
  if (input.blob.size === 0) {
    throw new Error("EMPTY_CHUNK");
  }
  const quota = await checkStorageQuota(input.blob.size);
  if (!quota.ok) {
    throw new Error("QUOTA_EXCEEDED");
  }
  const now = Date.now();
  const chunkId = uid();
  const blobId = uid();
  const cleanMime = (input.mime || input.blob.type || "audio/webm").split(";")[0].trim().toLowerCase();
  const typedBlob = new Blob([input.blob], { type: cleanMime });
  const chunk: RecordingChunk = {
    id: chunkId,
    recordingId: input.recordingId,
    seq: input.seq,
    blobId,
    mime: cleanMime,
    size: typedBlob.size,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    startMs: Math.max(0, Math.round(input.startMs)),
    endMs: Math.max(0, Math.round(input.endMs)),
    createdAt: now,
  };

  try {
    await db.transaction("rw", [db.blobs, db.recordingChunks, db.recordings], async () => {
      await db.blobs.put({ id: blobId, blob: typedBlob });
      await db.recordingChunks.add(chunk);
      const cur = await db.recordings.get(input.recordingId);
      if (cur) {
        await db.recordings.update(input.recordingId, {
          chunkCount: cur.chunkCount + 1,
          totalBytes: cur.totalBytes + typedBlob.size,
          durationMs: Math.max(cur.durationMs, chunk.endMs),
          updatedAt: now,
        });
      }
    });
  } catch (e) {
    if (e instanceof DOMException && (e.name === "QuotaExceededError" || e.name === "DataError")) {
      throw new Error("QUOTA_EXCEEDED");
    }
    throw e;
  }
  return chunk;
}

export async function updateRecordingStatus(
  recordingId: string,
  patch: Partial<Pick<LectureRecording, "status" | "durationMs" | "title" | "noteId" | "errorDetail" | "transcriptionStatus" | "transcriptionLang" | "transcriptionModelId" | "transcriptionProgress" | "transcribedMs" | "transcriptionError">>
) {
  await db.recordings.update(recordingId, { ...patch, updatedAt: Date.now() });
}

/** Combines sequential chunks into a real audio Attachment without deleting chunks until safely saved. */
export async function finalizeRecordingSession(
  recordingId: string,
  finalDurationMs?: number
): Promise<{ recording: LectureRecording; attachment: Attachment }> {
  const rec = await db.recordings.get(recordingId);
  if (!rec) throw new Error("NOT_FOUND");
  await db.recordings.update(recordingId, { status: "finalizing", updatedAt: Date.now() });

  const chunks = await db.recordingChunks.where("recordingId").equals(recordingId).sortBy("seq");
  if (!chunks.length) {
    await db.recordings.update(recordingId, { status: "error", errorDetail: "EMPTY_RECORDING", updatedAt: Date.now() });
    throw new Error("EMPTY_RECORDING");
  }

  const blobRecs = await db.blobs.bulkGet(chunks.map((c) => c.blobId));
  const parts: Blob[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const b = blobRecs[i]?.blob;
    if (b && b.size > 0) parts.push(b);
  }
  const baseMime = (rec.mime || chunks[0].mime || "audio/webm").split(";")[0].trim().toLowerCase();
  const combined = new Blob(parts, { type: baseMime });
  if (combined.size === 0) {
    await db.recordings.update(recordingId, { status: "error", errorDetail: "EMPTY_RECORDING", updatedAt: Date.now() });
    throw new Error("EMPTY_RECORDING");
  }

  const hash = await sha256(combined);
  const ext = rec.ext || (baseMime.includes("mp4") ? "m4a" : baseMime.includes("ogg") ? "ogg" : "webm");
  const fileName = sanitizeFileName(`${rec.title}.${ext}`);
  const now = Date.now();
  const attId = uid();
  const attBlobId = uid();
  const durationMs = Math.max(
    rec.durationMs,
    finalDurationMs ?? 0,
    chunks[chunks.length - 1]?.endMs ?? 0
  );

  const att: Attachment = {
    id: attId,
    name: fileName,
    kind: "audio",
    mime: baseMime,
    size: combined.size,
    category: "lecture",
    description: "",
    subjectId: rec.subjectId,
    lectureId: rec.lectureId,
    noteId: rec.noteId,
    blobId: attBlobId,
    hash,
    createdAt: rec.createdAt,
    updatedAt: now,
  };

  try {
    // Step 1: Atomically commit final Attachment, unified Blob, and Recording ready state.
    await db.transaction("rw", [db.blobs, db.attachments, db.recordings], async () => {
      await db.blobs.put({ id: attBlobId, blob: combined });
      await db.attachments.add(att);
      await db.recordings.update(recordingId, {
        status: "ready",
        attachmentId: attId,
        durationMs,
        totalBytes: combined.size,
        updatedAt: now,
      });
    });
  } catch (e) {
    await db.recordings.update(recordingId, { status: "paused", updatedAt: Date.now() }).catch(() => undefined);
    if (e instanceof DOMException && (e.name === "QuotaExceededError" || e.name === "DataError")) {
      throw new Error("QUOTA_EXCEEDED");
    }
    throw e;
  }

  // Step 2: Only after final Attachment is durable on disk, purge temporary chunk rows & chunk blobs.
  const chunkIds = chunks.map((c) => c.id);
  const chunkBlobIds = chunks.map((c) => c.blobId);
  await db.transaction("rw", [db.recordingChunks, db.blobs, db.attachments], async () => {
    await db.recordingChunks.bulkDelete(chunkIds);
    for (const bid of chunkBlobIds) {
      if (bid === attBlobId) continue;
      const refAtt = await db.attachments.where("blobId").equals(bid).count();
      const refChunk = await db.recordingChunks.where("blobId").equals(bid).count();
      if (refAtt === 0 && refChunk === 0) await db.blobs.delete(bid);
    }
  });

  await reindex("attachment", att.id);
  await logActivity("record", rec.title, "attachment", att.id);
  const updatedRec = (await db.recordings.get(recordingId))!;
  return { recording: updatedRec, attachment: att };
}

export async function listIncompleteRecordings(lectureId?: string): Promise<LectureRecording[]> {
  const all = lectureId
    ? await db.recordings.where("lectureId").equals(lectureId).toArray()
    : await db.recordings.toArray();
  return all.filter(
    (r) => !r.deletedAt && (r.status === "recording" || r.status === "paused" || r.status === "finalizing")
  );
}

export async function recoverRecordingSession(recordingId: string) {
  return finalizeRecordingSession(recordingId);
}

export async function discardRecordingSession(recordingId: string) {
  const chunks = await db.recordingChunks.where("recordingId").equals(recordingId).toArray();
  const blobIds = chunks.map((c) => c.blobId);
  await db.transaction("rw", [db.recordings, db.recordingChunks, db.recordingMarkers, db.transcriptSegments, db.blobs, db.attachments], async () => {
    await db.recordingChunks.where("recordingId").equals(recordingId).delete();
    await db.recordingMarkers.where("recordingId").equals(recordingId).delete();
    await db.transcriptSegments.where("recordingId").equals(recordingId).delete();
    await db.recordings.delete(recordingId);
    for (const bid of blobIds) {
      const refAtt = await db.attachments.where("blobId").equals(bid).count();
      const refChunk = await db.recordingChunks.where("blobId").equals(bid).count();
      if (refAtt === 0 && refChunk === 0) await db.blobs.delete(bid);
    }
  });
}

export async function renameRecording(recordingId: string, title: string) {
  const clean = title.trim().slice(0, 200);
  if (!clean) throw new Error("TITLE_REQUIRED");
  const rec = await db.recordings.get(recordingId);
  if (!rec) throw new Error("NOT_FOUND");
  const now = Date.now();
  await db.recordings.update(recordingId, { title: clean, updatedAt: now });
  if (rec.attachmentId) {
    const ext = rec.ext || "webm";
    const fileName = sanitizeFileName(`${clean}.${ext}`);
    await db.attachments.update(rec.attachmentId, { name: fileName, updatedAt: now });
    await reindex("attachment", rec.attachmentId);
  }
}

export async function deleteRecording(recordingId: string) {
  const rec = await db.recordings.get(recordingId);
  if (!rec) return;
  if (rec.attachmentId) {
    const att = await db.attachments.get(rec.attachmentId);
    if (att && !att.deletedAt) {
      await softDelete("attachment", rec.attachmentId);
      return;
    }
  }
  await discardRecordingSession(recordingId);
}

export async function getRecordingBlob(rec: LectureRecording): Promise<Blob | null> {
  if (rec.attachmentId) {
    const att = await db.attachments.get(rec.attachmentId);
    if (att) {
      const b = await db.blobs.get(att.blobId);
      if (b) return b.blob;
    }
  }
  const chunks = await db.recordingChunks.where("recordingId").equals(rec.id).sortBy("seq");
  if (!chunks.length) return null;
  const blobs = await db.blobs.bulkGet(chunks.map((c) => c.blobId));
  const parts = blobs.map((x) => x?.blob).filter((x): x is Blob => !!x && x.size > 0);
  return parts.length ? new Blob(parts, { type: (rec.mime || "audio/webm").split(";")[0] }) : null;
}

// ---------------------------------------------------------------- Markers

export async function addRecordingMarker(input: {
  recordingId: string;
  timeMs: number;
  label: string;
  color?: string;
  noteId?: string;
}): Promise<RecordingMarker> {
  const now = Date.now();
  const marker: RecordingMarker = {
    id: uid(),
    recordingId: input.recordingId,
    timeMs: Math.max(0, Math.round(input.timeMs)),
    label: input.label.trim().slice(0, 280) || formatDuration(input.timeMs),
    color: input.color ? safeHexColor(input.color, "#0f9b8e") : undefined,
    noteId: input.noteId,
    createdAt: now,
    updatedAt: now,
  };
  await db.recordingMarkers.add(marker);
  const rec = await db.recordings.get(input.recordingId);
  if (rec?.attachmentId) await reindex("attachment", rec.attachmentId);
  return marker;
}

export async function updateRecordingMarker(id: string, patch: { label?: string; timeMs?: number; color?: string }) {
  const cur = await db.recordingMarkers.get(id);
  if (!cur) return;
  const next: Partial<RecordingMarker> = { updatedAt: Date.now() };
  if (patch.label !== undefined) next.label = patch.label.trim().slice(0, 280);
  if (patch.timeMs !== undefined) next.timeMs = Math.max(0, Math.round(patch.timeMs));
  if (patch.color !== undefined) next.color = safeHexColor(patch.color, "#0f9b8e");
  await db.recordingMarkers.update(id, next);
  const rec = await db.recordings.get(cur.recordingId);
  if (rec?.attachmentId) await reindex("attachment", rec.attachmentId);
}

export async function deleteRecordingMarker(id: string) {
  const cur = await db.recordingMarkers.get(id);
  if (!cur) return;
  await db.recordingMarkers.delete(id);
  const rec = await db.recordings.get(cur.recordingId);
  if (rec?.attachmentId) await reindex("attachment", rec.attachmentId);
}

// ---------------------------------------------------------------- Transcript Segments

export async function saveTranscriptSegments(
  recordingId: string,
  segments: Array<{ startMs: number; endMs: number; text: string; lang?: string; confidence?: number }>,
  opts: { replaceAll?: boolean } = {}
): Promise<TranscriptSegment[]> {
  const now = Date.now();
  const existing = await db.transcriptSegments.where("recordingId").equals(recordingId).sortBy("order");
  const baseOrder = opts.replaceAll ? 0 : existing.length;
  const rows: TranscriptSegment[] = segments
    .map((s, idx) => ({
      id: uid(),
      recordingId,
      order: baseOrder + idx,
      startMs: Math.max(0, Math.round(s.startMs)),
      endMs: Math.max(Math.round(s.startMs), Math.round(s.endMs)),
      text: s.text.trim(),
      lang: s.lang,
      confidence: typeof s.confidence === "number" ? Math.max(0, Math.min(1, s.confidence)) : undefined,
      editedManually: false,
      createdAt: now,
      updatedAt: now,
    }))
    .filter((s) => s.text.length > 0);

  await db.transaction("rw", db.transcriptSegments, async () => {
    if (opts.replaceAll) {
      await db.transcriptSegments.where("recordingId").equals(recordingId).delete();
    }
    if (rows.length) await db.transcriptSegments.bulkAdd(rows);
  });

  const rec = await db.recordings.get(recordingId);
  if (rec?.attachmentId) await reindex("attachment", rec.attachmentId);
  return rows;
}

export async function updateTranscriptSegment(
  id: string,
  patch: { text?: string; startMs?: number; endMs?: number }
) {
  const cur = await db.transcriptSegments.get(id);
  if (!cur) return;
  const nextStart = patch.startMs !== undefined ? Math.max(0, Math.round(patch.startMs)) : cur.startMs;
  const nextEnd = patch.endMs !== undefined ? Math.max(nextStart, Math.round(patch.endMs)) : Math.max(nextStart, cur.endMs);
  await db.transcriptSegments.update(id, {
    text: patch.text !== undefined ? patch.text.slice(0, 10_000) : cur.text,
    startMs: nextStart,
    endMs: nextEnd,
    editedManually: true,
    updatedAt: Date.now(),
  });
  const rec = await db.recordings.get(cur.recordingId);
  if (rec?.attachmentId) await reindex("attachment", rec.attachmentId);
}

export async function splitTranscriptSegment(id: string, charIndex?: number) {
  const cur = await db.transcriptSegments.get(id);
  if (!cur) return;
  const text = cur.text.trim();
  if (text.length < 4) return;
  let splitAt = typeof charIndex === "number" && charIndex > 1 && charIndex < text.length - 1 ? charIndex : Math.floor(text.length / 2);
  const spaceAfter = text.indexOf(" ", splitAt);
  const spaceBefore = text.lastIndexOf(" ", splitAt);
  if (spaceAfter > 0 && spaceAfter - splitAt < 16) splitAt = spaceAfter;
  else if (spaceBefore > 0) splitAt = spaceBefore;

  const left = text.slice(0, splitAt).trim();
  const right = text.slice(splitAt).trim();
  if (!left || !right) return;

  const ratio = left.length / (left.length + right.length);
  const midMs = Math.round(cur.startMs + (cur.endMs - cur.startMs) * ratio);
  const now = Date.now();
  const siblings = await db.transcriptSegments.where("recordingId").equals(cur.recordingId).sortBy("order");
  await db.transaction("rw", db.transcriptSegments, async () => {
    await db.transcriptSegments.update(cur.id, {
      text: left,
      endMs: midMs,
      editedManually: true,
      updatedAt: now,
    });
    const inserted: TranscriptSegment = {
      id: uid(),
      recordingId: cur.recordingId,
      order: cur.order + 1,
      startMs: midMs,
      endMs: cur.endMs,
      text: right,
      lang: cur.lang,
      confidence: cur.confidence,
      editedManually: true,
      createdAt: now,
      updatedAt: now,
    };
    for (const s of siblings) {
      if (s.order > cur.order) await db.transcriptSegments.update(s.id, { order: s.order + 1 });
    }
    await db.transcriptSegments.add(inserted);
  });
  const rec = await db.recordings.get(cur.recordingId);
  if (rec?.attachmentId) await reindex("attachment", rec.attachmentId);
}

export async function mergeTranscriptWithNext(id: string) {
  const cur = await db.transcriptSegments.get(id);
  if (!cur) return;
  const all = await db.transcriptSegments.where("recordingId").equals(cur.recordingId).sortBy("order");
  const idx = all.findIndex((x) => x.id === id);
  if (idx < 0 || idx >= all.length - 1) return;
  const next = all[idx + 1];
  await db.transaction("rw", db.transcriptSegments, async () => {
    await db.transcriptSegments.update(cur.id, {
      text: `${cur.text.trim()} ${next.text.trim()}`.trim(),
      endMs: Math.max(cur.endMs, next.endMs),
      editedManually: true,
      updatedAt: Date.now(),
    });
    await db.transcriptSegments.delete(next.id);
    for (let i = idx + 2; i < all.length; i++) {
      await db.transcriptSegments.update(all[i].id, { order: all[i].order - 1 });
    }
  });
  const rec = await db.recordings.get(cur.recordingId);
  if (rec?.attachmentId) await reindex("attachment", rec.attachmentId);
}

export async function deleteTranscriptSegment(id: string) {
  const cur = await db.transcriptSegments.get(id);
  if (!cur) return;
  await db.transcriptSegments.delete(id);
  const rec = await db.recordings.get(cur.recordingId);
  if (rec?.attachmentId) await reindex("attachment", rec.attachmentId);
}

function formatSubtitleTime(ms: number, sep: "," | "."): string {
  const safe = Math.max(0, Math.round(ms));
  const h = Math.floor(safe / 3_600_000);
  const m = Math.floor((safe % 3_600_000) / 60_000);
  const s = Math.floor((safe % 60_000) / 1000);
  const rem = safe % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}${sep}${String(rem).padStart(3, "0")}`;
}

export function formatTranscriptExport(
  title: string,
  segments: TranscriptSegment[],
  format: "txt" | "md" | "srt" | "vtt"
): string {
  if (format === "md") {
    const lines = [`# ${title}`, ""];
    for (const s of segments) {
      lines.push(`- **[${formatDuration(s.startMs)} → ${formatDuration(s.endMs)}]** ${s.text}`);
    }
    return lines.join("\n") + "\n";
  }
  if (format === "srt") {
    return (
      segments
        .map((s, idx) => `${idx + 1}\n${formatSubtitleTime(s.startMs, ",")} --> ${formatSubtitleTime(s.endMs, ",")}\n${s.text}\n`)
        .join("\n") + (segments.length ? "\n" : "")
    );
  }
  if (format === "vtt") {
    const body = segments
      .map((s) => `${formatSubtitleTime(s.startMs, ".")} --> ${formatSubtitleTime(s.endMs, ".")}\n${s.text}\n`)
      .join("\n");
    return `WEBVTT\n\n${body}`;
  }
  return segments.map((s) => `[${formatDuration(s.startMs)}] ${s.text}`).join("\n") + "\n";
}

// ---------------------------------------------------------------- Note Integration

export async function linkRecordingNote(recordingId: string, noteId: string | undefined) {
  await db.recordings.update(recordingId, { noteId, updatedAt: Date.now() });
}

export async function createLinkedLectureNote(
  lectureId: string,
  recordingId: string,
  title?: string
) {
  const lec = await db.lectures.get(lectureId);
  const rec = await db.recordings.get(recordingId);
  const noteTitle = title?.trim() || (rec ? `${rec.title}` : lec?.title || "Lecture Note");
  const note = await createNote({
    title: noteTitle,
    lectureId,
    subjectId: lec?.subjectId,
    kind: "note",
  });
  await db.recordings.update(recordingId, { noteId: note.id, updatedAt: Date.now() });
  return note;
}

function appendNodesToDoc(doc: JSONContent | null | undefined, nodes: JSONContent[]): JSONContent {
  const clean = sanitizeDoc(doc) ?? { type: "doc", content: [{ type: "paragraph" }] };
  const cur = Array.isArray(clean.content) ? [...clean.content] : [];
  // Drop a solitary trailing empty paragraph if the note is completely empty
  if (cur.length === 1 && cur[0].type === "paragraph" && (!cur[0].content || cur[0].content.length === 0)) {
    return { type: "doc", content: nodes };
  }
  return { type: "doc", content: [...cur, ...nodes] };
}

export async function insertTimestampIntoNote(
  noteId: string,
  ref: { recordingId: string; attachmentId?: string; timeMs: number; label?: string }
) {
  const note = await db.notes.get(noteId);
  if (!note || note.deletedAt) throw new Error("NOT_FOUND");
  const cleanMs = Math.max(0, Math.round(ref.timeMs));
  const cleanLabel = (ref.label ?? "").trim().slice(0, 120);
  const para: JSONContent = {
    type: "paragraph",
    content: [
      {
        type: "audioTimestamp",
        attrs: {
          recordingId: ref.recordingId,
          ...(ref.attachmentId ? { attachmentId: ref.attachmentId } : {}),
          timeMs: cleanMs,
          label: cleanLabel,
        },
      },
      ...(cleanLabel ? [{ type: "text", text: ` ${cleanLabel}` }] : [{ type: "text", text: " " }]),
    ],
  };
  const nextDoc = appendNodesToDoc(note.content, [para]);
  await saveNoteContent(noteId, { title: note.title, content: nextDoc });
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("nv-note-external-update", { detail: { noteId, content: nextDoc } }));
  }
}

export async function insertTranscriptIntoNote(
  noteId: string,
  input: {
    recordingId: string;
    attachmentId?: string;
    title: string;
    segments: TranscriptSegment[];
    includeTimestamps?: boolean;
  }
) {
  const note = await db.notes.get(noteId);
  if (!note || note.deletedAt) throw new Error("NOT_FOUND");
  if (!input.segments.length) return;

  // Save a snapshot version before appending bulk transcript so history stays recoverable.
  await saveNoteContent(
    noteId,
    { title: note.title, content: note.content ?? { type: "doc", content: [{ type: "paragraph" }] } },
    { forceVersion: true, label: "before-transcript" }
  );

  const nodes: JSONContent[] = [
    {
      type: "heading",
      attrs: { level: 3 },
      content: [{ type: "text", text: input.title }],
    },
  ];
  for (const s of input.segments) {
    const content: JSONContent[] = [];
    if (input.includeTimestamps !== false) {
      content.push({
        type: "audioTimestamp",
        attrs: {
          recordingId: input.recordingId,
          ...(input.attachmentId ? { attachmentId: input.attachmentId } : {}),
          timeMs: s.startMs,
          label: "",
        },
      });
      content.push({ type: "text", text: ` ${s.text}` });
    } else {
      content.push({ type: "text", text: s.text });
    }
    nodes.push({ type: "paragraph", content });
  }

  const nextDoc = appendNodesToDoc(note.content, nodes);
  await saveNoteContent(noteId, { title: note.title, content: nextDoc }, { forceVersion: true, label: "transcript" });
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("nv-note-external-update", { detail: { noteId, content: nextDoc } }));
  }
}
