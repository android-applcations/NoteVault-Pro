// PWA and offline layer – service worker registration, safe update deferrals, and install detection.
import { useEffect, useState } from "react";
import { isStandaloneMode } from "@/services/permissions";

let updateRequested = false;
let pendingApply: (() => void) | null = null;
let safetyCheckFn: (() => boolean) | null = null;

export function registerServiceWorker(
  onUpdate: (apply: () => void) => void,
  canApplySafely?: () => boolean
) {
  safetyCheckFn = canApplySafely ?? null;
  if (!("serviceWorker" in navigator) || !/^https?:$/.test(location.protocol)) return;

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!updateRequested) return;
    if (safetyCheckFn && !safetyCheckFn()) {
      // Never interrupt an active recording or save operation with an abrupt reload
      updateRequested = false;
      return;
    }
    location.reload();
  });

  const go = () => {
    navigator.serviceWorker
      .register("./sw.js", { updateViaCache: "none" })
      .then((reg) => {
        const offer = (w: ServiceWorker) => {
          pendingApply = () => {
            if (safetyCheckFn && !safetyCheckFn()) {
              return;
            }
            updateRequested = true;
            w.postMessage({ type: "SKIP_WAITING" });
          };
          onUpdate(pendingApply);
        };
        if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
        reg.addEventListener("updatefound", () => {
          const nw = reg.installing;
          nw?.addEventListener("statechange", () => {
            if (nw.state === "installed" && navigator.serviceWorker.controller) offer(nw);
          });
        });
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") void reg.update().catch(() => undefined);
        });
        setInterval(() => void reg.update().catch(() => undefined), 60 * 60 * 1000);
      })
      .catch(() => undefined);
  };
  if (document.readyState === "complete") go();
  else window.addEventListener("load", go, { once: true });
}

interface BIPEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}
let deferred: BIPEvent | null = null;
const listeners = new Set<() => void>();
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as BIPEvent;
    listeners.forEach((l) => l());
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    listeners.forEach((l) => l());
  });
}

export function useInstall() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  const standalone = isStandaloneMode();
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const ios = /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  const android = /android/i.test(ua);
  return {
    canInstall: !!deferred,
    installed: standalone,
    ios: ios && !standalone,
    android: android && !standalone,
    install: async () => {
      if (!deferred) return;
      await deferred.prompt();
      await deferred.userChoice;
      deferred = null;
      listeners.forEach((l) => l());
    },
  };
}
