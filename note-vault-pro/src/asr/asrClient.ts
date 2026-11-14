// Main-thread offline ASR job orchestrator (Worker lifecycle, chunk progress, pause/resume/cancel, single-segment re-run).
import { db } from "@/data/db";
import type { AsrModelRecord, TranscriptSegment } from "@/data/types";
import { uid } from "@/services/core";
import { getRecordingBlob, saveTranscriptSegments, updateRecordingStatus } from "@/services/recordings";
import { reindex } from "@/services/search";
import { buildPcmWindows, decodeBlobTo16kMono, TARGET_SAMPLE_RATE } from "./audioDecode";
import type { AsrWorkerRequest, AsrWorkerResponse } from "./asrWorker";
import { mergeWindowSegments, type RawChunkSegment } from "./chunkMerge";
import { verifyInstalledModel } from "./modelManager";
import { modelSupportsLanguage } from "./models";

export interface AsrJobProgress {
  recordingId: string;
  phase: "loading_model" | "decoding" | "transcribing" | "paused" | "done" | "error";
  completedWindows: number;
  totalWindows: number;
  progress: number;
  error?: string;
}

interface ActiveJobControl {
  paused: boolean;
  cancelled: boolean;
}

type SuccessResponse = Extract<AsrWorkerResponse, { ok: true }>;

class AsrClientController {
  private worker: Worker | null = null;
  private reqId = 1;
  private pending = new Map<
    number,
    { resolve: (res: SuccessResponse) => void; reject: (err: Error) => void }
  >();
  private jobs = new Map<string, ActiveJobControl>();
  private listeners = new Set<(p: AsrJobProgress) => void>();

  subscribe(fn: (p: AsrJobProgress) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(p: AsrJobProgress) {
    for (const fn of this.listeners) fn(p);
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL("./asrWorker.ts", import.meta.url), { type: "module" });
    w.onmessage = (ev: MessageEvent<AsrWorkerResponse>) => {
      const handler = this.pending.get(ev.data.id);
      if (!handler) return;
      this.pending.delete(ev.data.id);
      if (ev.data.ok) handler.resolve(ev.data);
      else handler.reject(new Error(ev.data.error));
    };
    w.onerror = (ev) => {
      const err = new Error(ev.message || "ASR_WORKER_CRASHED");
      for (const h of this.pending.values()) h.reject(err);
      this.pending.clear();
      this.worker = null;
    };
    this.worker = w;
    return w;
  }

