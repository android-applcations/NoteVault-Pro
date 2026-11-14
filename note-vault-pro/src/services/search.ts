// Search engine – incremental local full-text index (MiniSearch) persisted as documents in IndexedDB.
import MiniSearch, { type SearchResult } from "minisearch";
import { db } from "@/data/db";
import type { Attachment, Flashcard, Lecture, Note, Reference, SearchDoc, SearchKind, Subject } from "@/data/types";
import { makeSnippet, normalize, queryTerms, type SnippetPart } from "@/domain/text";

function processTerm(t: string): string | null {
  let n = normalize(t);
  if (!n) return null;
  if (n.length > 4 && n.startsWith("ال")) n = n.slice(2); // Arabic definite article
  return n;
}

function createIndex() {
  return new MiniSearch<SearchDoc>({
    fields: ["title", "body"],
    storeFields: ["kind", "refId", "subjectId", "lectureId", "updatedAt", "title"],
    idField: "id",
    processTerm,
    searchOptions: { boost: { title: 3 }, prefix: true, fuzzy: (t) => (t.length > 5 ? 0.2 : false), combineWith: "AND", processTerm },
  });
}

let ms = createIndex();
let readyPromise: Promise<void> | null = null;

export function initSearch(): Promise<void> {
  if (!readyPromise) {
    readyPromise = (async () => {
      const docs = await db.searchIndex.toArray();
      ms.addAll(docs);
      if (docs.length === 0) {
        const any = (await db.notes.count()) + (await db.subjects.count()) + (await db.attachments.count()) + (await db.flashcards.count());
        if (any > 0) await rebuildIndex();
      }
    })();
  }
  return readyPromise;
}

/** Test helper: resets in-memory state. */
export function _resetSearchForTests() {
  ms = createIndex();
  readyPromise = null;
}

export async function upsertDoc(doc: SearchDoc) {
  await initSearch();
  await db.searchIndex.put(doc);
  ms.has(doc.id) ? ms.replace(doc) : ms.add(doc);
}

export async function removeDocs(ids: string[]) {
  await initSearch();
  const present = ids.filter((i) => ms.has(i));
  for (const i of present) ms.discard(i);
  await db.searchIndex.bulkDelete(ids);
}

const clip = (s: string, n = 400_000) => (s.length > n ? s.slice(0, n) : s);

export const docFromSubject = (s: Subject): SearchDoc => ({
  id: `subject:${s.id}`, kind: "subject", refId: s.id, title: s.name,
  body: [s.code, s.description, s.teacher].filter(Boolean).join(" "), subjectId: s.id, updatedAt: s.updatedAt,
});
export const docFromLecture = (l: Lecture): SearchDoc => ({
  id: `lecture:${l.id}`, kind: "lecture", refId: l.id, title: l.title,
  body: [l.description, l.keywords.join(" ")].filter(Boolean).join(" "), subjectId: l.subjectId, lectureId: l.id, updatedAt: l.updatedAt,
});
export async function docFromNote(n: Note): Promise<SearchDoc> {
  const links = await db.noteTags.where("noteId").equals(n.id).toArray();
  const tags = links.length ? await db.tags.bulkGet(links.map((l) => l.tagId)) : [];
  return {
    id: `note:${n.id}`, kind: "note", refId: n.id, title: n.title || "",
    body: clip(n.text + " " + tags.filter(Boolean).map((t) => t!.name).join(" ")),
    subjectId: n.subjectId, lectureId: n.lectureId, updatedAt: n.updatedAt,
  };
}
export const docFromCard = (c: Flashcard): SearchDoc => ({
  id: `card:${c.id}`, kind: "card", refId: c.id, title: c.front.slice(0, 120),
  body: [c.back, ...c.faces].join(" "), subjectId: c.subjectId, updatedAt: c.updatedAt,
});
export const docFromReference = (r: Reference): SearchDoc => ({
  id: `reference:${r.id}`, kind: "reference", refId: r.id, title: r.title,
  body: [r.authors, r.publisher, r.year, r.container, r.doi, r.notes].filter(Boolean).join(" "), subjectId: r.subjectId, updatedAt: r.updatedAt,
});
export async function docFromAttachment(a: Attachment): Promise<SearchDoc> {
  let extra = "";
  let kind: SearchKind = "file";
  if (a.kind === "pdf") {
    kind = "pdf";
    const pdf = await db.pdfDocuments.get(a.id);
    extra = pdf ? pdf.pageTexts.join("\n") : "";
  } else if (a.kind === "text" || a.kind === "markdown") {
    const b = await db.blobs.get(a.blobId);
    if (b && b.blob.size < 2_000_000) extra = await b.blob.text();
  }
  return {
    id: `${kind}:${a.id}`, kind, refId: a.id, title: a.name,
    body: clip([a.description, extra].filter(Boolean).join("\n")),
    subjectId: a.subjectId, lectureId: a.lectureId, updatedAt: a.updatedAt,
  };
}

