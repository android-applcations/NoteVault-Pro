// Application services – backup & restore (streaming ZIP: manifest.json + data/*.json + blobs/<id>).
import { strFromU8, strToU8, Unzip, UnzipInflate, UnzipPassThrough, Zip, ZipDeflate, ZipPassThrough } from "fflate";
import { db, DATA_VERSION, TABLE_NAMES, type TableName } from "@/data/db";
import { isUuid, safeCssColor, safeDataImageUrl, safeHexColor, safeUrl, sanitizeDoc } from "@/domain/sanitize";
import { plainFromDoc, sanitizeFileName, wordCount } from "@/domain/text";
import { sha256, validateFile } from "@/files/validate";
import { BackupManifestSchema, ID_RE, TABLE_SCHEMAS } from "./backupSchemas";
import { logActivity } from "./core";
import { rebuildIndex } from "./search";

export const BACKUP_FORMAT = "notevault-backup";
export const BACKUP_VERSION = 1;
export const MAX_IMPORT_BYTES = 1.5 * 1024 ** 3;
const MAX_TOTAL_UNCOMPRESSED = 2 * 1024 ** 3;
const MAX_JSON_BYTES = 100 * 1024 ** 2;
const MAX_BLOB_BYTES = 220 * 1024 ** 2;
const MAX_MANIFEST_BYTES = 1024 ** 2;
const MAX_ENTRIES = 100_000;
const STREAM_READ_CHUNK = 256 * 1024;
const STREAM_WRITE_CHUNK = 512 * 1024;
const DB_BATCH_SIZE = 250;
const BLOB_BATCH_SIZE = 20;
const MAX_DECOMPRESS_RATIO = 250;
const RATIO_CHECK_MIN_BYTES = 16 * 1024 * 1024;
const EXPORT_TABLES = TABLE_NAMES.filter((t) => t !== "blobs" && t !== "searchIndex");

export interface BackupManifest {
  format: string;
  formatVersion: number;
  dataVersion: number;
  app?: string;
  createdAt: number;
  counts?: Record<string, number>;
  blobs?: number;
  tableHashes?: Record<string, string>;
}

export type BackupErrorCode =
  | "too_large"
  | "not_zip"
  | "bad_entry"
  | "no_manifest"
  | "bad_manifest"
  | "newer_version"
  | "bad_json"
  | "bad_record"
  | "relation"
  | "bad_blob"
  | "corrupt"
  | "apply_failed";

export class BackupError extends Error {
  constructor(public code: BackupErrorCode, public detail?: string) {
    super(code + (detail ? `: ${detail}` : ""));
  }
}

type Row = Record<string, unknown> & { id?: string; key?: string };
export interface ParsedBackup {
  manifest: BackupManifest;
  tables: Partial<Record<TableName, Row[]>>;
  blobs: Map<string, Uint8Array | Blob>;
}

async function sha256U8(bytes: Uint8Array): Promise<string> {
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const buf = await crypto.subtle.digest("SHA-256", copy.buffer);
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return sha256(new Blob([bytes as BlobPart]));
}

