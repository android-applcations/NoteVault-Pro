import { useLiveQuery } from "dexie-react-hooks";
import { CheckCircle2, ChevronLeft, ChevronRight, Clock, XCircle, ArrowUp, ArrowDown } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { db } from "@/data/db";
import type { Quiz, QuizAttempt, QuizQuestion } from "@/data/types";
import { gradeQuestion, parseCloze, shuffle, type Answer } from "@/domain/quiz";
import { getQuestions, pickQuestions, submitAttempt } from "@/services/quizzes";
import { useApp } from "@/ui/app-context";
import { useI18n } from "@/ui/i18n";
import { Badge, Button, EmptyState, IconButton, Input, ProgressBar } from "@/ui/kit";
import { useBlobUrl } from "@/ui/shared";
import { cn } from "@/utils/cn";
import { useTypeLabels } from "./Quizzes";

function QImage({ id }: { id: string }) {
  const att = useLiveQuery(() => db.attachments.get(id), [id]);
  const { url } = useBlobUrl(att);
  return url ? <img src={url} alt={att?.description || att?.name || ""} className="mx-auto mb-3 max-h-60 rounded-xl object-contain" /> : null;
}

function correctText(q: QuizQuestion, t: (a: string, e: string) => string): string {
  switch (q.type) {
    case "mcq": return q.options[q.correct];
    case "tf": return q.bool ? t("صح", "True") : t("خطأ", "False");
    case "short": case "image": return q.accepted.map((a) => a.split("|")[0]).join(" / ");
    case "cloze": return parseCloze(q.prompt).filter((s) => s.blank !== undefined).map((s) => s.blank!.split("|")[0]).join("، ");
    case "match": return q.pairs.map((p) => `${p[0]} → ${p[1]}`).join("  |  ");
    case "order": return q.options.map((o, i) => `${i + 1}. ${o}`).join("  ");
  }
}

function QInput({ q, value, onChange, locked, rightOptions }: { q: QuizQuestion; value: Answer; onChange: (v: Answer) => void; locked: boolean; rightOptions: string[] }) {
  const { t } = useI18n();
  if (q.type === "mcq") return <div className="space-y-2" role="radiogroup">{q.options.map((o, i) => <label key={i} className={cn("flex cursor-pointer items-center gap-3 rounded-2xl border border-line p-3.5 text-sm font-semibold transition hover:bg-surface2", value === i && "border-accent bg-accent/10")}><input type="radio" disabled={locked} name={q.id} checked={value === i} onChange={() => onChange(i)} className="h-4 w-4 accent-[var(--accent)]" /><span dir="auto">{o}</span></label>)}</div>;
  if (q.type === "tf") return <div className="grid grid-cols-2 gap-3">{[true, false].map((v) => <button key={String(v)} disabled={locked} aria-pressed={value === v} onClick={() => onChange(v)} className={cn("rounded-2xl border border-line p-4 text-base font-bold transition hover:bg-surface2", value === v && "border-accent bg-accent/10")}>{v ? t("صح", "True") : t("خطأ", "False")}</button>)}</div>;
  if (q.type === "short" || q.type === "image") return <Input disabled={locked} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} placeholder={t("اكتب إجابتك", "Type your answer")} dir="auto" aria-label={t("إجابتك", "Your answer")} />;
  if (q.type === "cloze") {
    const arr = (Array.isArray(value) ? value : []) as string[];
    let bi = -1;
    return <p className="nv-selectable text-lg leading-[3rem]" dir="auto">{parseCloze(q.prompt).map((s, i) => { if (s.blank === undefined) return <span key={i}>{s.text}</span>; const k = ++bi; return <input key={i} disabled={locked} aria-label={`${t("فراغ", "Blank")} ${k + 1}`} value={arr[k] ?? ""} onChange={(e) => { const n = arr.slice(); n[k] = e.target.value; onChange(n); }} className="mx-1 inline-block w-28 max-w-full rounded-lg border-b-2 border-accent bg-surface2 px-2 py-1 text-center text-base sm:w-36" />; })}</p>;
  }
  if (q.type === "match") {
    const arr = (Array.isArray(value) ? value : []) as (string | null)[];
    return <div className="space-y-2">{q.pairs.map((p, i) => <div key={i} className="grid grid-cols-1 items-center gap-2 sm:grid-cols-2 sm:gap-3"><div className="nv-selectable rounded-xl bg-surface2 p-3 text-sm font-bold" dir="auto">{p[0]}</div>
      <select disabled={locked} aria-label={p[0]} value={arr[i] ?? ""} onChange={(e) => { const n = arr.slice(); while (n.length < q.pairs.length) n.push(null); n[i] = e.target.value || null; onChange(n as string[]); }} className="h-11 rounded-xl border border-line bg-surface px-2 text-sm"><option value="">—</option>{rightOptions.map((o) => <option key={o} value={o}>{o}</option>)}</select></div>)}</div>;
  }
  const arr = (Array.isArray(value) ? value : q.options) as string[];
  return <ol className="space-y-2">{arr.map((s, i) => <li key={s + i} className="flex items-center gap-2 rounded-2xl border border-line p-2.5 text-sm font-semibold"><span className="flex h-7 w-7 items-center justify-center rounded-lg bg-surface2 text-xs">{i + 1}</span><span className="flex-1" dir="auto">{s}</span>
    <IconButton label={t("للأعلى", "Up")} disabled={locked || i === 0} className="h-8 w-8" onClick={() => { const n = arr.slice(); [n[i - 1], n[i]] = [n[i], n[i - 1]]; onChange(n); }}><ArrowUp size={15} /></IconButton>
    <IconButton label={t("للأسفل", "Down")} disabled={locked || i === arr.length - 1} className="h-8 w-8" onClick={() => { const n = arr.slice(); [n[i + 1], n[i]] = [n[i], n[i + 1]]; onChange(n); }}><ArrowDown size={15} /></IconButton></li>)}</ol>;
}

