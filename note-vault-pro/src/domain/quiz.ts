// Domain logic – quiz grading and cloze helpers.
import type { QuestionResult, QuizQuestion } from "@/data/types";
import { normalize } from "./text";

export const normAnswer = (s: string) => normalize(s).replace(/[\s\p{P}]+/gu, " ").trim();

export interface ClozeSegment {
  text: string;
  blank?: string; // accepted answers separated by |
}

/** Parses `The {{mitochondria}} is ...` into segments. */
export function parseCloze(text: string): ClozeSegment[] {
  const out: ClozeSegment[] = [];
  const re = /\{\{([^{}]+)\}\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ text: "", blank: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

export function clozeBlanks(text: string): string[] {
  return parseCloze(text).filter((s) => s.blank !== undefined).map((s) => s.blank as string);
}

/** Turns a sentence into a cloze by hiding its longest word. */
export function sentenceToCloze(sentence: string): string | null {
  const words = sentence.match(/[\p{L}\p{N}]{4,}/gu);
  if (!words) return null;
  const w = words.reduce((a, b) => (b.length > a.length ? b : a));
  return sentence.replace(w, `{{${w}}}`);
}

function matchesAny(given: string, accepted: string[]): boolean {
  const g = normAnswer(given);
  if (!g) return false;
  return accepted.some((a) => a.split("|").some((alt) => normAnswer(alt) === g));
}

export type Answer = number | boolean | string | string[] | (string | null)[] | undefined;

export function gradeQuestion(q: QuizQuestion, answer: Answer): QuestionResult {
  let earned = 0;
  switch (q.type) {
    case "mcq":
      earned = typeof answer === "number" && answer === q.correct ? q.points : 0;
      break;
    case "tf":
      earned = typeof answer === "boolean" && answer === q.bool ? q.points : 0;
      break;
    case "short":
    case "image":
      earned = typeof answer === "string" && matchesAny(answer, q.accepted) ? q.points : 0;
      break;
    case "cloze": {
      const blanks = clozeBlanks(q.prompt);
      const arr = Array.isArray(answer) ? (answer as string[]) : [];
      if (blanks.length) {
        const ok = blanks.filter((b, i) => matchesAny(arr[i] ?? "", [b])).length;
        earned = (q.points * ok) / blanks.length;
      }
      break;
    }
    case "match": {
      const arr = Array.isArray(answer) ? (answer as (string | null)[]) : [];
      if (q.pairs.length) {
        const ok = q.pairs.filter((p, i) => arr[i] != null && normAnswer(arr[i] as string) === normAnswer(p[1])).length;
        earned = (q.points * ok) / q.pairs.length;
      }
      break;
    }
    case "order": {
      const arr = Array.isArray(answer) ? (answer as string[]) : [];
      if (q.options.length) {
        const ok = q.options.filter((o, i) => arr[i] === o).length;
        earned = ok === q.options.length ? q.points : 0;
      }
      break;
    }
  }
  earned = Math.round(earned * 100) / 100;
  return { questionId: q.id, type: q.type, correct: earned >= q.points && q.points > 0, earned, points: q.points, answer };
}

export function shuffle<T>(arr: T[], rnd: () => number = Math.random): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function summarize(results: QuestionResult[], passScore: number) {
  const total = results.reduce((s, r) => s + r.points, 0);
  const score = results.reduce((s, r) => s + r.earned, 0);
  const percent = total ? Math.round((score / total) * 1000) / 10 : 0;
  return { total, score: Math.round(score * 100) / 100, percent, passed: percent >= passScore };
}