  private callWorker(build: (id: number) => AsrWorkerRequest, transfer: Transferable[] = []): Promise<SuccessResponse> {
    const id = this.reqId++;
    const worker = this.ensureWorker();
    const payload = build(id);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage(payload, transfer);
    });
  }

  async disposeWorker() {
    if (!this.worker) return;
    try {
      await this.callWorker((id) => ({ type: "dispose", id }));
    } catch {
      /* ignore */
    }
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
  }

  pauseJob(recordingId: string) {
    const ctrl = this.jobs.get(recordingId);
    if (ctrl) ctrl.paused = true;
  }

  cancelJob(recordingId: string) {
    const ctrl = this.jobs.get(recordingId);
    if (ctrl) {
      ctrl.cancelled = true;
      ctrl.paused = false;
    }
  }

  async runTranscription(opts: {
    recordingId: string;
    modelId: string;
    language: "auto" | "ar" | "en";
    resume?: boolean;
  }): Promise<TranscriptSegment[]> {
    const rec = await db.recordings.get(opts.recordingId);
    if (!rec || rec.deletedAt) throw new Error("RECORDING_NOT_FOUND");
    if (this.jobs.has(opts.recordingId)) {
      throw new Error("TRANSCRIPTION_ALREADY_RUNNING");
    }

    const model: AsrModelRecord = await verifyInstalledModel(opts.modelId);
    if (!modelSupportsLanguage(model, opts.language)) {
      throw new Error("MODEL_LANGUAGE_UNSUPPORTED");
    }

    const ctrl: ActiveJobControl = { paused: false, cancelled: false };
    this.jobs.set(opts.recordingId, ctrl);

    try {
      await updateRecordingStatus(opts.recordingId, {
        transcriptionStatus: "transcribing",
        transcriptionModelId: model.id,
        transcriptionLang: opts.language,
        transcriptionError: undefined,
      });

      this.emit({
        recordingId: opts.recordingId,
        phase: "loading_model",
        completedWindows: 0,
        totalWindows: 1,
        progress: 0.05,
      });

      const wasmBaseUrl =
        typeof document !== "undefined" ? new URL("./asr/", document.baseURI).href : "./asr/";

      await this.callWorker((id) => ({
        type: "init",
        id,
        model,
        wasmBaseUrl,
      }));

      if (ctrl.cancelled) throw new Error("TRANSCRIPTION_CANCELLED");

      this.emit({
        recordingId: opts.recordingId,
        phase: "decoding",
        completedWindows: 0,
        totalWindows: 1,
        progress: 0.12,
      });

      const audioBlob = await getRecordingBlob(rec);
      if (!audioBlob) throw new Error("AUDIO_BLOB_MISSING");

      const pcm = await decodeBlobTo16kMono(audioBlob);
      const windows = buildPcmWindows(pcm);

      if (windows.length === 0) {
        const empty = await saveTranscriptSegments(opts.recordingId, [], { replaceAll: true });
        await updateRecordingStatus(opts.recordingId, {
          transcriptionStatus: "done",
          transcriptionProgress: 1,
          transcribedMs: Math.round((pcm.length / TARGET_SAMPLE_RATE) * 1000),
        });
        this.emit({
          recordingId: opts.recordingId,
          phase: "done",
          completedWindows: 0,
          totalWindows: 0,
          progress: 1,
        });
        return empty;
      }

      let existingSegments: TranscriptSegment[] = [];
      let resumeAfterSec = -1;
      if (opts.resume) {
        existingSegments = await db.transcriptSegments
          .where("recordingId")
          .equals(opts.recordingId)
          .sortBy("order");
        if (existingSegments.length > 0) {
          resumeAfterSec = existingSegments[existingSegments.length - 1].endMs / 1000;
        }
      }

      const collectedWindows: Array<{ windowIndex: number; segments: RawChunkSegment[] }> =
        existingSegments.length > 0
          ? [
              {
                windowIndex: -1,
                segments: existingSegments.map((s) => ({
                  startSec: s.startMs / 1000,
                  endSec: s.endMs / 1000,
                  text: s.text,
                })),
              },
            ]
          : [];

      let completed = 0;
      for (const win of windows) {
        if (ctrl.cancelled) {
          await updateRecordingStatus(opts.recordingId, {
            transcriptionStatus: existingSegments.length > 0 ? "paused" : "idle",
          });
          throw new Error("TRANSCRIPTION_CANCELLED");
        }
        if (ctrl.paused) {
          const partial = mergeWindowSegments(collectedWindows);
          await saveTranscriptSegments(
            opts.recordingId,
            partial.map((s) => ({
              startMs: Math.round(s.startSec * 1000),
              endMs: Math.round(s.endSec * 1000),
              text: s.text,
              lang: opts.language,
            })),
            { replaceAll: true }
          );
          await updateRecordingStatus(opts.recordingId, {
            transcriptionStatus: "paused",
            transcriptionProgress: completed / windows.length,
          });
          this.emit({
            recordingId: opts.recordingId,
            phase: "paused",
            completedWindows: completed,
            totalWindows: windows.length,
            progress: completed / windows.length,
          });
          return await db.transcriptSegments.where("recordingId").equals(opts.recordingId).sortBy("order");
        }

        if (opts.resume && win.endSec <= resumeAfterSec) {
          completed += 1;
          continue;
        }

        const sliceCopy = new Float32Array(win.pcm);
        const res = await this.callWorker(
          (id) => ({
            type: "transcribe-window",
            id,
            pcm: sliceCopy,
            language: opts.language,
            windowOffsetSec: win.startSec,
            windowDurationSec: win.endSec - win.startSec,
          }),
          [sliceCopy.buffer]
        );

        collectedWindows.push({
          windowIndex: win.index,
          segments: res.segments ?? [],
        });

        completed += 1;
        const mergedSoFar = mergeWindowSegments(collectedWindows);
        await saveTranscriptSegments(
          opts.recordingId,
          mergedSoFar.map((s) => ({
            startMs: Math.round(s.startSec * 1000),
            endMs: Math.round(s.endSec * 1000),
            text: s.text,
            lang: opts.language,
          })),
          { replaceAll: true }
        );

        const prog = Number((completed / windows.length).toFixed(3));
        await updateRecordingStatus(opts.recordingId, {
          transcriptionProgress: prog,
          transcribedMs: Math.round(win.endSec * 1000),
        });

        this.emit({
          recordingId: opts.recordingId,
          phase: "transcribing",
          completedWindows: completed,
          totalWindows: windows.length,
          progress: prog,
        });
      }

      const finalMerged = mergeWindowSegments(collectedWindows);
      const saved = await saveTranscriptSegments(
        opts.recordingId,
        finalMerged.map((s) => ({
          startMs: Math.round(s.startSec * 1000),
          endMs: Math.round(s.endSec * 1000),
          text: s.text,
          lang: opts.language,
        })),
        { replaceAll: true }
      );

      await updateRecordingStatus(opts.recordingId, {
        transcriptionStatus: "done",
        transcriptionProgress: 1,
        transcribedMs: Math.round((pcm.length / TARGET_SAMPLE_RATE) * 1000),
      });
      if (rec.attachmentId) await reindex("attachment", rec.attachmentId).catch(() => undefined);

      this.emit({
        recordingId: opts.recordingId,
        phase: "done",
        completedWindows: windows.length,
        totalWindows: windows.length,
        progress: 1,
      });

      return saved;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== "TRANSCRIPTION_CANCELLED") {
        await updateRecordingStatus(opts.recordingId, {
          transcriptionStatus: "error",
          transcriptionError: msg,
        });
        this.emit({
          recordingId: opts.recordingId,
          phase: "error",
          completedWindows: 0,
          totalWindows: 1,
          progress: 0,
          error: msg,
        });
      }
      throw err;
    } finally {
      this.jobs.delete(opts.recordingId);
    }
  }

  /** Re-transcribes just one segment range cleanly without overwriting user edits on other segments. */
  async retranscribeSingleSegment(opts: {
    segmentId: string;
    modelId: string;
    language: "auto" | "ar" | "en";
  }): Promise<TranscriptSegment> {
    const seg = await db.transcriptSegments.get(opts.segmentId);
    if (!seg) throw new Error("SEGMENT_NOT_FOUND");
    const rec = await db.recordings.get(seg.recordingId);
    if (!rec || rec.deletedAt) throw new Error("RECORDING_NOT_FOUND");

    const model = await verifyInstalledModel(opts.modelId);
    if (!modelSupportsLanguage(model, opts.language)) {
      throw new Error("MODEL_LANGUAGE_UNSUPPORTED");
    }

    const wasmBaseUrl =
      typeof document !== "undefined" ? new URL("./asr/", document.baseURI).href : "./asr/";
    await this.callWorker((id) => ({ type: "init", id, model, wasmBaseUrl }));

    const audioBlob = await getRecordingBlob(rec);
    if (!audioBlob) throw new Error("AUDIO_BLOB_MISSING");
    const pcm = await decodeBlobTo16kMono(audioBlob);

    const startSample = Math.max(0, Math.floor(Math.max(0, seg.startMs / 1000 - 0.25) * TARGET_SAMPLE_RATE));
    const endSample = Math.min(pcm.length, Math.ceil((seg.endMs / 1000 + 0.25) * TARGET_SAMPLE_RATE));
    const sliceCopy = new Float32Array(pcm.subarray(startSample, endSample));
    const offsetSec = startSample / TARGET_SAMPLE_RATE;

    const res = await this.callWorker(
      (id) => ({
        type: "transcribe-window",
        id,
        pcm: sliceCopy,
        language: opts.language,
        windowOffsetSec: offsetSec,
        windowDurationSec: sliceCopy.length / TARGET_SAMPLE_RATE,
      }),
      [sliceCopy.buffer]
    );

    const text = (res.segments ?? [])
      .map((s: RawChunkSegment) => s.text.trim())
      .filter(Boolean)
      .join(" ")
      .trim();
    if (!text) return seg;

    await db.transcriptSegments.update(seg.id, {
      text,
      lang: opts.language,
      editedManually: false,
      updatedAt: Date.now(),
    });
    const updated = await db.transcriptSegments.get(seg.id);
    if (rec.attachmentId) await reindex("attachment", rec.attachmentId).catch(() => undefined);
    return updated!;
  }
}

