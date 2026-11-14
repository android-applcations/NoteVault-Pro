// Application services – notes, versions, auto-save controller.
import type { JSONContent } from "@tiptap/core";
import { db } from "@/data/db";
import type { Note, NoteVersion } from "@/data/types";
import { sanitizeDoc } from "@/domain/sanitize";
import { buildTemplateDoc, docFromText, TEMPLATES } from "@/domain/templates";
import { hashString, plainFromDoc, wordCount } from "@/domain/text";
import { getSetting, logActivity, uid } from "./core";
import { reindex } from "./search";

export const VERSION_INTERVAL_MS = 5 * 60 * 1000;
export const DEFAULT_MAX_VERSIONS = 30;

export interface NewNoteInput {
  subjectId?: string;
  lectureId?: string;
  title?: string;
  content?: JSONContent | null;
  kind?: "note" | "quick";
  templateId?: string;
  lang?: "ar" | "en";
  pinned?: boolean;
}

export async function createNote(input: NewNoteInput = {}): Promise<Note> {
  let content = input.content ?? null;
  let title = input.title ?? "";
  if (input.templateId) {
    const tpl = TEMPLATES.find((t) => t.id === input.templateId);
    if (tpl) {
      content = buildTemplateDoc(tpl, input.lang ?? "ar");
      if (!title) title = tpl.title[input.lang ?? "ar"];
    }
  }
  if (content) content = sanitizeDoc(content);
  const text = plainFromDoc(content);
  const t = Date.now();
  let subjectId = input.subjectId;
  if (input.lectureId) {
    const l = await db.lectures.get(input.lectureId);
    if (!l) throw new Error("NOT_FOUND");
    subjectId = l.subjectId;
  }
  const n: Note = {
    id: uid(), subjectId, lectureId: input.lectureId, title, content, text, wordCount: wordCount(text),
    kind: input.kind ?? "note", pinned: input.pinned ?? false, favorite: false, archived: false, createdAt: t, updatedAt: t,
  };
  await db.notes.add(n);
  await reindex("note", n.id);
  await logActivity("create", title || (input.kind === "quick" ? "Quick note" : "Untitled"), "note", n.id);
  return n;
}

export async function createQuickNote(text: string, opts: { subjectId?: string; asTask?: boolean; tags?: string[]; pinned?: boolean }): Promise<Note> {
  const clean = text.trim();
  if (!clean) throw new Error("EMPTY");
  const first = clean.split("\n")[0].slice(0, 60);
  const n = await createNote({ kind: "quick", title: first, content: docFromText(clean, opts.asTask), subjectId: opts.subjectId, pinned: opts.pinned });
  if (opts.tags?.length) {
    const { setNoteTags } = await import("./library");
    await setNoteTags(n.id, opts.tags);
  }
  return n;
}

export async function updateNoteMeta(id: string, patch: Partial<Pick<Note, "subjectId" | "lectureId" | "pinned" | "favorite" | "archived" | "kind" | "title">>) {
  const p: Partial<Note> = { ...patch, updatedAt: Date.now() };
  if (patch.lectureId) {
    const l = await db.lectures.get(patch.lectureId);
    if (l) p.subjectId = l.subjectId;
  }
  if (patch.subjectId === undefined && "subjectId" in patch) p.lectureId = undefined;
  await db.notes.update(id, p);
  await reindex("note", id);
}

export async function duplicateNote(id: string): Promise<Note> {
  const n = await db.notes.get(id);
  if (!n) throw new Error("NOT_FOUND");
  const t = Date.now();
  const c: Note = { ...n, id: uid(), title: (n.title || "") + " (copy)", pinned: false, createdAt: t, updatedAt: t };
  await db.notes.add(c);
  await reindex("note", c.id);
  return c;
}

export interface SaveResult {
  versionCreated: boolean;
  updatedAt: number;
}

