// Application services – flashcard decks, cards and spaced-repetition reviews.
import { db } from "@/data/db";
import type { CardSource, CardType, Flashcard, FlashcardDeck, ReviewLog } from "@/data/types";
import { applyReview, newSrsState, type GradeNum } from "@/domain/srs";
import { logActivity, uid } from "./core";
import { reindex, removeDocs } from "./search";

export async function createDeck(data: { name: string; subjectId?: string; description?: string }): Promise<FlashcardDeck> {
  const name = data.name.trim();
  if (!name) throw new Error("NAME_REQUIRED");
  const t = Date.now();
  const d: FlashcardDeck = { id: uid(), name, subjectId: data.subjectId, description: data.description?.trim() ?? "", createdAt: t, updatedAt: t };
  await db.flashcardDecks.add(d);
  await logActivity("create", name, "deck", d.id);
  return d;
}
export async function updateDeck(id: string, patch: Partial<Pick<FlashcardDeck, "name" | "subjectId" | "description">>) {
  await db.transaction("rw", [db.flashcardDecks, db.flashcards], async () => {
    await db.flashcardDecks.update(id, { ...patch, updatedAt: Date.now() });
    if ("subjectId" in patch) await db.flashcards.where("deckId").equals(id).modify({ subjectId: patch.subjectId });
  });
}
export async function deleteDeck(id: string) {
  const cardIds = await db.flashcards.where("deckId").equals(id).primaryKeys();
  await db.transaction("rw", [db.flashcardDecks, db.flashcards, db.reviewLogs], async () => {
    await db.reviewLogs.where("cardId").anyOf(cardIds).delete();
    await db.flashcards.bulkDelete(cardIds);
    await db.flashcardDecks.delete(id);
  });
  await removeDocs(cardIds.map((c) => `card:${c}`));
}

/** Finds (or creates) the default deck for a subject / general use. */
export async function getOrCreateDeck(subjectId?: string, fallbackName = "General"): Promise<FlashcardDeck> {
  const decks = await db.flashcardDecks.toArray();
  const found = decks.find((d) => d.subjectId === subjectId);
  if (found) return found;
  let name = fallbackName;
  if (subjectId) {
    const s = await db.subjects.get(subjectId);
    if (s) name = s.name;
  }
  return createDeck({ name, subjectId });
}

export interface CardInput {
  deckId: string;
  type: CardType;
  front: string;
  back: string;
  faces?: string[];
  imageId?: string;
  source?: CardSource;
}

export async function createCard(input: CardInput): Promise<Flashcard> {
  if (!input.front.trim() && input.type !== "imagelabel") throw new Error("EMPTY");
  const deck = await db.flashcardDecks.get(input.deckId);
  if (!deck) throw new Error("NOT_FOUND");
  const t = Date.now();
  const c: Flashcard = {
    id: uid(), deckId: deck.id, subjectId: deck.subjectId, type: input.type, front: input.front.trim(), back: input.back.trim(),
    faces: (input.faces ?? []).map((f) => f.trim()).filter(Boolean), imageId: input.imageId, source: input.source,
    ...newSrsState(t), successCount: 0, failCount: 0, createdAt: t, updatedAt: t,
  };
  await db.flashcards.add(c);
  await reindex("card", c.id);
  await logActivity("create", c.front.slice(0, 60), "card", c.id);
  return c;
}

export async function updateCard(id: string, patch: Partial<Pick<Flashcard, "front" | "back" | "faces" | "type" | "imageId" | "deckId">>) {
  const p: Partial<Flashcard> = { ...patch, updatedAt: Date.now() };
  if (patch.deckId) {
    const d = await db.flashcardDecks.get(patch.deckId);
    if (!d) throw new Error("NOT_FOUND");
    p.subjectId = d.subjectId;
  }
  await db.flashcards.update(id, p);
  await reindex("card", id);
}
export async function deleteCard(id: string) {
  await db.transaction("rw", [db.flashcards, db.reviewLogs], async () => {
    await db.reviewLogs.where("cardId").equals(id).delete();
    await db.flashcards.delete(id);
  });
  await removeDocs([`card:${id}`]);
}

export async function reviewCard(cardId: string, grade: GradeNum, now = Date.now()): Promise<Flashcard> {
  return db.transaction("rw", [db.flashcards, db.reviewLogs], async () => {
    const card = await db.flashcards.get(cardId);
    if (!card) throw new Error("NOT_FOUND");
    const out = applyReview(card, grade, now);
    const next: Flashcard = {
      ...card, ...out.fields, updatedAt: now,
      successCount: card.successCount + (out.success ? 1 : 0),
      failCount: card.failCount + (out.success ? 0 : 1),
    };
    await db.flashcards.put(next);
    const log: ReviewLog = { id: uid(), cardId, ...out.log };
    await db.reviewLogs.add(log);
    return next;
  });
}

export interface DueFilter {
  subjectId?: string;
  semesterId?: string;
  deckId?: string;
  limit?: number;
  now?: number;
}
export async function getDueCards(f: DueFilter = {}): Promise<Flashcard[]> {
  const now = f.now ?? Date.now();
  let subjectIds: Set<string> | null = null;
  if (f.semesterId) {
    const subs = await db.subjects.where("semesterId").equals(f.semesterId).primaryKeys();
    subjectIds = new Set(subs);
  }
  let cards = await db.flashcards.where("due").belowOrEqual(now).toArray();
  if (f.subjectId) cards = cards.filter((c) => c.subjectId === f.subjectId);
  if (subjectIds) cards = cards.filter((c) => c.subjectId && subjectIds!.has(c.subjectId));
  if (f.deckId) cards = cards.filter((c) => c.deckId === f.deckId);
  cards.sort((a, b) => a.due - b.due);
  return f.limit ? cards.slice(0, f.limit) : cards;
}

export interface ReviewStats {
  totalCards: number;
  due: number;
  newCards: number;
  learned: number;
  totalReviews: number;
  retention: number;
  days: { date: string; count: number; correct: number }[];
  sessions: number;
}
const dayKey = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export async function getReviewStats(days = 14): Promise<ReviewStats> {
  const now = Date.now();
  const [cards, logs] = await Promise.all([db.flashcards.toArray(), db.reviewLogs.toArray()]);
  const map = new Map<string, { count: number; correct: number }>();
  for (let i = days - 1; i >= 0; i--) map.set(dayKey(now - i * 86400000), { count: 0, correct: 0 });
  for (const l of logs) {
    const e = map.get(dayKey(l.reviewedAt));
    if (e) {
      e.count++;
      if (l.rating >= 2) e.correct++;
    }
  }
  const correct = logs.filter((l) => l.rating >= 2).length;
  // a "session" = a run of reviews with gaps < 30 min
  const sorted = logs.map((l) => l.reviewedAt).sort((a, b) => a - b);
  let sessions = 0;
  sorted.forEach((t, i) => {
    if (i === 0 || t - sorted[i - 1] > 30 * 60000) sessions++;
  });
  return {
    totalCards: cards.length, due: cards.filter((c) => c.due <= now).length, newCards: cards.filter((c) => c.state === 0).length,
    learned: cards.filter((c) => c.state === 2).length, totalReviews: logs.length, retention: logs.length ? Math.round((correct / logs.length) * 100) : 0,
    days: Array.from(map, ([date, v]) => ({ date, ...v })), sessions,
  };
}
