// Live MediaRecorder controller with progressive chunk persistence, pause/resume, live meter & centralized PermissionManager integration.
import type { Attachment, LectureRecording } from "@/data/types";
import {
  detectMicrophoneSupport,
  mapMicrophoneError,
  permissionManager,
  type LivePermissionState,
} from "./permissions";
import {
  appendRecordingChunk,
  discardRecordingSession,
  finalizeRecordingSession,
  probeSupportedRecordingMime,
  startRecordingSessionRecord,
  updateRecordingStatus,
} from "./recordings";

export type RecorderPhase = "idle" | "requesting_mic" | "recording" | "paused" | "saving" | "error";
export type MicPermissionState = "unknown" | "prompt" | "granted" | "denied";

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
  permissionState: MicPermissionState;
}

function toMicPermState(s: LivePermissionState): MicPermissionState {
  return s === "granted" || s === "denied" || s === "prompt" ? s : "unknown";
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
    micSupported: detectMicrophoneSupport(),
    permissionState: toMicPermState(permissionManager.getSnapshot().microphone),
  };

  private listeners = new Set<(s: RecorderSnapshot) => void>();
  private stream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserData: Uint8Array | null = null;

  private activeStartedAtMs = 0;
  private accumulatedActiveMs = 0;
  private lastChunkEndMs = 0;
  private seqCounter = 0;
  private timerHandle: number | null = null;
  private meterHandle: number | null = null;
  private chunkQueue: Promise<void> = Promise.resolve();
  private stopPromiseResolver: (() => void) | null = null;
  private beforeUnloadAttached = false;
  private visibilityAttached = false;

  constructor() {
    permissionManager.subscribe((caps) => {
      const nextPerm = toMicPermState(caps.microphone);
      const clearErr =
        nextPerm === "granted" &&
        (this.snap.error === "MIC_PERMISSION_DENIED" || this.snap.error === "MIC_IFRAME_BLOCKED");
      const changed =
        nextPerm !== this.snap.permissionState ||
        caps.microphoneSupported !== this.snap.micSupported ||
        clearErr;
      if (changed) {
        this.update({
          micSupported: caps.microphoneSupported,
          permissionState: nextPerm,
          ...(clearErr
            ? { error: null, phase: this.snap.phase === "error" ? "idle" : this.snap.phase }
            : {}),
        });
      }
    });
  }

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

  async refreshPermissionState(): Promise<MicPermissionState> {
    const state = await permissionManager.queryPermissionState("microphone");
    const mapped = toMicPermState(state);
    this.update({
      micSupported: detectMicrophoneSupport(),
      permissionState: mapped,
    });
    return mapped;
  }

  async requestMicrophoneAccess(): Promise<boolean> {
    try {
      await permissionManager.requestMicrophoneAccess();
      this.update({
        permissionState: "granted",
        error: null,
        phase: this.snap.phase === "error" ? "idle" : this.snap.phase,
        micSupported: detectMicrophoneSupport(),
      });
      return true;
    } catch (err) {
      const code = mapMicrophoneError(err);
      this.update({
        phase: "error",
        error: code,
        ...(code === "MIC_PERMISSION_DENIED" ? { permissionState: "denied" as const } : {}),
      });
      throw new Error(code);
    }
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

  private onVisibilityChange = () => {
    if (typeof document === "undefined" || document.visibilityState !== "visible") return;
    if (this.snap.phase === "recording") {
      void permissionManager.acquireWakeLock();
      if (this.audioCtx?.state === "suspended") {
        void this.audioCtx.resume().catch(() => undefined);
      }
      this.update({ elapsedMs: this.currentElapsedMs() });
    }
  };

  private attachGuards(on: boolean) {
    if (typeof window !== "undefined") {
      if (on && !this.beforeUnloadAttached) {
        window.addEventListener("beforeunload", this.onBeforeUnload);
        this.beforeUnloadAttached = true;
      } else if (!on && this.beforeUnloadAttached) {
        window.removeEventListener("beforeunload", this.onBeforeUnload);
        this.beforeUnloadAttached = false;
      }
    }
    if (typeof document !== "undefined") {
      if (on && !this.visibilityAttached) {
        document.addEventListener("visibilitychange", this.onVisibilityChange);
        this.visibilityAttached = true;
      } else if (!on && this.visibilityAttached) {
        document.removeEventListener("visibilitychange", this.onVisibilityChange);
        this.visibilityAttached = false;
      }
    }
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
    this.attachGuards(false);
    void permissionManager.releaseWakeLock();
    if (this.stream) {
      permissionManager.releaseStream(this.stream);
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
    const supported = detectMicrophoneSupport();
    if (!supported || typeof MediaRecorder === "undefined") {
      const code =
        typeof window !== "undefined" && window.isSecureContext === false
          ? "MIC_INSECURE_CONTEXT"
          : "MIC_UNSUPPORTED";
      this.update({ phase: "error", error: code, micSupported: supported });
      throw new Error(code);
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
      micSupported: supported,
    });

    let createdSessionId: string | null = null;
    try {
      const stream = await permissionManager.requestMicrophoneStream();
      this.stream = stream;
      this.update({ permissionState: "granted" });

      let mr: MediaRecorder;
      try {
        mr = new MediaRecorder(stream, { mimeType: choice.mime, audioBitsPerSecond: 64000 });
      } catch {
        try {
          mr = new MediaRecorder(stream, { mimeType: choice.mime });
        } catch {
          mr = new MediaRecorder(stream);
        }
      }
      const actualBaseMime =
        (mr.mimeType || choice.baseMime).split(";")[0].trim().toLowerCase() || choice.baseMime;
      const actualExt = actualBaseMime.includes("mp4")
        ? "m4a"
        : actualBaseMime.includes("ogg")
          ? "ogg"
          : "webm";

      const track = stream.getAudioTracks()[0];
      const deviceLabel = track?.label;
      const session = await startRecordingSessionRecord({
        subjectId: opts.subjectId,
        lectureId: opts.lectureId || undefined,
        title: opts.title,
        mime: actualBaseMime,
        ext: actualExt,
        deviceLabel,
      });
      createdSessionId = session.id;

      // Monitor unexpected OS/browser revocation or hardware disconnect mid-recording
      if (track && typeof track.addEventListener === "function") {
        track.addEventListener("ended", () => {
          if (this.snap.phase === "recording" || this.snap.phase === "paused") {
            if (this.snap.phase === "recording" && this.activeStartedAtMs > 0) {
              this.accumulatedActiveMs += Date.now() - this.activeStartedAtMs;
              this.activeStartedAtMs = 0;
            }
            if (mr.state !== "inactive") {
              try {
                mr.stop();
              } catch {
                /* ignore */
              }
            }
            if (this.snap.recordingId) {
              void updateRecordingStatus(this.snap.recordingId, {
                status: "error",
                errorDetail: "MIC_REVOKED_MID_RECORDING",
                durationMs: this.accumulatedActiveMs,
              });
            }
            this.cleanupHardware();
            this.update({
              phase: "error",
              elapsedMs: this.accumulatedActiveMs,
              level: 0,
              error: "MIC_REVOKED_MID_RECORDING",
            });
            void permissionManager.queryPermissionState("microphone");
          }
        });
      }

      // Best-effort mic level analyser
      try {
        const AudioCtx =
          typeof AudioContext !== "undefined"
            ? AudioContext
            : (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (AudioCtx) {
          const ctx = new AudioCtx();
          if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
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
              mime: actualBaseMime,
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
        mime: actualBaseMime,
      });

      this.attachGuards(true);
      await permissionManager.acquireWakeLock();
      this.startMeters();
      try {
        mr.start(opts.timesliceMs ?? 15_000);
      } catch {
        mr.start();
      }
      return session.id;
    } catch (err) {
      this.cleanupHardware();
      if (createdSessionId) {
        await discardRecordingSession(createdSessionId).catch(() => undefined);
      }
      const msg = mapMicrophoneError(err);
      this.update({
        phase: "error",
        recordingId: null,
        error: msg,
        ...(msg === "MIC_PERMISSION_DENIED" ? { permissionState: "denied" as const } : {}),
      });
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
      void permissionManager.releaseWakeLock();
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
      void permissionManager.acquireWakeLock();
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
