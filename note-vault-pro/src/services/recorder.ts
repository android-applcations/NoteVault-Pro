// Live MediaRecorder controller with progressive chunk persistence, pause/resume, live meter & WakeLock.
import type { Attachment, LectureRecording } from "@/data/types";
import {
  appendRecordingChunk,
  discardRecordingSession,
  finalizeRecordingSession,
  probeSupportedRecordingMime,
  startRecordingSessionRecord,
  updateRecordingStatus,
} from "./recordings";

export type RecorderPhase = "idle" | "requesting_mic" | "recording" | "paused" | "saving" | "error";

export interface RecorderSnapshot {
  phase: RecorderPhase;
  recordingId: string | null;
  subjectId: string | null;
  lectureId: string | null;
  title: string;
  mime: string | null;
  elapsedMs: number;
  bytesWritten: number;
  chunkCount: number;
  level: number; // 0..1 normalized mic RMS
  error: string | null;
  micSupported: boolean;
}

class LectureRecorderController {
  private snap: RecorderSnapshot = {
    phase: "idle",
    recordingId: null,
    subjectId: null,
    lectureId: null,
    title: "",
    mime: null,
    elapsedMs: 0,
    bytesWritten: 0,
    chunkCount: 0,
    level: 0,
    error: null,
    micSupported:
      typeof navigator !== "undefined" &&
      Boolean(navigator.mediaDevices?.getUserMedia) &&
      typeof MediaRecorder !== "undefined",
  };

  private listeners = new Set<(s: RecorderSnapshot) => void>();
  private stream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserData: Uint8Array | null = null;
  private wakeLock: WakeLockSentinel | null = null;

  private activeStartedAtMs = 0;
  private accumulatedActiveMs = 0;
  private lastChunkEndMs = 0;
  private seqCounter = 0;
  private timerHandle: number | null = null;
  private meterHandle: number | null = null;
  private chunkQueue: Promise<void> = Promise.resolve();
  private stopPromiseResolver: (() => void) | null = null;
  private beforeUnloadAttached = false;

  subscribe(fn: (s: RecorderSnapshot) => void): () => void {
    this.listeners.add(fn);
    fn({ ...this.snap });
    return () => {
      this.listeners.delete(fn);
    };
  }

  getSnapshot(): RecorderSnapshot {
    return { ...this.snap };
  }

  private update(patch: Partial<RecorderSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    const copy = { ...this.snap };
    for (const fn of this.listeners) fn(copy);
  }

  private currentElapsedMs(): number {
    if (this.snap.phase === "recording" && this.activeStartedAtMs > 0) {
      return Math.max(0, this.accumulatedActiveMs + (Date.now() - this.activeStartedAtMs));
    }
    return Math.max(0, this.accumulatedActiveMs);
  }