export async function exportBackup(onProgress?: (msg: string) => void): Promise<Blob> {
  const zipChunks: BlobPart[] = [];
  let streamErr: Error | null = null;
  const donePromise = new Promise<void>((res, rej) => {
    const zipper = new Zip((err, chunk, final) => {
      if (err) {
        streamErr = err;
        rej(err);
        return;
      }
      if (chunk.byteLength > 0) {
        const copy = new Uint8Array(chunk.byteLength);
        copy.set(chunk);
        zipChunks.push(copy);
      }
      if (final) res();
    });

    void (async () => {
      try {
        const counts: Record<string, number> = {};
        const tableHashes: Record<string, string> = {};

        for (const name of EXPORT_TABLES) {
          onProgress?.(name);
          const rows = await db.table(name).toArray();
          counts[name] = rows.length;
          const bytes = strToU8(JSON.stringify(rows));
          tableHashes[name] = await sha256U8(bytes);
          const entry = new ZipDeflate(`data/${name}.json`, { level: 6 });
          zipper.add(entry);
          for (let off = 0; off < bytes.byteLength; off += STREAM_WRITE_CHUNK) {
            const slice = bytes.subarray(off, off + STREAM_WRITE_CHUNK);
            entry.push(slice, off + STREAM_WRITE_CHUNK >= bytes.byteLength);
          }
          if (bytes.byteLength === 0) entry.push(new Uint8Array(0), true);
        }

        const blobIds = (await db.blobs.toCollection().primaryKeys()) as string[];
        let blobCount = 0;
        for (const bid of blobIds) {
          const rec = await db.blobs.get(bid);
          if (!rec) continue;
          const entry = new ZipPassThrough(`blobs/${rec.id}`);
          zipper.add(entry);
          const totalSize = rec.blob.size;
          if (totalSize === 0) {
            entry.push(new Uint8Array(0), true);
          } else {
            for (let off = 0; off < totalSize; off += STREAM_WRITE_CHUNK) {
              const slice = await rec.blob.slice(off, off + STREAM_WRITE_CHUNK).arrayBuffer();
              entry.push(new Uint8Array(slice), off + STREAM_WRITE_CHUNK >= totalSize);
            }
          }
          blobCount++;
        }
        counts.blobs = blobCount;

        const manifest: BackupManifest = {
          format: BACKUP_FORMAT,
          formatVersion: BACKUP_VERSION,
          dataVersion: DATA_VERSION,
          app: "NoteVault Pro",
          createdAt: Date.now(),
          counts,
          blobs: blobCount,
          tableHashes,
        };
        const manifestBytes = strToU8(JSON.stringify(manifest, null, 2));
        const manifestEntry = new ZipDeflate("manifest.json", { level: 6 });
        zipper.add(manifestEntry);
        manifestEntry.push(manifestBytes, true);
        zipper.end();
      } catch (e) {
        rej(e instanceof Error ? e : new Error(String(e)));
      }
    })();
  });

  await donePromise;
  if (streamErr) throw streamErr;
  await logActivity("backup", "Export", "backup");
  return new Blob(zipChunks, { type: "application/zip" });
}

export async function exportNotesText(): Promise<Blob> {
  const notes = await db.notes.filter((n) => !n.deletedAt).toArray();
  const chunks: BlobPart[] = [];
  await new Promise<void>((res, rej) => {
    const zipper = new Zip((err, chunk, final) => {
      if (err) {
        rej(err);
        return;
      }
      if (chunk.byteLength > 0) {
        const copy = new Uint8Array(chunk.byteLength);
        copy.set(chunk);
        chunks.push(copy);
      }
      if (final) res();
    });
    const used = new Set<string>();
    for (const n of notes) {
      let base = sanitizeFileName((n.title || "note").replace(/\.+$/, "")) || "note";
      while (used.has(base.toLowerCase())) base += "-" + n.id.slice(0, 4);
      used.add(base.toLowerCase());
      const entry = new ZipDeflate(`${base}.md`, { level: 6 });
      zipper.add(entry);
      entry.push(strToU8(`# ${n.title || ""}\n\n${n.text}\n`), true);
    }
    zipper.end();
  });
  return new Blob(chunks, { type: "application/zip" });
}

// ------------------------------------------------------------------ Parse (streaming + anti-ZIP-bomb)

const ENTRY_RE = /^(manifest\.json|data\/[A-Za-z]+\.json|blobs\/[A-Za-z0-9_-]{1,64})$/;

