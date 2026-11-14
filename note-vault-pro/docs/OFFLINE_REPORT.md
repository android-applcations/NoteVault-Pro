# Offline Report

- **Multi-file PWA Architecture (`base: "./"`)**: Built with code splitting (`vite.config.ts`), generated PNG icons (`scripts/make-icons.mjs`), `public/manifest.webmanifest`, `public/offline.html`, and external `./boot.js`.
- **Service Worker (`public/sw.js`)**: Hand-written, zero third-party network calls, same-origin only. `vite.config.ts` computes a SHA-256 build hash (`VERSION = "nv-<hash>"`) and injects all precacheable `dist/` JS/CSS/font/HTML/icon assets into `dist/sw.js` while excluding `ocr/*` (~16 MB) from initial shell install. Non-precached same-origin GETs (such as `/ocr/*.wasm.js` and `/ocr/*.traineddata.gz`) are cached lazily in `RUNTIME_CACHE` when first requested, and navigation falls back to `offline.html` when needed.
- **Offline Capabilities Verified**:
  - Full cold navigation across all lazy routes (`e2e/pwa.spec.ts`) with `context.setOffline(true)` after initial load.
  - Note creation, editing, IndexedDB autosave, and reload offline (`e2e/app.spec.ts`).
  - Local Tesseract OCR (`worker.min.js`, SIMD/non-SIMD LSTM `.wasm.js`, `eng`/`ara` traineddata) running entirely from same-origin `/ocr/` assets with all external hosts blocked (`e2e/phase8.spec.ts`).
- **Residual Limitations**: Browser-enforced quota eviction under severe OS disk pressure and native mobile home-screen install flows were not tested on physical Android/iOS hardware.
