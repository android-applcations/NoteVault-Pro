// Domain logic – spaced repetition on top of ts-fsrs (FSRS algorithm).
import { createEmptyCard, fsrs, generatorParameters, Rating, State, type Card, type Grade } from "ts-fsrs";
import type { Flashcard, ReviewLog } from "@/data/types";

export { Rating, State };
export type GradeNum = 1 | 2 | 3 | 4;

const scheduler = fsrs(generatorParameters({ enable_fuzz: false, request_retention: 0.9 }));

export type SrsFields = Pick<
  Flashcard,
  "due" | "stability" | "difficulty" | "elapsedDays" | "scheduledDays" | "learningSteps" | "reps" | "lapses" | "state" | "lastReview"
>;

export function newSrsState(now = Date.now()): SrsFields {
  return fromCard(createEmptyCard(new Date(now)));
}

function fromCard(c: Card): SrsFields {
  return {
    due: c.due.getTime(),
    stability: c.stability,
    difficulty: c.difficulty,
    elapsedDays: c.elapsed_days,
    scheduledDays: c.scheduled_days,
    learningSteps: c.learning_steps,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state as number,
    lastReview: c.last_review ? c.last_review.getTime() : undefined,
  };
}

function toCard(f: SrsFields): Card {
  return {
    due: new Date(f.due),
    stability: f.stability,
    difficulty: f.difficulty,
    elapsed_days: f.elapsedDays,
    scheduled_days: f.scheduledDays,
    learning_steps: f.learningSteps,
    reps: f.reps,
    lapses: f.lapses,
    state: f.state as State,
    last_review: f.lastReview ? new Date(f.lastReview) : undefined,
  };
}

export interface ReviewOutcome {
  fields: SrsFields;
  log: Omit<ReviewLog, "id" | "cardId">;
  success: boolean;
}

/** Applies a rating to the card state and returns the new schedule. */
export function applyReview(card: SrsFields, grade: GradeNum, now = Date.now()): ReviewOutcome {
  const res = scheduler.next(toCard(card), new Date(now), grade as Grade);
  return {
    fields: fromCard(res.card),
    success: grade >= 2,
    log: {
      rating: grade,
      state: res.log.state as number,
      due: res.log.due.getTime(),
      stability: res.log.stability,
      difficulty: res.log.difficulty,
      elapsedDays: res.log.elapsed_days,
      scheduledDays: res.log.scheduled_days,
      reviewedAt: now,
    },
  };
}

/** Preview of the next due date for each of the four grades. */
export function previewIntervals(card: SrsFields, now = Date.now()): Record<GradeNum, number> {
  const rec = scheduler.repeat(toCard(card), new Date(now));
  return {
    1: rec[Rating.Again].card.due.getTime(),
    2: rec[Rating.Hard].card.due.getTime(),
    3: rec[Rating.Good].card.due.getTime(),
    4: rec[Rating.Easy].card.due.getTime(),
  };
}

export function formatInterval(dueMs: number, now = Date.now(), lang: "ar" | "en" = "ar"): string {
  const diff = Math.max(0, dueMs - now);
  const min = diff / 60000;
  const ar = lang === "ar";
  if (min < 1) return ar ? "<1 د" : "<1m";
  if (min < 60) return ar ? `${Math.round(min)} د` : `${Math.round(min)}m`;
  const h = min / 60;
  if (h < 24) return ar ? `${Math.round(h)} س` : `${Math.round(h)}h`;
  const d = h / 24;
  if (d < 30) return ar ? `${Math.round(d)} ي` : `${Math.round(d)}d`;
  const mo = d / 30;
  if (mo < 12) return ar ? `${mo.toFixed(1)} ش` : `${mo.toFixed(1)}mo`;
  return ar ? `${(d / 365).toFixed(1)} سنة` : `${(d / 365).toFixed(1)}y`;
}