function concatU8(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export async function parseBackup(input: Blob | Uint8Array): Promise<ParsedBackup> {
  const size = input instanceof Blob ? input.size : input.byteLength;
  if (size > MAX_IMPORT_BYTES) throw new BackupError("too_large");
  if (size < 4) throw new BackupError("not_zip");

  const magic = input instanceof Blob ? new Uint8Array(await input.slice(0, 4).arrayBuffer()) : input.subarray(0, 4);
  if (magic[0] !== 0x50 || magic[1] !== 0x4b) throw new BackupError("not_zip");

  const seen = new Set<string>();
  const jsonEntries = new Map<string, Uint8Array>();
  const blobs = new Map<string, Uint8Array | Blob>();

  let entries = 0;
  let totalUncompressed = 0;
  let compressedFed = 0;
  let fatal: BackupError | null = null;

  const fail = (code: BackupErrorCode, detail?: string) => {
    if (!fatal) fatal = new BackupError(code, detail);
  };

  const unzipper = new Unzip((file) => {
    if (fatal) return;
    if (file.name.endsWith("/")) return;
    entries++;
    if (!ENTRY_RE.test(file.name) || entries > MAX_ENTRIES || seen.has(file.name)) {
      fail("bad_entry", file.name);
      return;
    }
    seen.add(file.name);

    if (file.compression !== 0 && file.compression !== 8) {
      fail("not_zip", `unsupported compression ${file.compression}`);
      return;
    }

    const isManifest = file.name === "manifest.json";
    const isJson = isManifest || file.name.startsWith("data/");
    const entryLimit = isManifest ? MAX_MANIFEST_BYTES : isJson ? MAX_JSON_BYTES : MAX_BLOB_BYTES;

    if (typeof file.originalSize === "number" && file.originalSize > entryLimit) {
      fail("too_large", file.name);
      return;
    }

    let entryBytes = 0;
    const u8Chunks: Uint8Array[] = [];
    const blobChunks: BlobPart[] = [];

    file.ondata = (err, chunk, final) => {
      if (fatal) return;
      if (err) {
        fail("not_zip", err.message);
        return;
      }
      if (chunk.byteLength > 0) {
        entryBytes += chunk.byteLength;
        totalUncompressed += chunk.byteLength;
        if (entryBytes > entryLimit || totalUncompressed > MAX_TOTAL_UNCOMPRESSED) {
          fail("too_large", file.name);
          file.terminate();
          return;
        }
        // Stream-level ZIP-bomb guard even when local headers omit size (data descriptors)
        if (totalUncompressed > RATIO_CHECK_MIN_BYTES) {
          const ratio = totalUncompressed / Math.max(1024, compressedFed);
          if (ratio > MAX_DECOMPRESS_RATIO) {
            fail("too_large", "zip_bomb_ratio");
            file.terminate();
            return;
          }
        }
        const copy = new Uint8Array(chunk.byteLength);
        copy.set(chunk);
        if (isJson) u8Chunks.push(copy);
        else blobChunks.push(copy);
      }
      if (final) {
        if (isJson) {
          jsonEntries.set(file.name, concatU8(u8Chunks, entryBytes));
        } else {
          blobs.set(file.name.slice(6), new Blob(blobChunks));
        }
      }
    };
    file.start();
  });

  unzipper.register(UnzipPassThrough);
  unzipper.register(UnzipInflate);

  try {
    if (input instanceof Blob) {
      for (let off = 0; off < size; off += STREAM_READ_CHUNK) {
        if (fatal) break;
        const end = Math.min(size, off + STREAM_READ_CHUNK);
        const buf = new Uint8Array(await input.slice(off, end).arrayBuffer());
        compressedFed += buf.byteLength;
        unzipper.push(buf, end >= size);
      }
    } else {
      for (let off = 0; off < size; off += STREAM_READ_CHUNK) {
        if (fatal) break;
        const end = Math.min(size, off + STREAM_READ_CHUNK);
        const slice = input.subarray(off, end);
        compressedFed += slice.byteLength;
        unzipper.push(slice, end >= size);
      }
    }
  } catch (e) {
    if (!fatal) throw new BackupError("not_zip", e instanceof Error ? e.message : String(e));
  }

  if (fatal) throw fatal;

  const manifestBytes = jsonEntries.get("manifest.json");
  if (!manifestBytes) throw new BackupError("no_manifest");

  let rawManifest: Record<string, unknown>;
  try {
    rawManifest = JSON.parse(strFromU8(manifestBytes));
  } catch {
    throw new BackupError("bad_manifest");
  }
  if (
    !rawManifest ||
    typeof rawManifest !== "object" ||
    rawManifest.format !== BACKUP_FORMAT ||
    typeof rawManifest.formatVersion !== "number" ||
    typeof rawManifest.dataVersion !== "number"
  ) {
    throw new BackupError("bad_manifest");
  }
  if (rawManifest.formatVersion > BACKUP_VERSION || rawManifest.dataVersion > DATA_VERSION) {
    throw new BackupError("newer_version");
  }
  const manifestRes = BackupManifestSchema.safeParse(rawManifest);
  if (!manifestRes.success) throw new BackupError("bad_manifest", manifestRes.error.issues[0]?.message);
  const manifest: BackupManifest = manifestRes.data;

  const tables: ParsedBackup["tables"] = {};
  for (const [name, data] of jsonEntries) {
    if (!name.startsWith("data/")) continue;
    const t = name.slice(5, -5) as TableName;
    if (!(EXPORT_TABLES as readonly string[]).includes(t)) throw new BackupError("bad_entry", name);
    if (manifest.tableHashes?.[t]) {
      const actualHash = await sha256U8(data);
      if (actualHash !== manifest.tableHashes[t]) throw new BackupError("corrupt", name);
    }
    let rawRows: unknown;
    try {
      rawRows = JSON.parse(strFromU8(data));
    } catch {
      throw new BackupError("bad_json", name);
    }
    if (!Array.isArray(rawRows)) throw new BackupError("bad_json", name);
    if (typeof manifest.counts?.[t] === "number" && manifest.counts[t] !== rawRows.length) {
      throw new BackupError("bad_manifest", `${t} count mismatch`);
    }

    const schema = TABLE_SCHEMAS[t];
    const parsedRows: Row[] = [];
    for (let i = 0; i < rawRows.length; i++) {
      const row = rawRows[i];
      if (!row || typeof row !== "object" || Array.isArray(row)) throw new BackupError("bad_record", `${t}[${i}]`);
      if (schema) {
        const r = schema.safeParse(row);
        if (!r.success) throw new BackupError("bad_record", `${t}[${i}]: ${r.error.issues[0]?.path.join(".")}`);
        parsedRows.push(r.data as Row);
      } else {
        parsedRows.push(row as Row);
      }
    }
    tables[t] = parsedRows;
  }

  validateParsed({ manifest, tables, blobs });
  return { manifest, tables, blobs };
}

// ----------------------------------------------------------- Validation

const RELATIONS: [TableName, string, TableName, boolean][] = [
  ["subjects", "semesterId", "semesters", false],
  ["lectures", "subjectId", "subjects", true],
  ["notes", "subjectId", "subjects", false],
  ["notes", "lectureId", "lectures", false],
  ["noteVersions", "noteId", "notes", true],
  ["attachments", "subjectId", "subjects", false],
  ["attachments", "lectureId", "lectures", false],
  ["attachments", "noteId", "notes", false],
  ["pdfDocuments", "id", "attachments", true],
  ["bookmarks", "attachmentId", "attachments", true],
  ["highlights", "attachmentId", "attachments", true],
  ["annotations", "attachmentId", "attachments", true],
  ["flashcardDecks", "subjectId", "subjects", false],
  ["flashcards", "deckId", "flashcardDecks", true],
  ["flashcards", "subjectId", "subjects", false],
  ["flashcards", "imageId", "attachments", false],
  ["reviewLogs", "cardId", "flashcards", true],
  ["quizzes", "subjectId", "subjects", false],
  ["quizzes", "semesterId", "semesters", false],
  ["quizQuestions", "quizId", "quizzes", true],
  ["quizAttempts", "quizId", "quizzes", true],
  ["quizQuestions", "imageId", "attachments", false],
  ["references", "subjectId", "subjects", false],
  ["noteTags", "noteId", "notes", true],
  ["noteTags", "tagId", "tags", true],
  ["events", "subjectId", "subjects", false],
];

function validateParsed(p: ParsedBackup, existing?: Partial<Record<TableName, Set<string>>>) {
  const ids: Partial<Record<TableName, Set<string>>> = {};
  for (const name of EXPORT_TABLES) {
    const rows = p.tables[name] ?? [];
    const set = new Set<string>();
    const schema = TABLE_SCHEMAS[name];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r || typeof r !== "object" || Array.isArray(r)) throw new BackupError("bad_record", name);
      if (schema) {
        const res = schema.safeParse(r);
        if (!res.success) throw new BackupError("bad_record", `${name}[${i}]`);
      }
      const key = name === "appSettings" ? r.key : r.id;
      if (typeof key !== "string" || (name !== "appSettings" && !ID_RE.test(key))) {
        throw new BackupError("bad_record", `${name}: id`);
      }
      if (set.has(key)) throw new BackupError("bad_record", `${name}: duplicate id`);
      set.add(key);
    }
    ids[name] = set;
  }

  const exists = (t: TableName, id: unknown) => typeof id === "string" && (ids[t]?.has(id) || existing?.[t]?.has(id));
  for (const [t, field, target, required] of RELATIONS) {
    for (const r of p.tables[t] ?? []) {
      const v = r[field];
      if (v === undefined || v === null) {
        if (required) throw new BackupError("relation", `${t}.${field}`);
        continue;
      }
      if (!exists(target, v)) throw new BackupError("relation", `${t}.${field} → ${target}`);
    }
  }

  for (const a of p.tables.attachments ?? []) {
    const bid = a.blobId as string;
    if (!ID_RE.test(bid)) throw new BackupError("relation", "attachments.blobId");
    if (!p.blobs.has(bid) && !existing?.blobs?.has(bid)) throw new BackupError("relation", "attachments.blobId → blobs");
  }
}