/** Re-indexes (or removes) one record after a change. */
export async function reindex(kind: "subject" | "lecture" | "note" | "attachment" | "card" | "reference", id: string) {
  switch (kind) {
    case "subject": {
      const s = await db.subjects.get(id);
      return s && !s.deletedAt ? upsertDoc(docFromSubject(s)) : removeDocs([`subject:${id}`]);
    }
    case "lecture": {
      const l = await db.lectures.get(id);
      return l && !l.deletedAt ? upsertDoc(docFromLecture(l)) : removeDocs([`lecture:${id}`]);
    }
    case "note": {
      const n = await db.notes.get(id);
      return n && !n.deletedAt ? upsertDoc(await docFromNote(n)) : removeDocs([`note:${id}`]);
    }
    case "attachment": {
      const a = await db.attachments.get(id);
      if (a && !a.deletedAt) {
        await removeDocs([`file:${id}`, `pdf:${id}`]);
        return upsertDoc(await docFromAttachment(a));
      }
      return removeDocs([`file:${id}`, `pdf:${id}`]);
    }
    case "card": {
      const c = await db.flashcards.get(id);
      return c ? upsertDoc(docFromCard(c)) : removeDocs([`card:${id}`]);
    }
    case "reference": {
      const r = await db.references.get(id);
      return r ? upsertDoc(docFromReference(r)) : removeDocs([`reference:${id}`]);
    }
  }
}

export async function rebuildIndex(onProgress?: (done: number, total: number) => void) {
  ms.removeAll();
  await db.searchIndex.clear();
  const [subjects, lectures, notes, atts, cards, refs] = await Promise.all([
    db.subjects.toArray(), db.lectures.toArray(), db.notes.toArray(), db.attachments.toArray(), db.flashcards.toArray(), db.references.toArray(),
  ]);
  const live = <T extends { deletedAt?: number }>(x: T[]) => x.filter((i) => !i.deletedAt);
  const total = subjects.length + lectures.length + notes.length + atts.length + cards.length + refs.length;
  let done = 0;
  const flush = async (docs: SearchDoc[]) => {
    if (!docs.length) return;
    await db.searchIndex.bulkPut(docs);
    ms.addAll(docs);
    done += docs.length;
    onProgress?.(done, total);
    await new Promise((r) => setTimeout(r, 0)); // yield to UI between batches
  };
  await flush(live(subjects).map(docFromSubject));
  await flush(live(lectures).map(docFromLecture));
  await flush(cards.map(docFromCard));
  await flush(refs.map(docFromReference));
  for (let i = 0; i < notes.length; i += 50) {
    const batch = live(notes.slice(i, i + 50));
    await flush(await Promise.all(batch.map(docFromNote)));
  }
  for (let i = 0; i < atts.length; i += 10) {
    const batch = live(atts.slice(i, i + 10));
    await flush(await Promise.all(batch.map(docFromAttachment)));
  }
  readyPromise = Promise.resolve();
}

