// Application services – backup & restore (ZIP: manifest.json + data/*.json + blobs/<id>).
import { strFromU8, strToU8, unzip, zip, type AsyncZippable } from "fflate";
import { db, DATA_VERSION, TABLE_NAMES, type TableName } from "@/data/db";
import { sanitizeDoc, isUuid } from "@/domain/sanitize";
import { plainFromDoc, sanitizeFileName, wordCount } from "@/domain/text";
import { sha256, validateFile } from "@/files/validate";
import { logActivity } from "./core";
import { rebuildIndex } from "./search";

export const BACKUP_FORMAT = "notevault-backup";
export const BACKUP_VERSION = 1;
export const MAX_IMPORT_BYTES = 1.5 * 1024 ** 3;
const MAX_TOTAL_UNCOMPRESSED = 3 * 1024 ** 3;
const MAX_JSON_BYTES = 250 * 1024 ** 2;
const MAX_ENTRIES = 200_000;
const EXPORT_TABLES = TABLE_NAMES.filter((t) => t !== "blobs" && t !== "searchIndex");

export interface BackupManifest {
  format: string;
  formatVersion: number;
  dataVersion: number;
  app: string;
  createdAt: number;
  counts: Record<string, number>;
  blobs: number;
}

export type BackupErrorCode = "too_large" | "not_zip" | "bad_entry" | "no_manifest" | "bad_manifest" | "newer_version" | "bad_json" | "bad_record" | "relation" | "bad_blob" | "corrupt" | "apply_failed";
export class BackupError extends Error {
  constructor(public code: BackupErrorCode, public detail?: string) {
    super(code + (detail ? `: ${detail}` : ""));
  }
}

type Row = Record<string, unknown> & { id?: string; key?: string };
export interface ParsedBackup {
  manifest: BackupManifest;
  tables: Partial<Record<TableName, Row[]>>;
  blobs: Map<string, Uint8Array>;
}

function zipAsync(data: AsyncZippable): Promise<Uint8Array> {
  return new Promise((res, rej) => zip(data, (err, out) => (err ? rej(err) : res(out))));
}

export async function exportBackup(onProgress?: (msg: string) => void): Promise<Blob> {
  const files: AsyncZippable = {};
  const counts: Record<string, number> = {};
  for (const name of EXPORT_TABLES) {
    onProgress?.(name);
    const rows = await db.table(name).toArray();
    counts[name] = rows.length;
    files[`data/${name}.json`] = [strToU8(JSON.stringify(rows)), { level: 6 }];
  }
  let blobCount = 0;
  await db.blobs.each(async () => undefined);
  const blobRows = await db.blobs.toArray();
  for (const rec of blobRows) {
    files[`blobs/${rec.id}`] = [new Uint8Array(await rec.blob.arrayBuffer()), { level: 0 }];
    blobCount++;
  }
  counts.blobs = blobCount;
  const manifest: BackupManifest = { format: BACKUP_FORMAT, formatVersion: BACKUP_VERSION, dataVersion: DATA_VERSION, app: "NoteVault Pro", createdAt: Date.now(), counts, blobs: blobCount };
  files["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));
  const out = await zipAsync(files);
  await logActivity("backup", "Export", "backup");
  return new Blob([out as BlobPart], { type: "application/zip" });
}

export async function exportNotesText(): Promise<Blob> {
  const notes = await db.notes.filter((n) => !n.deletedAt).toArray();
  const files: AsyncZippable = {};
  const used = new Set<string>();
  for (const n of notes) {
    let base = sanitizeFileName((n.title || "note").replace(/\.+$/, "")) || "note";
    while (used.has(base.toLowerCase())) base += "-" + n.id.slice(0, 4);
    used.add(base.toLowerCase());
    files[`${base}.md`] = strToU8(`# ${n.title || ""}\n\n${n.text}\n`);
  }
  return new Blob([(await zipAsync(files)) as BlobPart], { type: "application/zip" });
}

// ------------------------------------------------------------------ Parse

const ENTRY_RE = /^(manifest\.json|data\/[A-Za-z]+\.json|blobs\/[A-Za-z0-9-]{1,64})$/;

export async function parseBackup(input: Blob | Uint8Array): Promise<ParsedBackup> {
  const size = input instanceof Blob ? input.size : input.byteLength;
  if (size > MAX_IMPORT_BYTES) throw new BackupError("too_large");
  const bytes = input instanceof Blob ? new Uint8Array(await input.arrayBuffer()) : input;
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new BackupError("not_zip");

  let bad: string | null = null;
  let total = 0;
  let entries = 0;
  const entriesOut = await new Promise<Record<string, Uint8Array>>((res, rej) => {
    unzip(
      bytes,
      {
        filter: (f) => {
          if (f.name.endsWith("/")) return false;
          entries++;
          total += f.originalSize;
          if (!ENTRY_RE.test(f.name) || entries > MAX_ENTRIES) {
            bad = f.name;
            return false;
          }
          if (total > MAX_TOTAL_UNCOMPRESSED || (f.name.endsWith(".json") && f.originalSize > MAX_JSON_BYTES)) {
            bad = "size";
            return false;
          }
          return true;
        },
      },
      (err, out) => (err ? rej(new BackupError("not_zip")) : res(out))
    );
  });
  if (bad) throw new BackupError(bad === "size" ? "too_large" : "bad_entry", bad);
  if (!entriesOut["manifest.json"]) throw new BackupError("no_manifest");
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(strFromU8(entriesOut["manifest.json"]));
  } catch {
    throw new BackupError("bad_manifest");
  }
  if (manifest?.format !== BACKUP_FORMAT || typeof manifest.formatVersion !== "number" || typeof manifest.dataVersion !== "number") throw new BackupError("bad_manifest");
  if (manifest.formatVersion > BACKUP_VERSION || manifest.dataVersion > DATA_VERSION) throw new BackupError("newer_version");

  const tables: ParsedBackup["tables"] = {};
  const blobs = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(entriesOut)) {
    if (name.startsWith("data/")) {
      const t = name.slice(5, -5) as TableName;
      if (!(EXPORT_TABLES as readonly string[]).includes(t)) throw new BackupError("bad_entry", name);
      let rows: unknown;
      try {
        rows = JSON.parse(strFromU8(data));
      } catch {
        throw new BackupError("bad_json", name);
      }
      if (!Array.isArray(rows)) throw new BackupError("bad_json", name);
      tables[t] = rows as Row[];
    } else if (name.startsWith("blobs/")) {
      blobs.set(name.slice(6), data);
    }
  }
  validateParsed({ manifest, tables, blobs });
  return { manifest, tables, blobs };
}

