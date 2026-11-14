import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, TABLE_NAMES } from "@/data/db";
import { createSubject, createLecture, duplicateLecture, setNoteTags } from "@/services/library";
import { AutoSaver, createNote, getVersions, restoreVersion, saveNoteContent } from "@/services/notes";
import { restoreTrash, softDelete, purgeTrash } from "@/services/core";
import { _resetSearchForTests, initSearch, search, reindex } from "@/services/search";
import { addFile } from "@/services/files";
import { applyBackup, BackupError, exportBackup, parseBackup } from "@/services/backup";
import { createCard, createDeck, getDueCards, reviewCard } from "@/services/cards";
import { createQuiz, blankQuestion, saveQuiz, submitAttempt, getQuestions } from "@/services/quizzes";
import { strToU8, zipSync } from "fflate";
import type { JSONContent } from "@tiptap/core";

const doc = (text: string): JSONContent => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

async function wipe() {
  for (const t of db.tables) await t.clear();
  _resetSearchForTests();
  await initSearch();
}
beforeEach(wipe);

describe("notes: save, autosave, versions", () => {
  it("auto-saves after debounce and persists to IndexedDB", async () => {
    const n = await createNote({ title: "t" });
    const statuses: string[] = [];
    const saver = new AutoSaver(n.id, (s) => statuses.push(s), 60);
    saver.schedule({ title: "t", content: doc("hello") });
    saver.schedule({ title: "t", content: doc("hello world") });
    expect((await db.notes.get(n.id))!.text).toBe("");
    await new Promise((r) => setTimeout(r, 300));
    await saver.flush();
    expect((await db.notes.get(n.id))!.text).toBe("hello world");
    expect(statuses).toContain("dirty");
    expect(statuses).toContain("saving");
    expect(statuses[statuses.length - 1]).toBe("saved");
  });

  it("reports failure and keeps the pending payload for retry", async () => {
    let fail = true;
    const save = vi.fn(async (...a: Parameters<typeof saveNoteContent>) => {
      if (fail) throw new Error("db down");
      return saveNoteContent(...a);
    });
    const n = await createNote({ title: "x" });
    const statuses: string[] = [];
    const s = new AutoSaver(n.id, (st) => statuses.push(st), 10, save);
    s.schedule({ title: "x", content: doc("keep me") });
    await s.flush();
    expect(statuses[statuses.length - 1]).toBe("error");
    expect(s.hasPending()).toBe(true);
    fail = false;
    await s.flush();
    expect(statuses[statuses.length - 1]).toBe("saved");
    expect((await db.notes.get(n.id))!.text).toBe("keep me");
  });

  it("creates versions without duplicates and restores an older one", async () => {
    const n = await createNote({ title: "v" });
    await saveNoteContent(n.id, { title: "v", content: doc("one") });
    await saveNoteContent(n.id, { title: "v", content: doc("one") }, { forceVersion: true }); // identical → no new version
    await saveNoteContent(n.id, { title: "v", content: doc("two") }, { forceVersion: true });
    let vs = await getVersions(n.id);
    expect(vs.length).toBe(2);
    const first = vs[vs.length - 1];
    await restoreVersion(n.id, first.id);
    expect((await db.notes.get(n.id))!.text).toBe("one");
    vs = await getVersions(n.id);
    expect(vs.length).toBeGreaterThanOrEqual(3);
  });

  it("honours the versions limit", async () => {
    await db.appSettings.put({ key: "maxVersions", value: 3 });
    const n = await createNote({ title: "v" });
    for (let i = 0; i < 6; i++) await saveNoteContent(n.id, { title: "v", content: doc("text " + i) }, { forceVersion: true });
    expect((await getVersions(n.id)).length).toBe(3);
  });
});

describe("subjects, lectures, trash", () => {
  it("cascades soft delete, restores, and purges without orphans", async () => {
    const s = await createSubject({ name: "Biology" });
    const l = await createLecture({ subjectId: s.id, title: "Cells", week: 1 });
    const n = await createNote({ lectureId: l.id, title: "cell note", content: doc("mitochondria") });
    const f = await addFile(new File([strToU8("plain text file")], "a.txt"), { lectureId: l.id });
    expect(f.ok).toBe(true);
    expect(n.subjectId).toBe(s.id);

    const trashId = await softDelete("subject", s.id);
    expect((await db.notes.get(n.id))!.deletedAt).toBeTruthy();
    expect((await search("mitochondria")).length).toBe(0);
    await restoreTrash(trashId);
    expect((await db.notes.get(n.id))!.deletedAt).toBeUndefined();
    expect((await search("mitochondria")).length).toBe(1);

    const t2 = await softDelete("lecture", l.id);
    await purgeTrash(t2);
    expect(await db.lectures.count()).toBe(0);
    expect(await db.notes.count()).toBe(0);
    expect(await db.attachments.count()).toBe(0);
    expect(await db.blobs.count()).toBe(0);
    expect(await db.noteVersions.count()).toBe(0);
  });

  it("duplicates a lecture sharing blobs", async () => {
    const s = await createSubject({ name: "S" });
    const l = await createLecture({ subjectId: s.id, title: "L" });
    await addFile(new File([strToU8("shared")], "s.txt"), { lectureId: l.id });
    await duplicateLecture(l.id);
    expect(await db.attachments.count()).toBe(2);
    expect(await db.blobs.count()).toBe(1);
  });
});