export const asrClient = new AsrClientController();

/** Ensures an audio Attachment (even pre-existing uploaded audio) has a LectureRecording record for markers/ASR. */
export async function ensureRecordingForAudioAttachment(attachmentId: string): Promise<string> {
  const existing = await db.recordings
    .filter((r) => !r.deletedAt && r.attachmentId === attachmentId)
    .first();
  if (existing) return existing.id;

  const att = await db.attachments.get(attachmentId);
  if (!att || att.kind !== "audio") throw new Error("AUDIO_ATTACHMENT_NOT_FOUND");

  const id = uid();
  const now = Date.now();
  const ext = att.mime.includes("mp4") ? "m4a" : att.mime.includes("ogg") ? "ogg" : att.mime.includes("mpeg") ? "mp3" : "webm";
  await db.recordings.put({
    id,
    attachmentId: att.id,
    lectureId: att.lectureId || undefined,
    subjectId: att.subjectId,
    noteId: att.noteId,
    title: att.name,
    mime: att.mime,
    ext,
    durationMs: 0,
    totalBytes: att.size,
    chunkCount: 0,
    status: "ready",
    transcriptionStatus: "idle",
    transcriptionLang: "auto",
    transcriptionProgress: 0,
    createdAt: att.createdAt,
    updatedAt: now,
  });
  return id;
}
