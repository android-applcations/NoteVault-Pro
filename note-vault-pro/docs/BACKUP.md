# Backup

- **Archive Format**: Streaming ZIP (`manifest.json`, `data/<table>.json`, `blobs/<id>`) generated and parsed using streaming `fflate.Zip` and `fflate.Unzip`.
- **Hardened Import Guards (`src/services/backup.ts`, `src/services/backupSchemas.ts`)**:
  - Archive & decompression bounds: max `1.5 GiB` ZIP, max `2 GiB` total uncompressed bytes, max `1 MiB` manifest, max `100 MiB` per JSON table, max `220 MiB` per blob, max `100,000` ZIP entries, and `250x` DEFLATE expansion ratio bomb guard (over `16 MiB` threshold).
  - Integrity & schema validation: entry path allowlist (blocks traversal/duplicate names), `DATA_VERSION` compatibility check, per-table SHA-256 `tableHashes` verification, strict Zod row parsing (`TABLE_SCHEMAS` with `z.config({ jitless: true })`, sanitized CSS/SVG/URL/image fields, and bounded `Highlight.rects`), foreign-key relation verification, Tiptap `sanitizeDoc`, and blob magic-byte + SHA-256 verification.
  - Batched transactional restore: replace/merge imports execute atomically inside Dexie transactions with chunked bulk writes so partial failures roll back cleanly.