describe("search", () => {
  it("finds Arabic (diacritics/variants), English, partial and phrase; follows edits and deletes", async () => {
    const a = await createNote({ title: "الأحياء", content: doc("الخَلِيَّةُ هي وحدة البناء الأساسية للكائنات الحية") });
    const b = await createNote({ title: "Physics", content: doc("Newton's second law relates force and acceleration") });
    expect((await search("الخلية")).map((h) => h.doc.refId)).toContain(a.id);
    expect((await search("الاساسيه")).map((h) => h.doc.refId)).toContain(a.id);
    expect((await search("accel")).map((h) => h.doc.refId)).toContain(b.id);
    expect((await search('"second law"')).map((h) => h.doc.refId)).toEqual([b.id]);
    expect((await search('"law second"')).length).toBe(0);
    await saveNoteContent(b.id, { title: "Physics", content: doc("Thermodynamics entropy") });
    expect((await search("acceleration")).length).toBe(0);
    expect((await search("entropy")).length).toBe(1);
    await softDelete("note", b.id);
    expect((await search("entropy")).length).toBe(0);
  });

  it("indexes tags and persists documents in IndexedDB", async () => {
    const n = await createNote({ title: "tagged", content: doc("body") });
    await setNoteTags(n.id, ["midterm"]);
    expect((await search("midterm")).length).toBe(1);
    expect(await db.searchIndex.count()).toBeGreaterThan(0);
    _resetSearchForTests();
    await initSearch(); // reload from IndexedDB
    expect((await search("midterm")).length).toBe(1);
    await reindex("note", n.id);
  });
});

describe("file security", () => {
  it("rejects spoofed, empty, unsupported files and dedupes identical ones", async () => {
    const fake = await addFile(new File([strToU8("<html><script>alert(1)</script>")], "evil.pdf", { type: "application/pdf" }));
    expect(fake.ok).toBe(false);
    const svg = await addFile(new File([strToU8("<svg onload=alert(1)>")], "x.svg"));
    expect(svg.reason).toBe("type");
    const exe = await addFile(new File([new Uint8Array([0x4d, 0x5a, 0, 0])], "a.txt"));
    expect(exe.reason).toBe("binary_text");
    const a = await addFile(new File([strToU8("same")], "a.txt"));
    const b = await addFile(new File([strToU8("same")], "b.md"));
    expect(a.ok && b.ok).toBe(true);
    expect(b.deduped).toBe(true);
    expect(await db.blobs.count()).toBe(1);
    const traversal = await addFile(new File([strToU8("x")], "../../etc/passwd.txt"));
    expect(traversal.attachment!.name).toBe("passwd.txt");
  });
});

describe("flashcards", () => {
  it("reviews cards with FSRS and logs the review", async () => {
    const deck = await createDeck({ name: "d" });
    const c = await createCard({ deckId: deck.id, type: "qa", front: "Q?", back: "A" });
    expect((await getDueCards()).length).toBe(1);
    const r = await reviewCard(c.id, 3);
    expect(r.reps).toBe(1);
    expect(r.successCount).toBe(1);
    expect(r.due).toBeGreaterThan(Date.now());
    expect((await getDueCards()).length).toBe(0);
    const r2 = await reviewCard(c.id, 3, r.due);
    expect(r2.state).toBe(2); // graduated to Review
    const f = await reviewCard(c.id, 1, r2.due);
    expect(f.failCount).toBe(1);
    expect(f.lapses).toBe(1);
    expect(await db.reviewLogs.count()).toBe(3);
    expect((await getDueCards({ now: f.due + 1 })).length).toBe(1);
  });
});

