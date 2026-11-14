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

function detectMicSupported(): boolean {
  if (typeof navigator === "undefined") return false;
  const legacyNav = navigator as unknown as {
    webkitGetUserMedia?: unknown;
    mozGetUserMedia?: unknown;
  };
  const hasGUM = Boolean(
    navigator.mediaDevices?.getUserMedia || legacyNav.webkitGetUserMedia || legacyNav.mozGetUserMedia
  );
  return hasGUM && typeof MediaRecorder !== "undefined";
}

function isEmbeddedFrame(): boolean {
  try {
    return typeof window !== "undefined" && window.self !== window.top;
  } catch {
    return true;
  }
}

function mapMicError(err: unknown): string {
  if (typeof window !== "undefined" && window.isSecureContext === false) {
    return "MIC_INSECURE_CONTEXT";
  }
  const name = err instanceof DOMException || err instanceof Error ? err.name : "";
  const msg = err instanceof Error ? err.message : String(err);
  if (
    msg === "MIC_INSECURE_CONTEXT" ||
    msg === "MIC_IFRAME_BLOCKED" ||
    msg === "MIC_PERMISSION_DENIED" ||
    msg === "MIC_NOT_FOUND" ||
    msg === "MIC_IN_USE" ||
    msg === "MIC_UNSUPPORTED"
  ) {
    return msg;
  }
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return isEmbeddedFrame() ? "MIC_IFRAME_BLOCKED" : "MIC_PERMISSION_DENIED";
  }
  if (name === "SecurityError") {
    return isEmbeddedFrame() ? "MIC_IFRAME_BLOCKED" : "MIC_PERMISSION_DENIED";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "MIC_NOT_FOUND";
  }
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
    return "MIC_IN_USE";
  }
  if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") {
    return "MIC_UNSUPPORTED";
  }
  return msg || "MIC_UNSUPPORTED";
}

async function getUserMediaRaw(constraints: MediaStreamConstraints): Promise<MediaStream> {
  if (navigator.mediaDevices?.getUserMedia) {
    return navigator.mediaDevices.getUserMedia(constraints);
  }
  const legacy = (navigator as unknown as {
    webkitGetUserMedia?: (
      c: MediaStreamConstraints,
      ok: (s: MediaStream) => void,
      err: (e: unknown) => void
    ) => void;
    mozGetUserMedia?: (
      c: MediaStreamConstraints,
      ok: (s: MediaStream) => void,
      err: (e: unknown) => void
    ) => void;
  });
  const fn = legacy.webkitGetUserMedia ?? legacy.mozGetUserMedia;
  if (!fn) throw new Error("MIC_UNSUPPORTED");
  return new Promise<MediaStream>((resolve, reject) => {
    fn.call(navigator, constraints, resolve, reject);
  });
}

async function acquireMicrophoneStream(): Promise<MediaStream> {
  if (typeof window !== "undefined" && window.isSecureContext === false) {
    throw new Error("MIC_INSECURE_CONTEXT");
  }
  if (typeof navigator === "undefined") {
    throw new Error("MIC_UNSUPPORTED");
  }
  try {
    return await getUserMediaRaw({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (err) {
    const name = err instanceof DOMException || err instanceof Error ? err.name : "";
    if (
      name === "OverconstrainedError" ||
      name === "ConstraintNotSatisfiedError" ||
      name === "TypeError" ||
      name === "NotSupportedError"
    ) {
      return await getUserMediaRaw({ audio: true });
    }
    throw err;
  }
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
    micSupported: detectMicSupported(),
    permissionState: "unknown",
  };
  private permStatusRef: PermissionStatus | null = null;

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

  async refreshPermissionState(): Promise<MicPermissionState> {
    const supported = detectMicSupported();
    if (supported !== this.snap.micSupported) {
      this.update({ micSupported: supported });
    }
    if (typeof navigator === "undefined" || !navigator.permissions?.query) {
      return this.snap.permissionState;
    }
    try {
      const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
      const mapped: MicPermissionState =
        status.state === "granted" || status.state === "denied" || status.state === "prompt"
          ? status.state
          : "unknown";
      if (!this.permStatusRef || this.permStatusRef !== status) {
        this.permStatusRef = status;
        status.onchange = () => {
          const nextState: MicPermissionState =
            status.state === "granted" || status.state === "denied" || status.state === "prompt"
              ? status.state
              : "unknown";
          const clearDeniedErr =
            nextState === "granted" &&
            (this.snap.error === "MIC_PERMISSION_DENIED" || this.snap.error === "MIC_IFRAME_BLOCKED");
          this.update({
            permissionState: nextState,
            ...(clearDeniedErr ? { error: null, phase: this.snap.phase === "error" ? "idle" : this.snap.phase } : {}),
          });
        };
      }
      const clearErr =
        mapped === "granted" &&
        (this.snap.error === "MIC_PERMISSION_DENIED" || this.snap.error === "MIC_IFRAME_BLOCKED");
      this.update({
        permissionState: mapped,
        ...(clearErr ? { error: null, phase: this.snap.phase === "error" ? "idle" : this.snap.phase } : {}),
      });
      return mapped;
    } catch {
      return this.snap.permissionState;
    }
  }

  async requestMicrophoneAccess(): Promise<boolean> {
    const supported = detectMicSupported();
    this.update({ micSupported: supported });
    if (typeof window !== "undefined" && window.isSecureContext === false) {
      this.update({ phase: "error", error: "MIC_INSECURE_CONTEXT" });
      throw new Error("MIC_INSECURE_CONTEXT");
    }
    try {
      const stream = await acquireMicrophoneStream();
      for (const tr of stream.getTracks()) tr.stop();
      this.update({
        permissionState: "granted",
        error: null,
        phase: this.snap.phase === "error" ? "idle" : this.snap.phase,
        micSupported: detectMicSupported(),
      });
      return true;
    } catch (err) {
      const code = mapMicError(err);
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
    const supported = detectMicSupported();
    if (!supported || typeof MediaRecorder === "undefined") {
      const code = typeof window !== "undefined" && window.isSecureContext === false ? "MIC_INSECURE_CONTEXT" : "MIC_UNSUPPORTED";
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
      const stream = await acquireMicrophoneStream();
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
      const actualBaseMime = (mr.mimeType || choice.baseMime).split(";")[0].trim().toLowerCase() || choice.baseMime;
      const actualExt = actualBaseMime.includes("mp4") ? "m4a" : actualBaseMime.includes("ogg") ? "ogg" : "webm";

      const deviceLabel = stream.getAudioTracks()[0]?.label;
      const session = await startRecordingSessionRecord({
        subjectId: opts.subjectId,
        lectureId: opts.lectureId || undefined,
        title: opts.title,
        mime: actualBaseMime,
        ext: actualExt,
        deviceLabel,
      });
      createdSessionId = session.id;

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

      this.attachUnloadGuard(true);
      await this.requestWakeLock();
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
      const msg = mapMicError(err);
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
