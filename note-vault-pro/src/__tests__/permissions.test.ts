// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { permissionManager } from "@/services/permissions";

const ROOT = path.resolve(__dirname, "..", "..");

describe("Centralized AppPermissionManager & PWA manifest/SW hardening", () => {
  const origDevices = navigator.mediaDevices;
  const origPermissions = navigator.permissions;
  const origWakeLock = (navigator as unknown as { wakeLock?: unknown }).wakeLock;
  const origMediaRecorder = (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder;

  afterEach(async () => {
    await permissionManager.releaseWakeLock();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: origDevices });
    Object.defineProperty(navigator, "permissions", { configurable: true, value: origPermissions });
    Object.defineProperty(navigator, "wakeLock", { configurable: true, value: origWakeLock });
    (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder = origMediaRecorder;
  });

  it("validates modern Android-ready PWA manifest fields and app shortcuts without fullscreen", () => {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, "public/manifest.webmanifest"), "utf8")) as {
      id: string;
      name: string;
      short_name: string;
      start_url: string;
      scope: string;
      display: string;
      display_override: string[];
      orientation: string;
      lang: string;
      dir: string;
      prefer_related_applications: boolean;
      icons: Array<{ src: string; sizes: string; purpose?: string }>;
      shortcuts: Array<{ name: string; url: string; icons: Array<{ src: string }> }>;
    };

    expect(manifest.id).toBe("./");
    expect(manifest.name).toBe("NoteVault Pro");
    expect(manifest.short_name).toBe("NoteVault Pro");
    expect(manifest.start_url).toBe("./");
    expect(manifest.scope).toBe("./");
    expect(manifest.display).toBe("standalone");
    expect(manifest.display).not.toBe("fullscreen");
    expect(manifest.display_override).toContain("standalone");
    expect(manifest.orientation).toBe("any");
    expect(manifest.lang).toBe("ar");
    expect(manifest.dir).toBe("rtl");
    expect(manifest.prefer_related_applications).toBe(false);
    expect(manifest.icons.some((i) => i.sizes === "192x192")).toBe(true);
    expect(manifest.icons.some((i) => i.sizes === "512x512" && i.purpose === "maskable")).toBe(true);
    expect(manifest.shortcuts.length).toBeGreaterThanOrEqual(3);
    expect(manifest.shortcuts.some((s) => s.url === "./#/record")).toBe(true);

    const sw = readFileSync(path.join(ROOT, "public/sw.js"), "utf8");
    expect(sw).toContain('if (req.method !== "GET") return');
    expect(sw).toContain("no-store");
    expect(sw).toContain("Set-Cookie");
    expect(sw).toContain("offline.html");
  });

  it("handles Safari/unsupported Permissions API gracefully (NotSupportedError) and watches live changes", async () => {
    (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder = class {};
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn() },
    });

    // Safari throws TypeError on navigator.permissions.query({ name: 'microphone' })
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: {
        query: vi.fn(async () => {
          throw new DOMException("Not supported", "NotSupportedError");
        }),
      },
    });
    const stateWhenUnsupported = await permissionManager.queryPermissionState("microphone");
    expect(["unknown", "prompt", "granted", "denied"]).toContain(stateWhenUnsupported);

    // Chrome/Android live PermissionStatus onchange updates snapshot automatically
    let changeHandler: (() => void) | null = null;
    const statusObj = {
      state: "prompt",
      set onchange(fn: (() => void) | null) {
        changeHandler = fn;
      },
      get onchange() {
        return changeHandler;
      },
    };
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: {
        query: vi.fn(async () => statusObj),
      },
    });
    expect(await permissionManager.queryPermissionState("microphone")).toBe("prompt");
    statusObj.state = "granted";
    const fn = changeHandler as (() => void) | null;
    fn?.();
    expect(permissionManager.getSnapshot().microphone).toBe("granted");
  });

  it("acquires & releases MediaStream tracks properly and maps busy/missing/denied errors accurately", async () => {
    const stopSpy = vi.fn();
    (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder = class {};
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => ({
          getTracks: () => [{ stop: stopSpy }],
          getAudioTracks: () => [{ label: "Phone Mic", stop: stopSpy }],
        })),
      },
    });

    expect(await permissionManager.requestMicrophoneAccess()).toBe(true);
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(permissionManager.getSnapshot().microphone).toBe("granted");

    // NotReadableError -> MIC_IN_USE
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => {
          throw new DOMException("Mic busy", "NotReadableError");
        }),
      },
    });
    await expect(permissionManager.requestMicrophoneStream()).rejects.toThrow("MIC_IN_USE");

    // NotFoundError -> MIC_NOT_FOUND
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => {
          throw new DOMException("No mic", "NotFoundError");
        }),
      },
    });
    await expect(permissionManager.requestMicrophoneStream()).rejects.toThrow("MIC_NOT_FOUND");
  });

  it("acquires Screen Wake Lock only on request and releases it cleanly", async () => {
    const releaseSpy = vi.fn(async () => undefined);
    const requestSpy = vi.fn(async () => ({
      released: false,
      release: releaseSpy,
      addEventListener: vi.fn(),
    }));
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: { request: requestSpy },
    });

    expect(await permissionManager.acquireWakeLock()).toBe(true);
    expect(requestSpy).toHaveBeenCalledWith("screen");
    expect(permissionManager.getSnapshot().wakeLockActive).toBe(true);

    await permissionManager.releaseWakeLock();
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect(permissionManager.getSnapshot().wakeLockActive).toBe(false);
  });
});