describe("quizzes", () => {
  it("saves a quiz, grades an attempt and stores it", async () => {
    const quiz = await createQuiz({ title: "Q", passScore: 50, shuffle: false });
    const q1 = { ...blankQuestion(quiz.id, 0, "tf"), prompt: "Sky is blue", bool: true };
    const q2 = { ...blankQuestion(quiz.id, 1, "short"), prompt: "2+2?", accepted: ["4"] };
    await saveQuiz(quiz, [q1, q2]);
    await expect(saveQuiz(quiz, [{ ...q2, accepted: [] }])).rejects.toThrow(/INVALID_QUESTION/);
    const qs = await getQuestions(quiz.id);
    expect(qs.length).toBe(2);
    const at = await submitAttempt(quiz, qs, { [qs[0].id]: true, [qs[1].id]: "5" }, Date.now() - 1000);
    expect(at.percent).toBe(50);
    expect(at.passed).toBe(true);
    expect(await db.quizAttempts.count()).toBe(1);
  });
});

describe("backup & restore", () => {
  async function seed() {
    const s = await createSubject({ name: "Chem" });
    const l = await createLecture({ subjectId: s.id, title: "Bonds" });
    const n = await createNote({ lectureId: l.id, title: "N", content: doc("covalent bond") });
    await setNoteTags(n.id, ["t1"]);
    await saveNoteContent(n.id, { title: "N", content: doc("covalent bond v2") });
    const f = await addFile(new File([strToU8("file body")], "f.txt"), { noteId: n.id });
    const d = await createDeck({ name: "deck", subjectId: s.id });
    const c = await createCard({ deckId: d.id, type: "qa", front: "f", back: "b" });
    await reviewCard(c.id, 3);
    return { s, l, n, f: f.attachment! };
  }

  it("round-trips everything (replace) and keeps relations and blobs", async () => {
    const { n, f } = await seed();
    const blob = await exportBackup();
    const counts: Record<string, number> = {};
    for (const t of TABLE_NAMES) counts[t] = await db.table(t).count();
    await wipe();
    expect(await db.notes.count()).toBe(0);
    const parsed = await parseBackup(blob);
    await applyBackup(parsed, "replace");
    for (const t of TABLE_NAMES) if (t !== "searchIndex" && t !== "activities") expect(await db.table(t).count(), t).toBe(counts[t]);
    const note = (await db.notes.get(n.id))!;
    expect(note.text).toBe("covalent bond v2");
    expect(note.lectureId).toBeTruthy();
    const att = (await db.attachments.get(f.id))!;
    expect(await (await db.blobs.get(att.blobId))!.blob.text()).toBe("file body");
    expect((await search("covalent")).length).toBe(1);
  });

  it("merges without duplicating and keeps newer local edits", async () => {
    const { n } = await seed();
    const blob = await exportBackup();
    await saveNoteContent(n.id, { title: "N", content: doc("newer local text") });
    await applyBackup(await parseBackup(blob), "merge");
    expect(await db.notes.count()).toBe(1);
    expect(await db.tags.count()).toBe(1);
    expect(await db.noteTags.count()).toBe(1);
    expect((await db.notes.get(n.id))!.text).toBe("newer local text");
  });

  it("rejects corrupt, traversal, newer-version and relation-broken archives without touching data", async () => {
    await seed();
    const before = await db.notes.count();
    await expect(parseBackup(new Uint8Array([1, 2, 3, 4, 5]))).rejects.toBeInstanceOf(BackupError);
    const evil = zipSync({ "../../evil.txt": strToU8("x"), "manifest.json": strToU8("{}") });
    await expect(parseBackup(evil)).rejects.toMatchObject({ code: "bad_entry" });
    const manifest = (v: number) => JSON.stringify({ format: "notevault-backup", formatVersion: v, dataVersion: 1, createdAt: 1, counts: {}, blobs: 0 });
    await expect(parseBackup(zipSync({ "manifest.json": strToU8(manifest(99)) }))).rejects.toMatchObject({ code: "newer_version" });
    const broken = zipSync({
      "manifest.json": strToU8(manifest(1)),
      "data/lectures.json": strToU8(JSON.stringify([{ id: "L1", subjectId: "missing", title: "x" }])),
    });
    await expect(parseBackup(broken)).rejects.toMatchObject({ code: "relation" });
    const xss = zipSync({
      "manifest.json": strToU8(manifest(1)),
      "data/notes.json": strToU8(JSON.stringify([{ id: "N1", title: "x", content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "ok", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] }] } }])),
    });
    await applyBackup(await parseBackup(xss), "merge");
    expect(JSON.stringify((await db.notes.get("N1"))!.content)).not.toContain("javascript");
    expect(await db.notes.count()).toBe(before + 1);
    // tampered blob content (hash mismatch) aborts the whole import
    const { f } = await seed();
    const good = await parseBackup(await exportBackup());
    good.blobs.set(f.blobId, strToU8("tampered!"));
    const notesBefore = await db.notes.count();
    await expect(applyBackup(good, "replace")).rejects.toBeInstanceOf(BackupError);
    expect(await db.notes.count()).toBe(notesBefore);
  });
});