export interface BackupPreview {
  createdAt: number;
  counts: { label: string; n: number }[];
  blobs: number;
}

export function previewBackup(p: ParsedBackup): BackupPreview {
  const keys: TableName[] = ["subjects", "lectures", "notes", "attachments", "flashcards", "quizzes", "references", "semesters"];
  return {
    createdAt: p.manifest.createdAt,
    counts: keys.map((k) => ({ label: k, n: p.tables[k]?.length ?? 0 })),
    blobs: p.blobs.size,
  };
}

// ------------------------------------------------------------------ Apply

async function sanitizeRows(p: ParsedBackup): Promise<Map<string, Blob>> {
  for (const s of p.tables.subjects ?? []) {
    s.color = safeCssColor(s.color);
    const cleanCover = safeDataImageUrl(s.cover);
    if (cleanCover) s.cover = cleanCover;
    else delete s.cover;
  }
  for (const h of p.tables.highlights ?? []) {
    h.color = safeHexColor(h.color, "#fde047");
  }
  for (const r of p.tables.references ?? []) {
    if (typeof r.url === "string" && r.url.trim()) {
      r.url = safeUrl(r.url) ?? "";
    }
  }
  for (const n of p.tables.notes ?? []) {
    const doc = sanitizeDoc(n.content);
    n.content = doc;
    n.text = plainFromDoc(doc);
    n.wordCount = wordCount(n.text as string);
  }
  for (const v of p.tables.noteVersions ?? []) {
    const doc = sanitizeDoc(v.content);
    v.content = doc;
    v.text = plainFromDoc(doc);
  }
  for (const a of p.tables.attachments ?? []) {
    a.name = sanitizeFileName(String(a.name));
    const cleanThumb = safeDataImageUrl(a.thumb, 500_000);
    if (cleanThumb) a.thumb = cleanThumb;
    else delete a.thumb;
  }

  // Verify every referenced blob outside the Dexie transaction (magic bytes, anti-bomb structure, SHA-256 hash)
  const blobs = new Map<string, Blob>();
  const firstAtt = new Map<string, Row>();
  for (const a of p.tables.attachments ?? []) {
    if (!firstAtt.has(a.blobId as string)) firstAtt.set(a.blobId as string, a);
  }
  for (const [id, rawBlob] of p.blobs) {
    const att = firstAtt.get(id);
    if (!att) continue; // unreferenced blob: dropped
    const blobObj = rawBlob instanceof Blob ? rawBlob : new Blob([rawBlob as BlobPart]);
    const file = new File([blobObj], String(att.name));
    const v = await validateFile(file, Number.MAX_SAFE_INTEGER);
    if (!v.ok || v.kind !== att.kind) throw new BackupError("bad_blob", String(att.name));
    const h = String(att.hash ?? "");
    if (h && !h.startsWith("size-")) {
      const actual = await sha256(file);
      if (actual !== h) throw new BackupError("corrupt", String(att.name));
    }
    blobs.set(id, new Blob([blobObj], { type: v.mime }));
  }
  return blobs;
}

