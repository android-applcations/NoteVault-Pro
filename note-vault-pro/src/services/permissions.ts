// Centralized device permission & browser capability manager.
// Uses real feature detection and live browser status — never guesses permissions from localStorage.

export type LivePermissionState = "granted" | "denied" | "prompt" | "unsupported" | "unknown";

export type DevicePermissionKind = "microphone" | "camera" | "notifications" | "geolocation";

export interface AppCapabilitiesSnapshot {
  isSecureContext: boolean;
  isStandalone: boolean;
  isEmbedded: boolean;
  isInAppBrowser: boolean;
  microphoneSupported: boolean;
  microphone: LivePermissionState;
  cameraSupported: boolean;
  camera: LivePermissionState;
  notificationsSupported: boolean;
  notifications: LivePermissionState;
  geolocationSupported: boolean;
  geolocation: LivePermissionState;
  wakeLockSupported: boolean;
  wakeLockActive: boolean;
  clipboardSupported: boolean;
  fileSystemAccessSupported: boolean;
  webShareSupported: boolean;
  bluetoothSupported: boolean;
  screenCaptureSupported: boolean;
}

export function isEmbeddedFrame(): boolean {
  try {
    return typeof window !== "undefined" && window.self !== window.top;
  } catch {
    return true;
  }
}

export function isStandaloneMode(): boolean {
  if (typeof window === "undefined") return false;
  const mq = typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches;
  const iosStandalone = (navigator as unknown as { standalone?: boolean }).standalone === true;
  return mq || iosStandalone;
}

export function isInAppBrowserUA(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return /FBAN|FBAV|Instagram|WhatsApp|Telegram|Line|Snapchat|Twitter|MicroMessenger|; wv\)/i.test(ua);
}