// ----------------------------------------------------------- Validation

const REQUIRED_STR: Partial<Record<TableName, string[]>> = {
  semesters: ["name"], subjects: ["name"], lectures: ["subjectId", "title"], notes: ["title"], noteVersions: ["noteId"],
  attachments: ["name", "blobId", "kind"], pdfDocuments: [], bookmarks: ["attachmentId"], highlights: ["attachmentId"], annotations: ["attachmentId"],
  flashcardDecks: ["name"], flashcards: ["deckId", "front"], reviewLogs: ["cardId"], quizzes: ["title"], quizQuestions: ["quizId", "prompt"],
  quizAttempts: ["quizId"], references: ["title"], tags: ["name"], noteTags: ["noteId", "tagId"], activities: ["kind"], trashItems: ["kind", "refId"],
  events: ["title", "date"],
};
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SETTINGS_KEYS = new Set(["prefs", "maxVersions", "keepOriginalImages", "recentSearches", "schemaVersion"]);

/** relation rules: [table, field, targetTable, required] */
const RELATIONS: [TableName, string, TableName, boolean][] = [
  ["subjects", "semesterId", "semesters", false],
  ["lectures", "subjectId", "subjects", true],
  ["notes", "subjectId", "subjects", false], ["notes", "lectureId", "lectures", false],
  ["noteVersions", "noteId", "notes", true],
  ["attachments", "subjectId", "subjects", false], ["attachments", "lectureId", "lectures", false], ["attachments", "noteId", "notes", false],
  ["pdfDocuments", "id", "attachments", true],
  ["bookmarks", "attachmentId", "attachments", true], ["highlights", "attachmentId", "attachments", true], ["annotations", "attachmentId", "attachments", true],
  ["flashcardDecks", "subjectId", "subjects", false],
  ["flashcards", "deckId", "flashcardDecks", true], ["flashcards", "subjectId", "subjects", false], ["flashcards", "imageId", "attachments", false],
  ["reviewLogs", "cardId", "flashcards", true],
  ["quizzes", "subjectId", "subjects", false], ["quizzes", "semesterId", "semesters", false],
  ["quizQuestions", "quizId", "quizzes", true], ["quizAttempts", "quizId", "quizzes", true], ["quizQuestions", "imageId", "attachments", false],
  ["references", "subjectId", "subjects", false],
  ["noteTags", "noteId", "notes", true], ["noteTags", "tagId", "tags", true],
  ["events", "subjectId", "subjects", false],
];

