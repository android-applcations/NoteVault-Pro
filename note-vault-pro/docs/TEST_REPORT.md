# Test Report

## Type Checking & Production Build
- `npm run typecheck` (`tsc --noEmit`): **0 errors**.
- `npm run build` (`vite build`): **Clean multi-file production bundle** with SHA-256 precache injection into `dist/sw.js` and local OCR bundle assets copied to `dist/ocr/`.

## Unit & Integration Tests (`vitest run`)
**54 / 54 tests passing across 8 test suites**:
- `src/__tests__/domain.test.ts` (9 tests): text normalization, Arabic search snippets, `sanitizeDoc`, `safeUrl`, `safeCssColor`/`safeHexColor`, APA/IEEE citations, FSRS cloze/quiz parsers.
- `src/__tests__/services.test.ts` (14 tests): subjects, semesters, lectures, note autosave/retry/versions/cascade trash restore & purge, bilingual search index, FSRS flashcard scheduling, quiz grading, backup round-trip/merge/hostile archive rejection.
- `src/__tests__/lectureForm.test.tsx` (6 tests): lecture creation modal & `SubjectPage` state updates with real `fake-indexeddb`.
- `src/__tests__/pdf.test.ts` (4 tests): `BlobRangeTransport` range requests and resumable/cancellable `extractPdfIncremental`.
- `src/__tests__/fileSecurity.test.ts` (10 tests): magic-byte validation, filename sanitization, SVG sanitization/rejection, PNG dimension/deflate bomb protection.
- `src/__tests__/backupSecurity.test.ts` (4 tests): streaming DEFLATE ZIP bomb blocking, SHA-256 `tableHashes` tampering detection, strict Zod payload/CSS injection validation.
- `src/__tests__/storageIntegrity.test.ts` (3 tests): `checkStorageQuota`, orphan auditing (`auditDatabaseIntegrity`), and atomic orphan cleanup (`cleanupOrphans`).
- `src/__tests__/formulaAndHighlight.test.tsx` (4 tests): KaTeX rendering with `trust: false`, `FormulaText` mixed Arabic/LaTeX splitting, `HighlightRect` Zod validation, and `runImageOcr` local `/ocr/` asset options + `worker.terminate()` guarantee.

## End-to-End Browser Tests (`playwright test`, Chromium)
**6 / 6 E2E specs passing** against the production preview server:
- `e2e/app.spec.ts` (2 specs): full subjects -> lectures -> note autosave & reload -> Arabic/English search -> PDF upload/viewer -> flashcard review flow; offline note creation/editing/reload under `setOffline(true)`.
- `e2e/pdf.spec.ts` (1 spec): 60-page PDF virtual scrolling, offscreen page DOM release, page jump & zoom persistence across reload, and page search.
- `e2e/pwa.spec.ts` (2 specs): manifest/icons/CSP verification, service worker precache verification, offline lazy-route navigation across all pages, Android/iOS install guidance, and zero CSP violations.
- `e2e/phase8.spec.ts` (1 spec): KaTeX formulas in flashcards & note editor, coordinate-based PDF visual highlight overlays with scale & reload persistence, and real offline English OCR in `FileViewer` with all non-localhost requests aborted and zero CSP violations.

## Known Unverified Areas
- Physical mobile touch gestures, screen-reader AT traversal, OS-level browser storage eviction under low-disk pressure, and native mobile install prompts were not tested in this headless Linux environment.