export function detectMicrophoneSupport(): boolean {
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

export function detectCameraSupport(): boolean {
  if (typeof navigator === "undefined") return false;
  const legacyNav = navigator as unknown as {
    webkitGetUserMedia?: unknown;
    mozGetUserMedia?: unknown;
  };
  return Boolean(
    navigator.mediaDevices?.getUserMedia || legacyNav.webkitGetUserMedia || legacyNav.mozGetUserMedia
  );
}

export function mapMicrophoneError(err: unknown): string {
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
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
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
  const legacy = navigator as unknown as {
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
  };
  const fn = legacy.webkitGetUserMedia ?? legacy.mozGetUserMedia;
  if (!fn) throw new Error("MIC_UNSUPPORTED");
  return new Promise<MediaStream>((resolve, reject) => {
    fn.call(navigator, constraints, resolve, reject);
  });
}

function mapPermissionApiState(state: string): LivePermissionState {
  if (state === "granted" || state === "denied" || state === "prompt") return state;
  return "unknown";
}

function computeInitialSnapshot(): AppCapabilitiesSnapshot {
  const hasNav = typeof navigator !== "undefined";
  const hasWin = typeof window !== "undefined";
  const notifPerm: LivePermissionState =
    typeof Notification === "undefined"
      ? "unsupported"
      : Notification.permission === "granted"
        ? "granted"
        : Notification.permission === "denied"
          ? "denied"
          : "prompt";
  const micSup = detectMicrophoneSupport();
  const camSup = detectCameraSupport();
  const geoSup = hasNav && Boolean(navigator.geolocation);

  return {
    isSecureContext: hasWin ? window.isSecureContext !== false : true,
    isStandalone: isStandaloneMode(),
    isEmbedded: isEmbeddedFrame(),
    isInAppBrowser: isInAppBrowserUA(),
    microphoneSupported: micSup,
    microphone: micSup ? "unknown" : "unsupported",
    cameraSupported: camSup,
    camera: camSup ? "unknown" : "unsupported",
    notificationsSupported: typeof Notification !== "undefined",
    notifications: notifPerm,
    geolocationSupported: geoSup,
    geolocation: geoSup ? "unknown" : "unsupported",
    wakeLockSupported: hasNav && typeof navigator.wakeLock?.request === "function",
    wakeLockActive: false,
    clipboardSupported: hasNav && typeof navigator.clipboard?.writeText === "function",
    fileSystemAccessSupported:
      hasWin &&
      typeof (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker === "function",
    webShareSupported: hasNav && typeof navigator.share === "function",
    bluetoothSupported: hasNav && "bluetooth" in navigator,
    screenCaptureSupported:
      hasNav && typeof navigator.mediaDevices?.getDisplayMedia === "function",
  };
}

class AppPermissionManager {
  private snap: AppCapabilitiesSnapshot = computeInitialSnapshot();
  private listeners = new Set<(s: AppCapabilitiesSnapshot) => void>();
  private statusRefs = new Map<DevicePermissionKind, PermissionStatus>();
  private wakeLockSentinel: WakeLockSentinel | null = null;

  getSnapshot(): AppCapabilitiesSnapshot {
    return { ...this.snap };
  }

  subscribe(fn: (s: AppCapabilitiesSnapshot) => void): () => void {
    this.listeners.add(fn);
    fn(this.getSnapshot());
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(patch: Partial<AppCapabilitiesSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    const copy = this.getSnapshot();
    this.listeners.forEach((fn) => fn(copy));
  }

  async queryPermissionState(kind: DevicePermissionKind): Promise<LivePermissionState> {
    if (kind === "notifications") {
      if (typeof Notification === "undefined") return "unsupported";
      const s: LivePermissionState =
        Notification.permission === "granted"
          ? "granted"
          : Notification.permission === "denied"
            ? "denied"
            : "prompt";
      this.emit({ notifications: s, notificationsSupported: true });
      return s;
    }

    const supported =
      kind === "microphone"
        ? detectMicrophoneSupport()
        : kind === "camera"
          ? detectCameraSupport()
          : typeof navigator !== "undefined" && Boolean(navigator.geolocation);

    if (!supported) {
      if (kind === "microphone") this.emit({ microphoneSupported: false, microphone: "unsupported" });
      if (kind === "camera") this.emit({ cameraSupported: false, camera: "unsupported" });
      if (kind === "geolocation") this.emit({ geolocationSupported: false, geolocation: "unsupported" });
      return "unsupported";
    }

    const fallbackState: LivePermissionState =
      this.snap[kind] === "unsupported" ? "unknown" : this.snap[kind];
    if (kind === "microphone" && (!this.snap.microphoneSupported || this.snap.microphone === "unsupported")) {
      this.emit({ microphoneSupported: true, microphone: fallbackState });
    } else if (kind === "camera" && (!this.snap.cameraSupported || this.snap.camera === "unsupported")) {
      this.emit({ cameraSupported: true, camera: fallbackState });
    } else if (kind === "geolocation" && (!this.snap.geolocationSupported || this.snap.geolocation === "unsupported")) {
      this.emit({ geolocationSupported: true, geolocation: fallbackState });
    }

    if (typeof navigator === "undefined" || typeof navigator.permissions?.query !== "function") {
      return fallbackState;
    }

    try {
      const status = await navigator.permissions.query({ name: kind as PermissionName });
      const mapped = mapPermissionApiState(status.state);
      if (this.statusRefs.get(kind) !== status) {
        this.statusRefs.set(kind, status);
        status.onchange = () => {
          const next = mapPermissionApiState(status.state);
          this.emit({ [kind]: next } as Partial<AppCapabilitiesSnapshot>);
        };
      }
      this.emit({ [kind]: mapped } as Partial<AppCapabilitiesSnapshot>);
      return mapped;
    } catch {
      // Safari / iPadOS throws TypeError/NotSupportedError for unqueryable PermissionNames such as "microphone" or "camera".
      return fallbackState;
    }
  }

  async refreshAll(): Promise<AppCapabilitiesSnapshot> {
    const base = computeInitialSnapshot();
    this.emit({
      isSecureContext: base.isSecureContext,
      isStandalone: base.isStandalone,
      isEmbedded: base.isEmbedded,
      isInAppBrowser: base.isInAppBrowser,
      microphoneSupported: base.microphoneSupported,
      cameraSupported: base.cameraSupported,
      notificationsSupported: base.notificationsSupported,
      notifications: base.notifications,
      geolocationSupported: base.geolocationSupported,
      wakeLockSupported: base.wakeLockSupported,
      clipboardSupported: base.clipboardSupported,
      fileSystemAccessSupported: base.fileSystemAccessSupported,
      webShareSupported: base.webShareSupported,
      bluetoothSupported: base.bluetoothSupported,
      screenCaptureSupported: base.screenCaptureSupported,
    });
    await Promise.all([
      this.queryPermissionState("microphone"),
      this.queryPermissionState("camera"),
      this.queryPermissionState("geolocation"),
      this.queryPermissionState("notifications"),
    ]);
    return this.getSnapshot();
  }

  releaseStream(stream: MediaStream | null | undefined): void {
    if (!stream) return;
    for (const tr of stream.getTracks()) {
      try {
        tr.stop();
      } catch {
        /* ignore */
      }
    }
  }

  async requestMicrophoneStream(): Promise<MediaStream> {
    const micSup = detectMicrophoneSupport();
    this.emit({ microphoneSupported: micSup });

    if (typeof window !== "undefined" && window.isSecureContext === false) {
      throw new Error("MIC_INSECURE_CONTEXT");
    }
    if (!micSup) {
      this.emit({ microphone: "unsupported" });
      throw new Error("MIC_UNSUPPORTED");
    }

    try {
      let stream: MediaStream;
      try {
        stream = await getUserMediaRaw({
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
          stream = await getUserMediaRaw({ audio: true });
        } else {
          throw err;
        }
      }
      this.emit({ microphone: "granted" });
      return stream;
    } catch (err) {
      const code = mapMicrophoneError(err);
      if (code === "MIC_PERMISSION_DENIED") {
        this.emit({ microphone: "denied" });
      } else if (code === "MIC_UNSUPPORTED" && !detectMicrophoneSupport()) {
        this.emit({ microphone: "unsupported", microphoneSupported: false });
      }
      throw new Error(code);
    }
  }

  async requestMicrophoneAccess(): Promise<boolean> {
    const stream = await this.requestMicrophoneStream();
    this.releaseStream(stream);
    return true;
  }

  async acquireWakeLock(): Promise<boolean> {
    if (typeof navigator === "undefined" || typeof navigator.wakeLock?.request !== "function") {
      return false;
    }
    if (this.wakeLockSentinel && !this.wakeLockSentinel.released) {
      this.emit({ wakeLockActive: true });
      return true;
    }
    try {
      const sentinel = await navigator.wakeLock.request("screen");
      this.wakeLockSentinel = sentinel;
      this.emit({ wakeLockActive: true });
      sentinel.addEventListener(
        "release",
        () => {
          if (this.wakeLockSentinel === sentinel) {
            this.wakeLockSentinel = null;
          }
          this.emit({ wakeLockActive: false });
        },
        { once: true }
      );
      return true;
    } catch {
      this.wakeLockSentinel = null;
      this.emit({ wakeLockActive: false });
      return false;
    }
  }

  async releaseWakeLock(): Promise<void> {
    const cur = this.wakeLockSentinel;
    this.wakeLockSentinel = null;
    this.emit({ wakeLockActive: false });
    if (!cur) return;
    try {
      await cur.release();
    } catch {
      /* ignore */
    }
  }

  async copyText(text: string): Promise<boolean> {
    if (typeof navigator === "undefined" || typeof navigator.clipboard?.writeText !== "function") {
      return false;
    }
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }
}

export const permissionManager = new AppPermissionManager();