function validateParsed(p: ParsedBackup, existing?: Partial<Record<TableName, Set<string>>>) {
  const ids: Partial<Record<TableName, Set<string>>> = {};
  for (const name of EXPORT_TABLES) {
    const rows = p.tables[name] ?? [];
    const set = new Set<string>();
    for (const r of rows) {
      if (!r || typeof r !== "object" || Array.isArray(r)) throw new BackupError("bad_record", name);
      const key = name === "appSettings" ? r.key : r.id;
      if (typeof key !== "string" || !ID_RE.test(key) && name !== "appSettings") throw new BackupError("bad_record", `${name}: id`);
      if (name === "appSettings" && (typeof key !== "string" || !SETTINGS_KEYS.has(key))) throw new BackupError("bad_record", "appSettings: key");
      if (set.has(key)) throw new BackupError("bad_record", `${name}: duplicate id`);
      set.add(key);
      for (const f of REQUIRED_STR[name] ?? []) if (typeof r[f] !== "string") throw new BackupError("bad_record", `${name}.${f}`);
      for (const k of ["createdAt", "updatedAt", "deletedAt", "size"]) if (r[k] !== undefined && typeof r[k] !== "number") throw new BackupError("bad_record", `${name}.${k}`);
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
  // every attachment blob must be present in the bundle (or already stored for merges)
  for (const a of p.tables.attachments ?? []) {
    const bid = a.blobId as string;
    if (!ID_RE.test(bid)) throw new BackupError("relation", "attachments.blobId");
    if (!p.blobs.has(bid) && !existing?.blobs?.has(bid)) throw new BackupError("relation", `attachments.blobId → blobs`);
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

const DATA_IMG = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

async function sanitizeRows(p: ParsedBackup): Promise<Map<string, Blob>> {
  for (const s of p.tables.subjects ?? []) {
    if (s.cover !== undefined && !(typeof s.cover === "string" && s.cover.length < 3_000_000 && DATA_IMG.test(s.cover))) delete s.cover;
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
    if (a.thumb !== undefined && !(typeof a.thumb === "string" && DATA_IMG.test(a.thumb as string) || /^data:image\/jpeg;base64,/.test(String(a.thumb)))) delete a.thumb;
  }
  // verify each blob against the declared file type (magic bytes) and stored hash
  const blobs = new Map<string, Blob>();
  const firstAtt = new Map<string, Row>();
  for (const a of p.tables.attachments ?? []) if (!firstAtt.has(a.blobId as string)) firstAtt.set(a.blobId as string, a);
  for (const [id, bytes] of p.blobs) {
    const att = firstAtt.get(id);
    if (!att) continue; // unreferenced blob: dropped
    const file = new File([bytes as BlobPart], att.name as string);
    const v = await validateFile(file, Number.MAX_SAFE_INTEGER);
    if (!v.ok || v.kind !== att.kind) throw new BackupError("bad_blob", String(att.name));
    const h = String(att.hash ?? "");
    if (h && !h.startsWith("size-")) {
      const actual = await sha256(file);
      if (actual !== h) throw new BackupError("corrupt", String(att.name));
    }
    blobs.set(id, new Blob([bytes as BlobPart], { type: v.mime }));
  }
  return blobs;
}

export type ImportMode = "replace" | "merge";

export async function applyBackup(p: ParsedBackup, mode: ImportMode): Promise<void> {
  // For merge mode, re-validate relations against ids already present locally.
  if (mode === "merge") {
    const existing: Partial<Record<TableName, Set<string>>> = {};
    for (const t of EXPORT_TABLES) existing[t] = new Set((await db.table(t).toCollection().primaryKeys()) as string[]);
    existing.blobs = new Set((await db.blobs.toCollection().primaryKeys()) as string[]);
    validateParsed(p, existing);
  }
  const blobs = await sanitizeRows(p);
  try {
    await db.transaction("rw", db.tables, async () => {
      if (mode === "replace") {
        for (const t of db.tables) await t.clear();
        for (const name of EXPORT_TABLES) {
          const rows = p.tables[name];
          if (rows?.length) await db.table(name).bulkAdd(rows);
        }
        if (blobs.size) await db.blobs.bulkAdd(Array.from(blobs, ([id, blob]) => ({ id, blob })));
        return;
      }
      // ---- merge: newer updatedAt wins; records without timestamps are only added when missing
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
        if (put.length) await table.bulkPut(put);
      }
      for (const [id, blob] of blobs) if (!(await db.blobs.get(id))) await db.blobs.add({ id, blob });
    });
  } catch (e) {
    throw new BackupError("apply_failed", e instanceof Error ? e.message : String(e)); // transaction aborted → nothing changed
  }
  await rebuildIndex();
  await logActivity("restore", mode, "backup");
}

export { isUuid };