/** Persists title + content in one transaction; creates a history version when due. */
export async function saveNoteContent(id: string, data: { title: string; content: JSONContent }, opts: { forceVersion?: boolean; label?: string } = {}): Promise<SaveResult> {
  const text = plainFromDoc(data.content);
  const hash = hashString(data.title + "\u0000" + JSON.stringify(data.content));
  const maxVersions = await getSetting<number>("maxVersions", DEFAULT_MAX_VERSIONS);
  const updatedAt = Date.now();
  let versionCreated = false;
  await db.transaction("rw", [db.notes, db.noteVersions], async () => {
    const note = await db.notes.get(id);
    if (!note) throw new Error("NOT_FOUND");
    await db.notes.update(id, { title: data.title, content: data.content, text, wordCount: wordCount(text), updatedAt });
    const last = await db.noteVersions.where("noteId").equals(id).sortBy("createdAt").then((v) => v[v.length - 1]);
    const due = !last || (last.hash !== hash && (opts.forceVersion || updatedAt - last.createdAt >= VERSION_INTERVAL_MS));
    if (due && (!last || last.hash !== hash) && (text.length > 0 || data.title)) {
      const v: NoteVersion = { id: uid(), noteId: id, title: data.title, content: data.content, text, hash, label: opts.label, createdAt: updatedAt };
      await db.noteVersions.add(v);
      versionCreated = true;
      const all = await db.noteVersions.where("noteId").equals(id).sortBy("createdAt");
      const extra = all.length - Math.max(1, maxVersions);
      if (extra > 0) await db.noteVersions.bulkDelete(all.slice(0, extra).map((x) => x.id));
    }
  });
  await reindex("note", id);
  return { versionCreated, updatedAt };
}

export async function getVersions(noteId: string): Promise<NoteVersion[]> {
  const v = await db.noteVersions.where("noteId").equals(noteId).sortBy("createdAt");
  return v.reverse();
}

export async function restoreVersion(noteId: string, versionId: string): Promise<JSONContent> {
  const v = await db.noteVersions.get(versionId);
  if (!v || v.noteId !== noteId) throw new Error("NOT_FOUND");
  const doc = sanitizeDoc(v.content) ?? { type: "doc", content: [{ type: "paragraph" }] };
  const cur = await db.notes.get(noteId);
  if (cur?.content) await saveNoteContent(noteId, { title: cur.title, content: cur.content }, { forceVersion: true, label: "before-restore" });
  await saveNoteContent(noteId, { title: v.title, content: doc }, { forceVersion: true, label: "restored" });
  return doc;
}

export async function deleteVersion(id: string) {
  await db.noteVersions.delete(id);
}

// ------------------------------------------------------------ Auto-save
export type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";

type Payload = { title: string; content: JSONContent };
type PayloadSource = Payload | (() => Payload);

/** Debounced, serialised auto-saver. A pending payload is never dropped on failure. */
export class AutoSaver {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: Payload | null = null;
  private running: Promise<void> | null = null;
  private disposed = false;
  private getter: (() => Payload) | null = null;
  lastError: string | null = null;

  constructor(
    private noteId: string,
    private onStatus: (s: SaveStatus, err?: string) => void,
    private delay = 500,
    private save: typeof saveNoteContent = saveNoteContent
  ) {}

  /** Accepts a payload or a getter; a getter is resolved at flush time so title and content are always current. */
  schedule(source: PayloadSource) {
    if (this.disposed) return;
    this.pending = typeof source === "function" ? source() : source;
    this.getter = typeof source === "function" ? source : null;
    this.onStatus("dirty");
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.delay);
  }

  hasPending() {
    return this.pending !== null;
  }

  async flush(forceVersion = false): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.running) {
      await this.running;
    }
    if (!this.pending) return;
    const payload = this.getter ? this.getter() : this.pending;
    this.pending = null;
    this.onStatus("saving");
    this.running = (async () => {
      try {
        await this.save(this.noteId, payload, { forceVersion });
        this.lastError = null;
        if (!this.pending) this.onStatus("saved");
      } catch (e) {
        if (!this.pending) this.pending = payload; // keep for retry
        this.lastError = e instanceof Error ? e.message : String(e);
        this.onStatus("error", this.lastError);
      } finally {
        this.running = null;
      }
    })();
    await this.running;
    if (this.pending && !this.lastError && !this.disposed) await this.flush();
  }

  async dispose() {
    this.disposed = true;
    await this.flush();
  }
}