async function bulkAddBatched(tableName: TableName, rows: Row[]) {
  const table = db.table(tableName);
  for (let i = 0; i < rows.length; i += DB_BATCH_SIZE) {
    await table.bulkAdd(rows.slice(i, i + DB_BATCH_SIZE));
  }
}

export type ImportMode = "replace" | "merge";

export async function applyBackup(p: ParsedBackup, mode: ImportMode): Promise<void> {
  if (mode === "merge") {
    const existing: Partial<Record<TableName, Set<string>>> = {};
    for (const t of EXPORT_TABLES) existing[t] = new Set((await db.table(t).toCollection().primaryKeys()) as string[]);
    existing.blobs = new Set((await db.blobs.toCollection().primaryKeys()) as string[]);
    validateParsed(p, existing);
  } else {
    validateParsed(p);
  }

  const blobs = await sanitizeRows(p);
  try {
    await db.transaction("rw", db.tables, async () => {
      if (mode === "replace") {
        for (const t of db.tables) await t.clear();
        for (const name of EXPORT_TABLES) {
          const rows = p.tables[name];
          if (rows?.length) await bulkAddBatched(name, rows);
        }
        if (blobs.size) {
          const entries = Array.from(blobs, ([id, blob]) => ({ id, blob }));
          for (let i = 0; i < entries.length; i += BLOB_BATCH_SIZE) {
            await db.blobs.bulkAdd(entries.slice(i, i + BLOB_BATCH_SIZE));
          }
        }
        return;
      }

      // ---- merge: newer updatedAt wins; records without timestamps are added only when missing
      const tagMap = new Map<string, string>();
      for (const t of p.tables.tags ?? []) {
        const same = await db.tags.where("name").equals(t.name as string).first();
        if (same) tagMap.set(t.id as string, same.id);
      }
      for (const name of EXPORT_TABLES) {
        let rows = p.tables[name] ?? [];
        if (name === "tags") rows = rows.filter((r) => !tagMap.has(r.id as string));
        if (name === "noteTags") {
          const out: Row[] = [];
          for (const r of rows) {
            const tagId = tagMap.get(r.tagId as string) ?? (r.tagId as string);
            const dup = await db.noteTags.where("[noteId+tagId]").equals([r.noteId as string, tagId]).first();
            if (!dup) out.push({ ...r, tagId });
          }
          rows = out;
        }
        if (!rows.length) continue;
        const table = db.table(name);
        const keyOf = (r: Row) => (name === "appSettings" ? (r.key as string) : (r.id as string));
        const cur = await table.bulkGet(rows.map(keyOf));
        const put: Row[] = [];
        rows.forEach((r, i) => {
          const c = cur[i] as Row | undefined;
          if (!c) put.push(r);
          else if (typeof r.updatedAt === "number" && typeof c.updatedAt === "number" && r.updatedAt > c.updatedAt) put.push(r);
        });
        for (let i = 0; i < put.length; i += DB_BATCH_SIZE) {
          await table.bulkPut(put.slice(i, i + DB_BATCH_SIZE));
        }
      }
      for (const [id, blob] of blobs) {
        if (!(await db.blobs.get(id))) await db.blobs.add({ id, blob });
      }
    });
  } catch (e) {
    throw new BackupError("apply_failed", e instanceof Error ? e.message : String(e));
  }
  await rebuildIndex();
  await logActivity("restore", mode, "backup");
}

export { isUuid };
