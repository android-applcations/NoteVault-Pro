// Application services – semesters, subjects, lectures, calendar events and tags.
import { db } from "@/data/db";
import type { CalEvent, Lecture, ReviewStatus, Semester, Subject } from "@/data/types";
import { todayISO } from "@/domain/text";
import { logActivity, uid } from "./core";
import { reindex } from "./search";

const SUBJECT_COLORS = ["#4f46e5", "#0ea5a4", "#e11d48", "#d97706", "#7c3aed", "#059669", "#2563eb", "#db2777"];
export const subjectColors = SUBJECT_COLORS;

// ------------------------------------------------------------- Semesters
export async function createSemester(data: Pick<Semester, "name" | "startDate" | "endDate">): Promise<Semester> {
  const t = Date.now();
  const s: Semester = { id: uid(), ...data, name: data.name.trim(), archived: false, createdAt: t, updatedAt: t };
  if (!s.name) throw new Error("NAME_REQUIRED");
  if (s.startDate && s.endDate && s.endDate < s.startDate) throw new Error("BAD_DATES");
  await db.semesters.add(s);
  await logActivity("create", s.name, "semester", s.id);
  return s;
}
export async function updateSemester(id: string, patch: Partial<Pick<Semester, "name" | "startDate" | "endDate" | "archived">>) {
  if (patch.startDate && patch.endDate && patch.endDate < patch.startDate) throw new Error("BAD_DATES");
  await db.semesters.update(id, { ...patch, updatedAt: Date.now() });
}
export async function deleteSemester(id: string) {
  await db.transaction("rw", [db.semesters, db.subjects, db.quizzes], async () => {
    await db.subjects.where("semesterId").equals(id).modify({ semesterId: undefined, updatedAt: Date.now() });
    await db.quizzes.where("semesterId").equals(id).modify({ semesterId: undefined });
    await db.semesters.delete(id);
  });
}

// -------------------------------------------------------------- Subjects
export type SubjectInput = Partial<Omit<Subject, "id" | "createdAt" | "updatedAt">> & { name: string };

export async function createSubject(data: SubjectInput): Promise<Subject> {
  const name = data.name.trim();
  if (!name) throw new Error("NAME_REQUIRED");
  const t = Date.now();
  const count = await db.subjects.count();
  const s: Subject = {
    id: uid(), name, code: data.code?.trim() ?? "", description: data.description?.trim() ?? "",
    color: data.color ?? SUBJECT_COLORS[count % SUBJECT_COLORS.length], cover: data.cover, teacher: data.teacher?.trim() ?? "",
    credits: data.credits, semesterId: data.semesterId, archived: false, weeks: [], createdAt: t, updatedAt: t,
  };
  await db.subjects.add(s);
  await reindex("subject", s.id);
  await logActivity("create", name, "subject", s.id);
  return s;
}
export async function updateSubject(id: string, patch: Partial<Omit<Subject, "id" | "createdAt">>) {
  if (patch.name !== undefined && !patch.name.trim()) throw new Error("NAME_REQUIRED");
  await db.subjects.update(id, { ...patch, updatedAt: Date.now() });
  await reindex("subject", id);
}
export async function addWeek(subjectId: string, label?: string): Promise<number> {
  return db.transaction("rw", [db.subjects, db.lectures], async () => {
    const s = await db.subjects.get(subjectId);
    if (!s) throw new Error("NOT_FOUND");
    const lecs = await db.lectures.where("subjectId").equals(subjectId).toArray();
    const max = Math.max(0, ...s.weeks.map((w) => w.n), ...lecs.map((l) => l.week));
    const n = max + 1;
    await db.subjects.update(subjectId, { weeks: [...s.weeks, { n, label: label?.trim() || undefined }], updatedAt: Date.now() });
    return n;
  });
}
export async function renameWeek(subjectId: string, n: number, label: string) {
  const s = await db.subjects.get(subjectId);
  if (!s) return;
  const weeks = s.weeks.filter((w) => w.n !== n);
  weeks.push({ n, label: label.trim() || undefined });
  weeks.sort((a, b) => a.n - b.n);
  await db.subjects.update(subjectId, { weeks, updatedAt: Date.now() });
}

export interface SubjectStats {
  lectures: number;
  notes: number;
  files: number;
  cards: number;
  lastActivity: number;
  completion: number;
}
export async function getSubjectStats(id: string): Promise<SubjectStats> {
  const [lecs, notes, files, cards] = await Promise.all([
    db.lectures.where("subjectId").equals(id).filter((l) => !l.deletedAt && !l.archived).toArray(),
    db.notes.where("subjectId").equals(id).filter((n) => !n.deletedAt).toArray(),
    db.attachments.where("subjectId").equals(id).filter((a) => !a.deletedAt).toArray(),
    db.flashcards.where("subjectId").equals(id).count(),
  ]);
  const last = Math.max(0, ...lecs.map((l) => l.updatedAt), ...notes.map((n) => n.updatedAt), ...files.map((f) => f.createdAt));
  const completion = lecs.length ? Math.round(lecs.reduce((s, l) => s + l.progress, 0) / lecs.length) : 0;
  return { lectures: lecs.length, notes: notes.length, files: files.length, cards, lastActivity: last, completion };
}

// -------------------------------------------------------------- Lectures
export type LectureInput = Partial<Omit<Lecture, "id" | "createdAt" | "updatedAt">> & { subjectId: string; title: string };