export default function QuizTake() {
  const { id = "" } = useParams();
  const { t } = useI18n();
  const { toast } = useApp();
  const nav = useNavigate();
  const labels = useTypeLabels();
  const [quiz, setQuiz] = useState<Quiz | null | undefined>(undefined);
  const [pool, setPool] = useState<QuizQuestion[]>([]);
  const [qs, setQs] = useState<QuizQuestion[] | null>(null);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [idx, setIdx] = useState(0);
  const [attempt, setAttempt] = useState<QuizAttempt | null>(null);
  const [left, setLeft] = useState<number | null>(null);
  const startedAt = useRef(0);
  const submitting = useRef(false);

  useEffect(() => { db.quizzes.get(id).then(async (q) => { setQuiz(q ?? null); if (q) setPool(await getQuestions(id)); }); }, [id]);

  const start = () => {
    if (!quiz) return;
    const picked = pickQuestions(quiz, pool);
    const init: Record<string, Answer> = {};
    for (const q of picked) if (q.type === "order") { let s = shuffle(q.options); for (let k = 0; k < 5 && q.options.length > 1 && s.every((x, i) => x === q.options[i]); k++) s = shuffle(q.options); init[q.id] = s; }
    setAnswers(init); setChecked({}); setIdx(0); setAttempt(null); setQs(picked);
    startedAt.current = Date.now();
    setLeft(quiz.durationMin > 0 ? quiz.durationMin * 60 : null);
  };
  const finish = useCallback(async () => {
    if (!quiz || !qs || submitting.current) return;
    submitting.current = true;
    try { setAttempt(await submitAttempt(quiz, qs, answers, startedAt.current)); setLeft(null); } catch { toast(t("تعذر حفظ النتيجة", "Could not save the result"), "err"); } finally { submitting.current = false; }
  }, [quiz, qs, answers, toast, t]);
  useEffect(() => {
    if (left === null || attempt) return;
    if (left <= 0) { void finish(); return; }
    const timer = setTimeout(() => setLeft((l) => (l === null ? l : l - 1)), 1000);
    return () => clearTimeout(timer);
  }, [left, attempt, finish]);

  const rightOpts = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const q of qs ?? []) if (q.type === "match") m[q.id] = shuffle(q.pairs.map((p) => p[1]));
    return m;
  }, [qs]);

  if (quiz === undefined) return null;
  if (!quiz || pool.length === 0) return <EmptyState icon={<XCircle />} title={t("الاختبار غير متاح أو بلا أسئلة", "Quiz unavailable or empty")} action={<Link to="/quizzes"><Button>{t("الاختبارات", "Quizzes")}</Button></Link>} />;

  if (!qs) {
    const n = quiz.questionCount > 0 ? Math.min(quiz.questionCount, pool.length) : pool.length;
    return (
      <div className="mx-auto max-w-lg"><div className="card-surface p-8 text-center"><h1 className="text-2xl font-black" dir="auto">{quiz.title}</h1>{quiz.description && <p className="mt-1 text-sm text-muted" dir="auto">{quiz.description}</p>}
        <div className="my-5 flex flex-wrap justify-center gap-2"><Badge>{n} {t("سؤال", "questions")}</Badge>{quiz.durationMin > 0 && <Badge><Clock size={12} />{quiz.durationMin} {t("دقيقة", "min")}</Badge>}<Badge>{t("النجاح", "Pass")} {quiz.passScore}%</Badge><Badge>{quiz.mode === "exam" ? t("امتحان", "Exam") : t("تدريب", "Practice")}</Badge></div>
        <p className="mb-5 text-xs text-muted">{quiz.mode === "exam" ? t("لن تظهر الإجابات الصحيحة قبل التسليم.", "Correct answers are hidden until you submit.") : t("يمكنك تصحيح كل سؤال فور الإجابة عنه.", "You can check each question as you go.")}</p>
        <Button variant="primary" className="w-full !py-3 text-base" onClick={start}>{t("ابدأ الاختبار", "Start quiz")}</Button></div></div>
    );
  }

  if (attempt) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <div className="card-surface p-8 text-center">{attempt.passed ? <CheckCircle2 size={48} className="mx-auto mb-2 text-success" /> : <XCircle size={48} className="mx-auto mb-2 text-danger" />}
          <h1 className="text-3xl font-black">{attempt.percent}%</h1><p className="text-sm font-bold text-muted">{attempt.score} / {attempt.total} · {attempt.passed ? t("ناجح", "Passed") : t("لم تبلغ درجة النجاح", "Below the pass score")}</p>
          <div className="mt-4 flex justify-center gap-2"><Button onClick={start}>{t("إعادة المحاولة", "Retry")}</Button><Button variant="primary" onClick={() => nav("/quizzes")}>{t("الاختبارات", "Quizzes")}</Button></div></div>
        <h2 className="text-lg font-extrabold">{t("مراجعة الإجابات", "Review answers")}</h2>
        {qs.map((q, i) => { const r = attempt.results.find((x) => x.questionId === q.id)!; return (
          <div key={q.id} className={cn("card-surface space-y-2 p-4", r.correct ? "border-success/50" : "border-danger/50")}>
            <div className="flex items-center gap-2"><Badge>{i + 1}</Badge><Badge>{labels[q.type]}</Badge><span className={cn("ms-auto text-sm font-black", r.correct ? "text-success" : "text-danger")}>{r.earned}/{r.points}</span></div>
            {q.imageId && <QImage id={q.imageId} />}
            <p className="font-bold" dir="auto">{q.type === "cloze" ? parseCloze(q.prompt).map((s) => s.blank ?? s.text).join("") : q.prompt}</p>
            {!r.correct && <p className="text-sm"><b>{t("إجابتك", "Your answer")}:</b> <span dir="auto" className="text-danger">{answerText(q, answers[q.id], t)}</span></p>}
            <p className="text-sm"><b>{t("الإجابة الصحيحة", "Correct answer")}:</b> <span dir="auto" className="text-success">{correctText(q, t)}</span></p>
            {q.explanation && <p className="rounded-xl bg-surface2 p-2.5 text-sm text-muted" dir="auto">💡 {q.explanation}</p>}
          </div>); })}
      </div>
    );
  }

  const q = qs[idx];
  const isChecked = !!checked[q.id];
  const res = isChecked ? gradeQuestion(q, answers[q.id]) : null;
  const answered = Object.keys(answers).filter((k) => { const a = answers[k]; return a !== undefined && a !== "" && !(Array.isArray(a) && a.every((x) => !x)); }).length;
  const mm = left !== null ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : null;
  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-3 flex items-center gap-3"><div className="flex-1"><ProgressBar value={((idx + 1) / qs.length) * 100} /></div><span className="text-sm font-bold tabular-nums" dir="ltr">{idx + 1}/{qs.length}</span>{mm && <Badge color={left! < 60 ? "#c42a3b" : undefined}><Clock size={12} /><span dir="ltr">{mm}</span></Badge>}</div>
      <div className="card-surface space-y-4 p-5 sm:p-7">
        <div className="flex items-center gap-2"><Badge>{labels[q.type]}</Badge><span className="text-xs text-muted">{q.points} {t("درجة", "pt")}</span></div>
        {q.imageId && <QImage id={q.imageId} />}
        {q.type !== "cloze" && <h2 className="nv-selectable text-xl font-extrabold leading-8" dir="auto">{q.prompt}</h2>}
        <QInput q={q} value={answers[q.id]} onChange={(v) => setAnswers((a) => ({ ...a, [q.id]: v }))} locked={isChecked} rightOptions={rightOpts[q.id] ?? []} />
        {quiz.mode === "practice" && (isChecked ? (
          <div className={cn("rounded-2xl p-3 text-sm", res!.correct ? "bg-success/15" : "bg-danger/15")}><b>{res!.correct ? t("إجابة صحيحة ✓", "Correct ✓") : t("غير صحيحة ✗", "Incorrect ✗")}</b> — {t("الصحيح", "Answer")}: <span dir="auto">{correctText(q, t)}</span>{q.explanation && <p className="mt-1 text-muted" dir="auto">💡 {q.explanation}</p>}</div>
        ) : <Button onClick={() => setChecked((c) => ({ ...c, [q.id]: true }))}>{t("تصحيح هذا السؤال", "Check this question")}</Button>)}
      </div>
      <div className="mt-4 flex items-center justify-between gap-2">
        <Button onClick={() => setIdx((i) => Math.max(0, i - 1))} disabled={idx === 0}><ChevronRight size={16} className="ltr:rotate-180" />{t("السابق", "Previous")}</Button>
        <div className="hidden flex-wrap justify-center gap-1 sm:flex">{qs.map((x, i) => <button key={x.id} aria-label={`${t("سؤال", "Question")} ${i + 1}`} onClick={() => setIdx(i)} className={cn("h-7 w-7 rounded-lg text-xs font-bold", i === idx ? "bg-primary text-primary-fg" : answers[x.id] !== undefined ? "bg-accent/25" : "bg-surface2")}>{i + 1}</button>)}</div>
        {idx < qs.length - 1 ? <Button variant="primary" onClick={() => setIdx((i) => i + 1)}>{t("التالي", "Next")}<ChevronLeft size={16} className="ltr:rotate-180" /></Button> : <Button variant="accent" onClick={() => void finish()}>{t("تسليم", "Submit")} ({answered}/{qs.length})</Button>}
      </div>
      {idx < qs.length - 1 && <div className="mt-3 text-center"><button className="text-sm font-bold text-muted underline" onClick={() => void finish()}>{t("تسليم الآن", "Submit now")}</button></div>}
    </div>
  );
}

function answerText(q: QuizQuestion, a: Answer, t: (x: string, y: string) => string): string {
  if (a === undefined || a === "" || (Array.isArray(a) && a.every((x) => !x))) return t("(بلا إجابة)", "(no answer)");
  if (q.type === "mcq") return q.options[a as number] ?? "";
  if (q.type === "tf") return a ? t("صح", "True") : t("خطأ", "False");
  if (Array.isArray(a)) return a.map((x) => x ?? "—").join(q.type === "order" ? " → " : "، ");
  return String(a);
}
