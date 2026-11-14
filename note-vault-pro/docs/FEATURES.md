# Features

## Implemented
- **Academic Organization**: Semesters, subjects, lectures (weeks, 4 views, duplicate/move/archive), dashboard, calendar, quick capture (`Alt+N`), trash with cascade restore/purge.
- **Rich Note Editor (`RichEditor.tsx`)**: Tiptap editor with headings, formatting marks, colors/highlights/font sizes, lists, task checklists, quotes, tables, callouts, code blocks, stored attachments, `/` slash command menu, bubble menu, autosave + version history, 8 templates, and **LaTeX Formula Modal + live KaTeX preview strip** (`Σ` / `/formula`).
- **KaTeX Math Rendering (`FormulaView.tsx`, `CardView.tsx`, `Flashcards.tsx`)**: Safe local KaTeX (`trust: false`) rendering for `$...$` / `$$...$$` expressions in flashcards, review mode, formula cards, and editor math formulas.
- **Virtual Scrolling PDF Viewer (`PdfViewer.tsx`)**: Streaming `BlobRangeTransport`, true DOM viewport virtualization (with overscan and page/zoom persistence), resumable/cancellable incremental PDF indexing, full-text page search, bookmarks, annotations, flashcard creation from selections, and **4-color normalized `[0..1]` coordinate visual highlight overlays** (with legacy text-layer fallback).
- **Offline Image OCR (`FileViewer.tsx`, `RichEditor.tsx`, `src/files/ocr.ts`)**: Client-side same-origin Tesseract OCR (`ara+eng`, `eng`, `ara`) using bundled `/ocr/` WASM & traineddata packs, progress reporting, copy, insert into note, or create a new note directly from extracted text.
- **Study & Vault Tools**: Worker-backed file validation & dedupe, universal bilingual Arabic/English search (`MiniSearch`), flashcards (8 card types + FSRS scheduling), quizzes (7 question types), citations/references (APA/MLA/IEEE/Chicago), storage quota/integrity audit & orphan cleanup, streaming ZIP backup/restore, and multi-file offline PWA.

## Residual Limitations
- Local IndexedDB data is not encrypted at rest.
- Server HTTP response headers (`frame-ancestors 'none'`, HSTS) must be set by the hosting server rather than `<meta>` CSP.
- OCR accuracy depends on image contrast/resolution and loads only English (`eng`) and Arabic (`ara`) traineddata packs locally.
