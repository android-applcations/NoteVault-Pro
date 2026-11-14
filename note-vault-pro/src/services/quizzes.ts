// Application services – quizzes, attempts, analysis.
import { db } from "@/data/db";
import type { Quiz, QuizAttempt, QuizQuestion, QuestionType } from "@/data/types";
import { gradeQuestion, sentenceToCloze, shuffle, summarize, type Answer } from "@/domain/quiz";
import { logActivity, uid } from "./core";

export function blankQuestion(quizId: string, order: number, type: QuestionType = "mcq"): QuizQuestion {
  return {
    id: uid(), quizId, order, type, prompt: "", options: type === "mcq" ? ["", "", "", ""] : type === "order" ? ["", "", ""] : [],
    correct: 0, bool: true, accepted: [], pairs: type === "match" ? [["", ""], ["", ""]] : [], explanation: "", points: 1,
  };
}

export async function createQuiz(data: Partial<Omit<Quiz, "id" | "createdAt" | "updatedAt">> & { title: string }): Promise<Quiz> {
  const title = data.title.trim();
  if (!title) throw new Error("NAME_REQUIRED");
  const t = Date.now();
  const q: Quiz = {
    id: uid(), title, description: data.description ?? "", subjectId: data.subjectId, semesterId: data.semesterId,
    durationMin: data.durationMin ?? 0, passScore: data.passScore ?? 60, shuffle: data.shuffle ?? true, mode: data.mode ?? "exam",
    questionCount: data.questionCount ?? 0, createdAt: t, updatedAt: t,
  };
  await db.quizzes.add(q);
  await logActivity("create", title, "quiz", q.id);
  return q;
}

/** Validates a question and returns an error key (or null when valid). */
export function validateQuestion(q: QuizQuestion): string | null {
  if (!q.prompt.trim()) return "prompt";
  switch (q.type) {
    case "mcq": {
      const opts = q.options.map((o) => o.trim());
      if (opts.filter(Boolean).length < 2 || !opts[q.correct]) return "options";
      return null;
    }
    case "short":
    case "image":
      return q.accepted.map((a) => a.trim()).filter(Boolean).length ? null : "answer";
    case "cloze":
      return /\{\{[^{}]+\}\}/.test(q.prompt) ? null : "cloze";
    case "match":
      return q.pairs.filter((p) => p[0].trim() && p[1].trim()).length >= 2 ? null : "pairs";
    case "order":
      return q.options.filter((o) => o.trim()).length >= 2 ? null : "steps";
    default:
      return null;
  }
}

/** Replaces the whole question set for a quiz atomically. */
export async function saveQuiz(quiz: Quiz, questions: QuizQuestion[]) {
  const cleaned = questions.map((q, i) => ({
    ...q, quizId: quiz.id, order: i, prompt: q.prompt.trim(),
    options: q.type === "mcq" ? q.options.map((o) => o.trim()).filter((o, idx) => o || idx === q.correct) : q.options.map((o) => o.trim()).filter(Boolean),
    accepted: q.accepted.map((a) => a.trim()).filter(Boolean),
    pairs: q.pairs.filter((p) => p[0].trim() && p[1].trim()).map((p) => [p[0].trim(), p[1].trim()] as [string, string]),
    points: Math.max(0.5, Number(q.points) || 1),
  }));
  for (const q of cleaned) {
    const err = validateQuestion(q);
    if (err) throw new Error("INVALID_QUESTION:" + err);
  }
  await db.transaction("rw", [db.quizzes, db.quizQuestions], async () => {
    await db.quizzes.put({ ...quiz, updatedAt: Date.now() });
    await db.quizQuestions.where("quizId").equals(quiz.id).delete();
    await db.quizQuestions.bulkAdd(cleaned);
  });
}

export async function deleteQuiz(id: string) {
  await db.transaction("rw", [db.quizzes, db.quizQuestions, db.quizAttempts], async () => {
    await db.quizQuestions.where("quizId").equals(id).delete();
    await db.quizAttempts.where("quizId").equals(id).delete();
    await db.quizzes.delete(id);
  });
}

export async function getQuestions(quizId: string): Promise<QuizQuestion[]> {
  return (await db.quizQuestions.where("quizId").equals(quizId).sortBy("order"));
}

/** Picks and orders the questions for one attempt. */
export function pickQuestions(quiz: Quiz, pool: QuizQuestion[], rnd?: () => number): QuizQuestion[] {
  let qs = quiz.shuffle ? shuffle(pool, rnd) : pool.slice();
  if (quiz.questionCount > 0 && quiz.questionCount < qs.length) qs = qs.slice(0, quiz.questionCount);
  return qs;
}

export async function submitAttempt(quiz: Quiz, questions: QuizQuestion[], answers: Record<string, Answer>, startedAt: number): Promise<QuizAttempt> {
  const results = questions.map((q) => gradeQuestion(q, answers[q.id]));
  const s = summarize(results, quiz.passScore);
  const attempt: QuizAttempt = {
    id: uid(), quizId: quiz.id, subjectId: quiz.subjectId, startedAt, finishedAt: Date.now(),
    score: s.score, total: s.total, percent: s.percent, passed: s.passed, results,
  };
  await db.quizAttempts.add(attempt);
  await logActivity("quiz", `${quiz.title} — ${s.percent}%`, "quiz", quiz.id);
  return attempt;
}

/** Strengths / weaknesses by question type across attempts. */
export function analyze(attempts: QuizAttempt[]): { type: QuestionType; correct: number; total: number; pct: number }[] {
  const m = new Map<QuestionType, { correct: number; total: number }>();
  for (const a of attempts)
    for (const r of a.results) {
      const e = m.get(r.type) ?? { correct: 0, total: 0 };
      e.total += r.points;
      e.correct += r.earned;
      m.set(r.type, e);
    }
  return Array.from(m, ([type, v]) => ({ type, correct: v.correct, total: v.total, pct: v.total ? Math.round((v.correct / v.total) * 100) : 0 })).sort((a, b) => a.pct - b.pct);
}

export function draftQuestionsFromText(quizId: string, text: string, startOrder: number, max = 10): QuizQuestion[] {
  const sentences = text.split(/(?<=[.!?؟\n])\s+/).map((s) => s.trim()).filter((s) => s.length > 25 && s.length < 300);
  const out: QuizQuestion[] = [];
  for (const s of sentences) {
    const c = sentenceToCloze(s);
    if (!c) continue;
    const q = blankQuestion(quizId, startOrder + out.length, "cloze");
    q.prompt = c;
    out.push(q);
    if (out.length >= max) break;
  }
  return out;
}