export async function createLecture(data: LectureInput): Promise<Lecture> {
  const title = data.title.trim();
  if (!title) throw new Error("NAME_REQUIRED");
  const subj = await db.subjects.get(data.subjectId);
  if (!subj || subj.deletedAt) throw new Error("NOT_FOUND");
  const t = Date.now();
  const week = Math.max(1, Math.min(999, Math.round(data.week ?? 1) || 1));
  const progress = Math.max(0, Math.min(100, Math.round(data.progress ?? 0) || 0));
  const l: Lecture = {
    id: uid(), subjectId: data.subjectId, title, week, date: data.date || todayISO(),
    description: data.description?.trim() ?? "", keywords: (data.keywords ?? []).map((k) => k.trim()).filter(Boolean), reviewStatus: data.reviewStatus ?? "new",
    progress, archived: false, createdAt: t, updatedAt: t,
  };
  await db.lectures.add(l);
  await reindex("lecture", l.id);
  await logActivity("create", title, "lecture", l.id);
  return l;
}
export async function updateLecture(id: string, patch: Partial<Omit<Lecture, "id" | "createdAt">>): Promise<Lecture> {
  const cur = await db.lectures.get(id);
  if (!cur || cur.deletedAt) throw new Error("NOT_FOUND");
  const nextPatch = { ...patch };
  if (nextPatch.title !== undefined) {
    nextPatch.title = nextPatch.title.trim();
    if (!nextPatch.title) throw new Error("NAME_REQUIRED");
  }
  if (nextPatch.subjectId !== undefined) {
    const subj = await db.subjects.get(nextPatch.subjectId);
    if (!subj || subj.deletedAt) throw new Error("NOT_FOUND");
  }
  if (nextPatch.week !== undefined) nextPatch.week = Math.max(1, Math.min(999, Math.round(nextPatch.week) || 1));
  if (nextPatch.progress !== undefined) nextPatch.progress = Math.max(0, Math.min(100, Math.round(nextPatch.progress)));
  if (nextPatch.description !== undefined) nextPatch.description = nextPatch.description.trim();
  if (nextPatch.keywords !== undefined) nextPatch.keywords = nextPatch.keywords.map((k) => k.trim()).filter(Boolean);
  const updatedAt = Date.now();
  await db.lectures.update(id, { ...nextPatch, updatedAt });
  await reindex("lecture", id);
  return { ...cur, ...nextPatch, updatedAt };
}
export async function setReviewStatus(id: string, status: ReviewStatus) {
  await updateLecture(id, { reviewStatus: status, ...(status === "mastered" ? { progress: 100 } : {}) });
}
export async function moveLecture(id: string, week: number) {
  await updateLecture(id, { week });
}
/** Duplicates a lecture with its notes; attachments share the same stored blobs (no duplicate storage). */
export async function duplicateLecture(id: string): Promise<Lecture> {
  const src = await db.lectures.get(id);
  if (!src) throw new Error("NOT_FOUND");
  const t = Date.now();
  const copy: Lecture = { ...src, id: uid(), title: src.title + " (copy)", createdAt: t, updatedAt: t };
  const newNotes: string[] = [];
  const newAtts: string[] = [];
  await db.transaction("rw", [db.lectures, db.notes, db.attachments], async () => {
    await db.lectures.add(copy);
    for (const n of await db.notes.where("lectureId").equals(id).filter((x) => !x.deletedAt).toArray()) {
      const nn = { ...n, id: uid(), lectureId: copy.id, createdAt: t, updatedAt: t, pinned: false };
      await db.notes.add(nn);
      newNotes.push(nn.id);
    }
    for (const a of await db.attachments.where("lectureId").equals(id).filter((x) => !x.deletedAt && !x.noteId).toArray()) {
      const na = { ...a, id: uid(), lectureId: copy.id, createdAt: t, updatedAt: t };
      await db.attachments.add(na);
      newAtts.push(na.id);
    }
  });
  await reindex("lecture", copy.id);
  for (const n of newNotes) await reindex("note", n);
  for (const a of newAtts) await reindex("attachment", a);
  await logActivity("create", copy.title, "lecture", copy.id);
  return copy;
}

// ---------------------------------------------------------------- Events
export async function createEvent(data: Pick<CalEvent, "title" | "date" | "type" | "subjectId">) {
  if (!data.title.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) throw new Error("INVALID");
  const t = Date.now();
  const e: CalEvent = { id: uid(), ...data, title: data.title.trim(), createdAt: t, updatedAt: t };
  await db.events.add(e);
  await logActivity("create", e.title, "event", e.id);
  return e;
}
export const deleteEvent = (id: string) => db.events.delete(id);

// ------------------------------------------------------------------ Tags
export async function setNoteTags(noteId: string, names: string[]) {
  const clean = Array.from(new Set(names.map((n) => n.trim().replace(/^#/, "").slice(0, 40)).filter(Boolean)));
  await db.transaction("rw", [db.tags, db.noteTags], async () => {
    const tagIds: string[] = [];
    for (const name of clean) {
      let tag = await db.tags.where("name").equals(name).first();
      if (!tag) {
        tag = { id: uid(), name, createdAt: Date.now() };
        await db.tags.add(tag);
      }
      tagIds.push(tag.id);
    }
    await db.noteTags.where("noteId").equals(noteId).delete();
    await db.noteTags.bulkAdd(tagIds.map((tagId) => ({ id: uid(), noteId, tagId })));
  });
  await reindex("note", noteId);
}
export async function getNoteTagNames(noteId: string): Promise<string[]> {
  const links = await db.noteTags.where("noteId").equals(noteId).toArray();
  const tags = await db.tags.bulkGet(links.map((l) => l.tagId));
  return tags.filter(Boolean).map((t) => t!.name);
}
