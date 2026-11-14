# Security Audit

## Automated & Manual Tooling Executed
- **Static analysis (Semgrep)**: scanned `src/`, `public/`, `scripts/`, `index.html`, and `vite.config.ts` across 87 files using `typescript/lang/security`, `javascript/lang/security`, and `html/security` rulesets (`0` security findings in application/build code; 2 test-fixture false positives on PDF dictionary syntax `<</Length ...>>` in `src/__tests__/pdf.test.ts`).
- **Secret scanning (`detect-secrets`)**: `0` findings across `src/`, `public/`, `scripts/`, `index.html`, `vite.config.ts`.
- **Dependency audit (`npm audit`)**: `0` vulnerabilities across all installed packages (`pdfjs-dist` pinned to `5.5.207`, `zod` `4.6.7`, `katex` `0.19.1`, `tesseract.js` `7.0.0`).
- **Playwright CSP enforcement checks**: verified zero `securitypolicyviolation` events and zero external network requests across all E2E suites (`e2e/app.spec.ts`, `e2e/pwa.spec.ts`, `e2e/pdf.spec.ts`, `e2e/phase8.spec.ts`).

## Controls Implemented
1. **Strict CSP & Zero Inline Scripts**: `index.html` uses an external `./boot.js` theme script and `<meta http-equiv="Content-Security-Policy">` with `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self' blob: data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'`. Zod v4 JIT (`new Function`) probes are disabled via `z.config({ jitless: true })` so strict CSP triggers zero `script-src:eval` violations.
2. **XSS & CSS Injection Prevention**: `src/domain/sanitize.ts` enforces allowlisted Tiptap node/mark schemas (`sanitizeDoc`), validates `http:`/`https:`/`mailto:`/`tel:` URLs (`safeUrl`), validates UUID attachment IDs (`AttachmentImage`), sanitizes inline colors/sizes (`safeCssColor`, `safeHexColor`, `safeCssSize`, `safeDataImageUrl`), and neutralizes SVG/CSS injection vectors across pages (`Subjects`, `SubjectPage`, `Dashboard`, `Semesters`, `PdfViewer`, `References`).
3. **KaTeX Safety**: `src/ui/FormulaView.tsx` renders via `katex.render()` into a controlled DOM element (zero `dangerouslySetInnerHTML`) with `trust: false`, `strict: "ignore"`, `maxExpand: 200`, `maxSize: 10`, and `2000`-char input truncation.
4. **Offline OCR Isolation**: `src/files/ocr.ts` loads only same-origin `/ocr/` assets (`workerBlobURL: false`), downscales oversized images (`3000` px max edge), and guarantees `worker.terminate()` in `finally`.
5. **Upload & Worker File Validation**: `src/files/fileCore.ts` + `fileWorker.ts` validate file extensions, magic bytes, UTF-8 decoding, structural dimensions (12,000 px max, 40M px cap), and PNG zlib/DEFLATE bomb ratios before persisting blobs, subject to `checkStorageQuota()` (98% quota limit).
6. **PDF.js Hardening**: `eval` and XFA remain disabled (`isEvalSupported: false`, `enableXfa: false`); PDF streaming uses `BlobRangeTransport` without pulling entire multi-megabyte buffers into JS heap.
7. **Backup Archive Validation**: `src/services/backup.ts` + `backupSchemas.ts` enforce streaming `fflate.Zip`/`Unzip`, size/entry/ratio bomb guards (`1.5 GiB` ZIP, `2 GiB` uncompressed, `250x` ratio cap over `16 MiB`), SHA-256 `tableHashes`, per-table Zod row validation, relation checks, note document sanitization, blob magic/SHA-256 checks, and atomic IndexedDB transactions.
8. **Service Worker Hardening**: `public/sw.js` caches same-origin GETs only, excludes `ocr/*` from initial shell precache while caching on demand into runtime cache, uses `{ ignoreVary: true }` on shell matches, and checks `event.source.url` origin on `SKIP_WAITING` messages.

## Residual Limitations
- `frame-ancestors 'none'` cannot be set inside `<meta http-equiv="Content-Security-Policy">` and should be configured as an HTTP response header when deploying on a web server.
- Local IndexedDB storage is unencrypted at rest on the user's device.
- `style-src 'unsafe-inline'` remains necessary for Tailwind/KaTeX/Tiptap runtime style attributes.
