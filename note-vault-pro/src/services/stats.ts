// Application services – dashboard and calendar aggregates (always computed from the real database).
import { db } from "@/data/db";
import type { Activity, Attachment, Note, Subject } from "@/data/types";

export interface Dashboard {
  subjects: number;
  lectures: number;
  notes: number;
  files: number;
  cards: number;
  due: number;
  sessions: number;
  recentNotes: Note[];
  recentFiles: Attachment[];
  recentActivities: Activity[];
  topSubjects: { subject: Subject; score: number }[];
  coverage: number;
  reviewProgress: number;
  storageBytes: number;
}

export async function getDashboard(): Promise<Dashboard> {
  const now = Date.now();
  const [subjects, lectures, notes, files, cards, logs, acts] = await Promise.all([
    db.subjects.filter((s) => !s.deletedAt && !s.archived).toArray(),
    db.lectures.filter((l) => !l.deletedAt && !l.archived).toArray(),
    db.notes.filter((n) => !n.deletedAt).toArray(),
    db.attachments.filter((a) => !a.deletedAt).toArray(),
    db.flashcards.toArray(),
    db.reviewLogs.orderBy("reviewedAt").keys(),
    db.activities.orderBy("createdAt").reverse().limit(12).toArray(),
  ]);
  const withNotes = new Set(notes.filter((n) => n.lectureId && n.text.trim()).map((n) => n.lectureId));
  const coverage = lectures.length ? Math.round((lectures.filter((l) => withNotes.has(l.id)).length / lectures.length) * 100) : 0;
  const reviewed = cards.filter((c) => c.reps > 0).length;
  const week = now - 14 * 86400000;
  const topSubjects = subjects
    .map((s) => ({
      subject: s,
      score:
        notes.filter((n) => n.subjectId === s.id && n.updatedAt > week).length +
        lectures.filter((l) => l.subjectId === s.id && l.updatedAt > week).length +
        files.filter((f) => f.subjectId === s.id && f.createdAt > week).length +
        cards.filter((c) => c.subjectId === s.id && (c.lastReview ?? 0) > week).length,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  let sessions = 0;
  (logs as number[]).forEach((t, i, arr) => {
    if (i === 0 || t - arr[i - 1] > 30 * 60000) sessions++;
  });
  return {
    subjects: subjects.length, lectures: lectures.length, notes: notes.length, files: files.length, cards: cards.length,
    due: cards.filter((c) => c.due <= now).length, sessions,
    recentNotes: notes.filter((n) => !n.archived).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6),
    recentFiles: files.sort((a, b) => b.createdAt - a.createdAt).slice(0, 6),
    recentActivities: acts, topSubjects, coverage,
    reviewProgress: cards.length ? Math.round((reviewed / cards.length) * 100) : 0,
    storageBytes: files.reduce((s, f) => s + f.size, 0),
  };
}

export interface CalendarItem {
  id: string;
  date: string;
  kind: "lecture" | "review" | "exam" | "note";
  label: string;
  color?: string;
  href?: string;
  count?: number;
}
const iso = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export async function getCalendarItems(fromISO: string, toISO: string): Promise<CalendarItem[]> {
  const [lectures, subjects, events, cards, notes] = await Promise.all([
    db.lectures.where("date").between(fromISO, toISO, true, true).filter((l) => !l.deletedAt).toArray(),
    db.subjects.toArray(),
    db.events.where("date").between(fromISO, toISO, true, true).toArray(),
    db.flashcards.toArray(),
    db.notes.filter((n) => !n.deletedAt && iso(n.updatedAt) >= fromISO && iso(n.updatedAt) <= toISO).toArray(),
  ]);
  const sMap = new Map(subjects.map((s) => [s.id, s]));
  const items: CalendarItem[] = [];
  for (const l of lectures) items.push({ id: "l" + l.id, date: l.date, kind: "lecture", label: l.title, color: sMap.get(l.subjectId)?.color, href: `/lectures/${l.id}` });
  for (const e of events) items.push({ id: "e" + e.id, date: e.date, kind: "exam", label: e.title, color: e.subjectId ? sMap.get(e.subjectId)?.color : undefined });
  const dueByDay = new Map<string, number>();
  for (const c of cards) {
    const day = iso(Math.max(c.due, c.state === 0 ? c.due : 0));
    if (day >= fromISO && day <= toISO) dueByDay.set(day, (dueByDay.get(day) ?? 0) + 1);
  }
  for (const [d, n] of dueByDay) items.push({ id: "r" + d, date: d, kind: "review", label: String(n), count: n, href: "/flashcards" });
  const noteByDay = new Map<string, number>();
  for (const n of notes) noteByDay.set(iso(n.updatedAt), (noteByDay.get(iso(n.updatedAt)) ?? 0) + 1);
  for (const [d, n] of noteByDay) items.push({ id: "n" + d, date: d, kind: "note", label: String(n), count: n, href: "/notes" });
  return items;
}