  private onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (this.snap.phase === "recording" || this.snap.phase === "paused" || this.snap.phase === "saving") {
      try {
        if (this.mediaRecorder && this.mediaRecorder.state === "recording") {
          this.mediaRecorder.requestData();
        }
      } catch {
        /* ignore */
      }
      e.preventDefault();
      e.returnValue = "";
    }
  };

  private attachUnloadGuard(on: boolean) {
    if (typeof window === "undefined") return;
    if (on && !this.beforeUnloadAttached) {
      window.addEventListener("beforeunload", this.onBeforeUnload);
      this.beforeUnloadAttached = true;
    } else if (!on && this.beforeUnloadAttached) {
      window.removeEventListener("beforeunload", this.onBeforeUnload);
      this.beforeUnloadAttached = false;
    }
  }

  private async requestWakeLock() {
    try {
      if (typeof navigator !== "undefined" && navigator.wakeLock?.request) {
        this.wakeLock = await navigator.wakeLock.request("screen");
      }
    } catch {
      this.wakeLock = null;
    }
  }

  private async releaseWakeLock() {
    try {
      await this.wakeLock?.release();
    } catch {
      /* ignore */
    }
    this.wakeLock = null;
  }

  private startMeters() {
    this.stopMeters();
    if (typeof window === "undefined") return;
    this.timerHandle = window.setInterval(() => {
      if (this.snap.phase === "recording") {
        this.update({ elapsedMs: this.currentElapsedMs() });
      }
    }, 200);

    const tickMeter = () => {
      if (this.snap.phase !== "recording" && this.snap.phase !== "paused") return;
      if (this.snap.phase === "recording" && this.analyser && this.analyserData) {
        this.analyser.getByteTimeDomainData(this.analyserData as Uint8Array<ArrayBuffer>);
        let sum = 0;
        for (let i = 0; i < this.analyserData.length; i++) {
          const v = (this.analyserData[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / this.analyserData.length);
        const level = Math.min(1, Number((rms * 3.5).toFixed(3)));
        if (Math.abs(level - this.snap.level) > 0.02) {
          this.update({ level });
        }
      } else if (this.snap.level !== 0) {
        this.update({ level: 0 });
      }
      this.meterHandle = window.requestAnimationFrame(tickMeter);
    };
    this.meterHandle = window.requestAnimationFrame(tickMeter);
  }

  private stopMeters() {
    if (typeof window === "undefined") return;
    if (this.timerHandle !== null) {
      window.clearInterval(this.timerHandle);
      this.timerHandle = null;
    }
    if (this.meterHandle !== null) {
      window.cancelAnimationFrame(this.meterHandle);
      this.meterHandle = null;
    }
  }

  private cleanupHardware() {
    this.stopMeters();
    this.attachUnloadGuard(false);
    void this.releaseWakeLock();
    if (this.stream) {
      for (const tr of this.stream.getTracks()) tr.stop();
      this.stream = null;
    }
    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => undefined);
      this.audioCtx = null;
    }
    this.analyser = null;
    this.analyserData = null;
    this.mediaRecorder = null;
  }

  async start(opts: {
    subjectId?: string;
    lectureId?: string;
    title: string;
    timesliceMs?: number;
  }): Promise<string> {
    if (this.snap.phase !== "idle" && this.snap.phase !== "error") {
      throw new Error("RECORDER_ALREADY_ACTIVE");
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      this.update({ phase: "error", error: "MIC_UNSUPPORTED", micSupported: false });
      throw new Error("MIC_UNSUPPORTED");
    }

    const choice = probeSupportedRecordingMime();

    this.update({
      phase: "requesting_mic",
      subjectId: opts.subjectId ?? null,
      lectureId: opts.lectureId || null,
      title: opts.title,
      mime: choice.baseMime,
      elapsedMs: 0,
      bytesWritten: 0,
      chunkCount: 0,
      level: 0,
      error: null,
    });

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      this.stream = stream;

      const deviceLabel = stream.getAudioTracks()[0]?.label;
      const session = await startRecordingSessionRecord({
        subjectId: opts.subjectId,
        lectureId: opts.lectureId || undefined,
        title: opts.title,
        mime: choice.baseMime,
        ext: choice.ext,
        deviceLabel,
      });

      // Best-effort mic level analyser
      try {
        const AudioCtx =
          typeof AudioContext !== "undefined"
            ? AudioContext
            : (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (AudioCtx) {
          const ctx = new AudioCtx();
          const source = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 256;
          source.connect(analyser);
          this.audioCtx = ctx;
          this.analyser = analyser;
          this.analyserData = new Uint8Array(analyser.frequencyBinCount);
        }
      } catch {
        /* meter optional */
      }

      let mr: MediaRecorder;
      try {
        mr = new MediaRecorder(stream, { mimeType: choice.mime, audioBitsPerSecond: 64000 });
      } catch {
        mr = new MediaRecorder(stream);
      }
      this.mediaRecorder = mr;
      this.chunkQueue = Promise.resolve();
      this.accumulatedActiveMs = 0;
      this.lastChunkEndMs = 0;
      this.seqCounter = 0;
      this.activeStartedAtMs = Date.now();

      mr.ondataavailable = (ev) => {
        if (!ev.data || ev.data.size === 0 || !this.snap.recordingId) return;
        const recId = this.snap.recordingId;
        const blob = ev.data;
        const endMs = this.currentElapsedMs();
        const startMs = this.lastChunkEndMs;
        this.lastChunkEndMs = endMs;
        const seq = this.seqCounter++;
        const durationMs = Math.max(0, endMs - startMs);

        this.chunkQueue = this.chunkQueue.then(async () => {
          try {
            const chunk = await appendRecordingChunk({
              recordingId: recId,
              seq,
              blob,
              mime: choice.baseMime,
              durationMs,
              startMs,
              endMs,
            });
            this.update({
              bytesWritten: this.snap.bytesWritten + chunk.size,
              chunkCount: this.snap.chunkCount + 1,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.update({ error: msg });
            if (msg === "QUOTA_EXCEEDED" && mr.state !== "inactive") {
              try {
                mr.stop();
              } catch {
                /* ignore */
              }
            }
          }
        });
      };

      mr.onstop = () => {
        this.stopPromiseResolver?.();
        this.stopPromiseResolver = null;
      };

      mr.onerror = () => {
        this.update({ error: "RECORDER_HARDWARE_ERROR" });
      };

      this.update({
        phase: "recording",
        recordingId: session.id,
        title: session.title,
      });

      this.attachUnloadGuard(true);
      await this.requestWakeLock();
      this.startMeters();
      mr.start(opts.timesliceMs ?? 15_000);
      return session.id;
    } catch (err) {
      this.cleanupHardware();
      const msg =
        err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "PermissionDeniedError")
          ? "MIC_PERMISSION_DENIED"
          : err instanceof DOMException && err.name === "NotFoundError"
            ? "MIC_NOT_FOUND"
            : err instanceof Error
              ? err.message
              : String(err);
      this.update({ phase: "error", recordingId: null, error: msg });
      throw new Error(msg);
    }
  }

  pause() {
    if (!this.mediaRecorder || this.snap.phase !== "recording" || !this.snap.recordingId) return;
    if (this.mediaRecorder.state === "recording") {
      this.accumulatedActiveMs += Date.now() - this.activeStartedAtMs;
      this.activeStartedAtMs = 0;
      this.mediaRecorder.pause();
      try {
        this.mediaRecorder.requestData();
      } catch {
        /* ignore */
      }
      void updateRecordingStatus(this.snap.recordingId, { status: "paused", durationMs: this.accumulatedActiveMs });
      this.update({
        phase: "paused",
        elapsedMs: this.accumulatedActiveMs,
        level: 0,
      });
    }
  }

  resume() {
    if (!this.mediaRecorder || this.snap.phase !== "paused" || !this.snap.recordingId) return;
    if (this.mediaRecorder.state === "paused") {
      this.activeStartedAtMs = Date.now();
      this.mediaRecorder.resume();
      void updateRecordingStatus(this.snap.recordingId, { status: "recording" });
      this.update({ phase: "recording" });
    }
  }

  async stopAndSave(): Promise<{ recording: LectureRecording; attachment: Attachment }> {
    const recId = this.snap.recordingId;
    if (!recId) throw new Error("NO_ACTIVE_RECORDING");

    if (this.snap.phase === "recording") {
      this.accumulatedActiveMs += Date.now() - this.activeStartedAtMs;
      this.activeStartedAtMs = 0;
    }
    const finalElapsedMs = Math.max(0, Math.round(this.accumulatedActiveMs));
    this.update({ phase: "saving", elapsedMs: finalElapsedMs, level: 0 });

    if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
      await new Promise<void>((resolve) => {
        this.stopPromiseResolver = resolve;
        try {
          this.mediaRecorder?.stop();
        } catch {
          resolve();
        }
        setTimeout(resolve, 2000);
      });
    }

    await this.chunkQueue;
    this.cleanupHardware();

    const saved = await finalizeRecordingSession(recId, finalElapsedMs);
    this.update({
      phase: "idle",
      recordingId: null,
      subjectId: null,
      lectureId: null,
      title: "",
      mime: null,
      elapsedMs: 0,
      bytesWritten: 0,
      chunkCount: 0,
      level: 0,
      error: null,
    });
    return saved;
  }

  async cancelAndDiscard() {
    const recId = this.snap.recordingId;
    if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
      await new Promise<void>((resolve) => {
        this.stopPromiseResolver = resolve;
        try {
          this.mediaRecorder?.stop();
        } catch {
          resolve();
        }
        setTimeout(resolve, 1500);
      });
    }
    await this.chunkQueue.catch(() => undefined);
    this.cleanupHardware();
    if (recId) {
      await discardRecordingSession(recId).catch(() => undefined);
    }
    this.update({
      phase: "idle",
      recordingId: null,
      subjectId: null,
      lectureId: null,
      title: "",
      mime: null,
      elapsedMs: 0,
      bytesWritten: 0,
      chunkCount: 0,
      level: 0,
      error: null,
    });
  }
}

export const lectureRecorder = new LectureRecorderController();
