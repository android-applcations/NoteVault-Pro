# Database

Dexie database `notevault-pro`, **schema v2 (`DATA_VERSION = 2`)**, 25 tables (`semesters`, `subjects`, `lectures`, `notes`, `noteVersions`, `attachments`, `blobs`, `pdfDocuments`, `bookmarks`, `highlights`, `annotations`, `flashcardDecks`, `flashcards`, `reviewLogs`, `quizzes`, `quizQuestions`, `quizAttempts`, `references`, `tags`, `noteTags`, `searchIndex`, `activities`, `appSettings`, `trashItems`, `events`).

- **Schema v1 -> v2 Migration (`db.version(2).upgrade`)**: Adds `pdfDocuments.indexStatus` and `flashcards.imageId` indexes, backfills `indexStatus` (`done` / `idle`) and `indexedPages` on existing `pdfDocuments`, and updates `appSettings.schemaVersion` to `2`.
- **Coordinate PDF Highlights**: `Highlight` supports optional normalized `[0..1]` `rects?: HighlightRect[]` (`x, y, w, h`) so overlays scale cleanly across zoom changes while remaining backward-compatible with legacy rect-less snippet highlights.
- **Storage Quota & Integrity Controls (`src/services/storage.ts`)**:
  - `checkStorageQuota(bytesNeeded)` checks `navigator.storage.estimate()` before large blob/attachment imports and rejects writes exceeding `98%` of quota (`QUOTA_EXCEEDED`).
  - `auditDatabaseIntegrity()` & `cleanupOrphans()` scan and atomically clean unreferenced `blobs`, orphan PDF records (`pdfDocuments`, `bookmarks`, `highlights`, `annotations`), `noteVersions`, `noteTags`, `reviewLogs`, `quizQuestions`, `quizAttempts`, and stale `trashItems`, exposed in Settings.
- **Soft Delete & Transactions**: Subjects, lectures, notes, and attachments use `deletedAt` + `trashId` with cascade restore/purge; cards, decks, quizzes, references, and events are hard-deleted after confirmation inside transactions.