export interface SearchFilters {
  kinds?: SearchKind[];
  subjectId?: string;
  from?: number;
  to?: number;
}
export interface SearchHit {
  doc: SearchDoc;
  score: number;
  parts: SnippetPart[];
  page?: number;
  terms: string[];
}

export async function search(rawQuery: string, filters: SearchFilters = {}, limit = 50): Promise<SearchHit[]> {
  await initSearch();
  const phrases: string[] = [];
  const rest = rawQuery.replace(/"([^"]+)"/g, (_m, p: string) => {
    phrases.push(p);
    return " " + p + " ";
  });
  const terms = queryTerms(rest);
  if (!terms.length) return [];
  const filter = (r: SearchResult) => {
    if (filters.kinds?.length && !filters.kinds.includes(r.kind as SearchKind)) return false;
    if (filters.subjectId && r.subjectId !== filters.subjectId) return false;
    if (filters.from && (r.updatedAt as number) < filters.from) return false;
    if (filters.to && (r.updatedAt as number) > filters.to) return false;
    return true;
  };
  let results = ms.search(rest, { filter });
  if (!results.length && terms.length > 1) results = ms.search(rest, { filter, combineWith: "OR" });
  results = results.slice(0, limit * 2);
  const docs = await db.searchIndex.bulkGet(results.map((r) => r.id as string));
  const hits: SearchHit[] = [];
  const normPhrases = phrases.map((p) => normalize(p).replace(/\s+/g, " ").trim());
  for (let i = 0; i < results.length && hits.length < limit; i++) {
    const doc = docs[i];
    if (!doc) continue;
    if (normPhrases.length) {
      const nb = normalize(doc.title + " " + doc.body).replace(/\s+/g, " ");
      if (!normPhrases.every((p) => nb.includes(p))) continue;
    }
    const matchTerms = Array.from(new Set([...terms.map((t) => processTerm(t) ?? t), ...normPhrases]));
    const bodyHit = makeSnippet(doc.body, matchTerms);
    const parts = bodyHit.index >= 0 ? bodyHit.parts : makeSnippet(doc.title, matchTerms).parts;
    const hit: SearchHit = { doc, score: results[i].score, parts: bodyHit.index >= 0 ? parts : doc.body ? makeSnippet(doc.body.slice(0, 160), []).parts : parts, terms: matchTerms };
    if (doc.kind === "pdf" && hits.filter((h) => h.doc.kind === "pdf").length < 20) {
      const pdf = await db.pdfDocuments.get(doc.refId);
      if (pdf) {
        const t0 = matchTerms[0];
        const idx = pdf.pageTexts.findIndex((p) => normalize(p).includes(t0));
        if (idx >= 0) {
          hit.page = idx + 1;
          hit.parts = makeSnippet(pdf.pageTexts[idx], matchTerms).parts;
        }
      }
    }
    hits.push(hit);
  }
  return hits;
}

export async function suggest(prefix: string): Promise<string[]> {
  await initSearch();
  const q = prefix.trim();
  if (q.length < 2) return [];
  try {
    return ms.autoSuggest(q, { prefix: true, processTerm, fuzzy: false }).slice(0, 6).map((s) => s.suggestion);
  } catch {
    return [];
  }
}

export async function getRecentSearches(): Promise<string[]> {
  const r = await db.appSettings.get("recentSearches");
  return Array.isArray(r?.value) ? (r!.value as string[]) : [];
}
export async function pushRecentSearch(q: string) {
  const t = q.trim();
  if (!t) return;
  const cur = (await getRecentSearches()).filter((x) => x !== t);
  await db.appSettings.put({ key: "recentSearches", value: [t, ...cur].slice(0, 12) });
}
export async function clearRecentSearches() {
  await db.appSettings.put({ key: "recentSearches", value: [] });
}
