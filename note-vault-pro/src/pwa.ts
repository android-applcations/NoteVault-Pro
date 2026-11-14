// PWA and offline layer – service worker registration, update detection and install prompt.
import { useEffect, useState } from "react";

let updateRequested = false;

export function registerServiceWorker(onUpdate: (apply: () => void) => void) {
  if (!("serviceWorker" in navigator) || !/^https?:$/.test(location.protocol)) return;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (updateRequested) location.reload(); // only reload when the user accepted the update
  });
  const go = () => {
    navigator.serviceWorker
      .register("./sw.js")
      .then((reg) => {
        const offer = (w: ServiceWorker) =>
          onUpdate(() => {
            updateRequested = true;
            w.postMessage({ type: "SKIP_WAITING" });
          });
        if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
        reg.addEventListener("updatefound", () => {
          const nw = reg.installing;
          nw?.addEventListener("statechange", () => {
            if (nw.state === "installed" && navigator.serviceWorker.controller) offer(nw);
          });
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
  const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  return {
    canInstall: !!deferred,
    installed: standalone,
    ios: ios && !standalone,
    install: async () => {
      if (!deferred) return;
      await deferred.prompt();
      await deferred.userChoice;
      deferred = null;
      listeners.forEach((l) => l());
    },
  };
}
