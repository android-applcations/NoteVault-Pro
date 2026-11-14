import { useLiveQuery } from "dexie-react-hooks";
import { ArrowDown, ArrowRight, ArrowUp, Plus, Save, Trash2, Wand2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { db } from "@/data/db";
import type { Quiz, QuestionType, QuizQuestion } from "@/data/types";
import { blankQuestion, draftQuestionsFromText, getQuestions, saveQuiz, validateQuestion } from "@/services/quizzes";
import { uid } from "@/services/core";
import { useApp } from "@/ui/app-context";
import { useI18n } from "@/ui/i18n";
import { Button, EmptyState, Field, IconButton, Input, Modal, PageHeader, Select, Textarea } from "@/ui/kit";
import { useSubjects } from "@/ui/shared";
import { useTypeLabels } from "./Quizzes";

function QEditor({ q, i, n, onChange, onMove, onDelete, images }: { q: QuizQuestion; i: number; n: number; onChange: (q: QuizQuestion) => void; onMove: (d: -1 | 1) => void; onDelete: () => void; images: { id: string; name: string }[] }) {
  const { t } = useI18n();
  const labels = useTypeLabels();
  const set = (p: Partial<QuizQuestion>) => onChange({ ...q, ...p });
  const lines = (a: string[]) => a.join("\n");
  const err = validateQuestion(q);
  return (
    <div className="card-surface space-y-3 p-4">
      <div className="flex items-center gap-2">
        <span className="rounded-lg bg-primary px-2.5 py-1 text-sm font-black text-primary-fg">{i + 1}</span>
        <span className="text-sm font-bold">{labels[q.type]}</span>
        <div className="ms-auto flex"><IconButton label={t("للأعلى", "Move up")} disabled={i === 0} onClick={() => onMove(-1)}><ArrowUp size={16} /></IconButton><IconButton label={t("للأسفل", "Move down")} disabled={i === n - 1} onClick={() => onMove(1)}><ArrowDown size={16} /></IconButton><IconButton label={t("حذف السؤال", "Delete question")} onClick={onDelete}><Trash2 size={16} className="text-danger" /></IconButton></div>
      </div>
      <Field label={q.type === "cloze" ? t("النص — ضع الكلمات المخفية بين {{ }} (بدائل بـ |)", "Text — wrap hidden words in {{ }} (alternatives with |)") : t("نص السؤال", "Question text")}>{(id) => <Textarea id={id} rows={2} value={q.prompt} onChange={(e) => set({ prompt: e.target.value })} dir="auto" />}</Field>
      {q.type === "mcq" && (
        <div className="space-y-2"><span className="text-xs font-semibold text-muted">{t("الخيارات (حدّد الصحيح)", "Options (mark the correct one)")}</span>
          {q.options.map((o, k) => <div key={k} className="flex items-center gap-2"><input type="radio" name={`c-${q.id}`} checked={q.correct === k} onChange={() => set({ correct: k })} aria-label={t("الإجابة الصحيحة", "Correct answer")} className="h-4 w-4 accent-[var(--accent)]" /><Input value={o} dir="auto" aria-label={`${t("خيار", "Option")} ${k + 1}`} onChange={(e) => set({ options: q.options.map((x, j) => (j === k ? e.target.value : x)) })} />
            {q.options.length > 2 && <IconButton label={t("حذف الخيار", "Remove option")} onClick={() => set({ options: q.options.filter((_, j) => j !== k), correct: q.correct >= k && q.correct > 0 ? q.correct - 1 : q.correct })}><Trash2 size={14} /></IconButton>}</div>)}
          {q.options.length < 8 && <Button onClick={() => set({ options: [...q.options, ""] })}><Plus size={14} />{t("خيار", "Option")}</Button>}</div>
      )}
      {q.type === "tf" && <div className="flex gap-2">{[true, false].map((v) => <label key={String(v)} className="flex items-center gap-2 text-sm font-bold"><input type="radio" name={`tf-${q.id}`} checked={q.bool === v} onChange={() => set({ bool: v })} className="accent-[var(--accent)]" />{v ? t("صح", "True") : t("خطأ", "False")}</label>)}</div>}
      {(q.type === "short" || q.type === "image") && <Field label={t("الإجابات المقبولة (سطر لكل بديل)", "Accepted answers (one per line)")}>{(id) => <Textarea id={id} rows={2} value={lines(q.accepted)} onChange={(e) => set({ accepted: e.target.value.split("\n") })} dir="auto" />}</Field>}
      {q.type === "match" && (
        <div className="space-y-2"><span className="text-xs font-semibold text-muted">{t("أزواج المطابقة", "Matching pairs")}</span>
          {q.pairs.map((p, k) => <div key={k} className="grid grid-cols-[1fr_1fr_auto] gap-2"><Input value={p[0]} dir="auto" aria-label={t("العنصر", "Item")} onChange={(e) => set({ pairs: q.pairs.map((x, j) => (j === k ? [e.target.value, x[1]] : x)) })} /><Input value={p[1]} dir="auto" aria-label={t("المقابل", "Match")} onChange={(e) => set({ pairs: q.pairs.map((x, j) => (j === k ? [x[0], e.target.value] : x)) })} />
            <IconButton label={t("حذف", "Remove")} disabled={q.pairs.length <= 2} onClick={() => set({ pairs: q.pairs.filter((_, j) => j !== k) })}><Trash2 size={14} /></IconButton></div>)}
          <Button onClick={() => set({ pairs: [...q.pairs, ["", ""]] })}><Plus size={14} />{t("زوج", "Pair")}</Button></div>
      )}
      {q.type === "order" && <Field label={t("الخطوات بالترتيب الصحيح (سطر لكل خطوة)", "Steps in the correct order (one per line)")}>{(id) => <Textarea id={id} rows={4} value={lines(q.options)} onChange={(e) => set({ options: e.target.value.split("\n") })} dir="auto" />}</Field>}
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_6rem]">
        <Field label={t("شرح الإجابة (اختياري)", "Explanation (optional)")}>{(id) => <Input id={id} value={q.explanation} onChange={(e) => set({ explanation: e.target.value })} dir="auto" />}</Field>
        <Field label={t("صورة (اختياري)", "Image (optional)")}>{(id) => <Select id={id} value={q.imageId ?? ""} onChange={(e) => set({ imageId: e.target.value || undefined })}><option value="">—</option>{images.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>}</Field>
        <Field label={t("الدرجة", "Points")}>{(id) => <Input id={id} type="number" min={0.5} step={0.5} value={q.points} onChange={(e) => set({ points: Number(e.target.value) })} />}</Field>
      </div>
      {err && <p className="text-xs font-bold text-warn">⚠ {err === "prompt" ? t("أدخل نص السؤال", "Enter the question text") : err === "options" ? t("أدخل خيارين على الأقل وحدّد الصحيح", "Add at least 2 options and mark the correct one") : err === "answer" ? t("أضف إجابة مقبولة", "Add an accepted answer") : err === "cloze" ? t("ضع كلمة بين {{ }}", "Wrap a word in {{ }}") : err === "pairs" ? t("أضف زوجين على الأقل", "Add at least 2 pairs") : t("أضف خطوتين على الأقل", "Add at least 2 steps")}</p>}
    </div>
  );
}

export default function QuizBuilder() {
  const { id = "" } = useParams();
  const { t } = useI18n();
  const { toast } = useApp();
  const nav = useNavigate();
  const labels = useTypeLabels();
  const subjects = useSubjects(true);
  const semesters = useLiveQuery(() => db.semesters.toArray(), []) ?? [];
  const images = useLiveQuery(() => db.attachments.where("kind").equals("image").filter((a) => !a.deletedAt).toArray(), []) ?? [];
  const notes = useLiveQuery(() => db.notes.filter((n) => !n.deletedAt && n.text.length > 40).toArray(), []) ?? [];
  const decks = useLiveQuery(() => db.flashcardDecks.toArray(), []) ?? [];
  const [quiz, setQuiz] = useState<Quiz | null | undefined>(undefined);
  const [qs, setQs] = useState<QuizQuestion[]>([]);
  const [dirty, setDirty] = useState(false);
  const [gen, setGen] = useState(false);
  const [genNote, setGenNote] = useState("");
  const [genDeck, setGenDeck] = useState("");
  useEffect(() => { db.quizzes.get(id).then(async (q) => { setQuiz(q ?? null); if (q) setQs(await getQuestions(id)); }); }, [id]);
  useEffect(() => { const h = (e: BeforeUnloadEvent) => { if (dirty) e.preventDefault(); }; window.addEventListener("beforeunload", h); return () => window.removeEventListener("beforeunload", h); }, [dirty]);
  if (quiz === undefined) return null;
  if (!quiz) return <EmptyState icon={<Trash2 />} title={t("الاختبار غير موجود", "Quiz not found")} />;
  const upd = (p: Partial<Quiz>) => { setQuiz({ ...quiz, ...p }); setDirty(true); };
  const setQ = (next: QuizQuestion[]) => { setQs(next); setDirty(true); };
  const save = async () => {
    try { await saveQuiz(quiz, qs); setDirty(false); toast(t("تم حفظ الاختبار", "Quiz saved")); }
    catch (e) { const m = e instanceof Error ? e.message : ""; toast(m.startsWith("INVALID_QUESTION") ? t("بعض الأسئلة غير مكتملة — راجع التحذيرات", "Some questions are incomplete — see the warnings") : t("تعذر الحفظ", "Could not save"), "err"); }
  };
  const move = (i: number, d: -1 | 1) => { const a = qs.slice(); [a[i], a[i + d]] = [a[i + d], a[i]]; setQ(a); };
  const add = (type: QuestionType) => setQ([...qs, blankQuestion(quiz.id, qs.length, type)]);
  const doGen = () => {
    const out: QuizQuestion[] = [];
    if (genNote) { const n = notes.find((x) => x.id === genNote); if (n) out.push(...draftQuestionsFromText(quiz.id, n.text, qs.length, 10)); }
    if (genDeck) {
      db.flashcards.where("deckId").equals(genDeck).toArray().then((cards) => {
        const more = cards.filter((c) => (c.type === "qa" || c.type === "term") && c.back).slice(0, 15).map((c, k) => ({ ...blankQuestion(quiz.id, qs.length + out.length + k, "short"), id: uid(), prompt: c.front, accepted: [c.back.split("\n")[0]] }));
        setQ([...qs, ...out, ...more]);
        toast(t(`أُضيف ${out.length + more.length} سؤال`, `${out.length + more.length} questions added`));
      });
    } else { setQ([...qs, ...out]); toast(out.length ? t(`أُضيف ${out.length} سؤال — راجعها وعدّلها`, `${out.length} questions added — review and edit them`) : t("لم يتم العثور على جمل مناسبة", "No suitable sentences found"), out.length ? "ok" : "info"); }
    setGen(false);
  };
  return (
    <div>
      <PageHeader title={t("تحرير الاختبار", "Edit quiz")} back={<button onClick={() => nav("/quizzes")} className="mb-2 inline-flex items-center gap-1 text-sm font-bold text-muted"><ArrowRight size={14} className="ltr:rotate-180" />{t("الاختبارات", "Quizzes")}</button>}
        actions={<><Button onClick={() => setGen(true)}><Wand2 size={16} />{t("إضافة من الملاحظات", "Add from notes")}</Button><Button variant="primary" onClick={() => void save()}><Save size={16} />{t("حفظ", "Save")}{dirty ? " •" : ""}</Button></>} />
      <section className="card-surface mb-5 grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-3">
        <Field label={t("عنوان الاختبار", "Title")} className="lg:col-span-2">{(i) => <Input id={i} value={quiz.title} onChange={(e) => upd({ title: e.target.value })} dir="auto" />}</Field>
        <Field label={t("النمط", "Mode")}>{(i) => <Select id={i} value={quiz.mode} onChange={(e) => upd({ mode: e.target.value as Quiz["mode"] })}><option value="exam">{t("امتحان (النتائج في النهاية)", "Exam (results at the end)")}</option><option value="practice">{t("تدريب (تصحيح فوري لكل سؤال)", "Practice (instant feedback)")}</option></Select>}</Field>
        <Field label={t("المادة", "Subject")}>{(i) => <Select id={i} value={quiz.subjectId ?? ""} onChange={(e) => upd({ subjectId: e.target.value || undefined })}><option value="">—</option>{subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}</Field>
        <Field label={t("الفصل", "Semester")}>{(i) => <Select id={i} value={quiz.semesterId ?? ""} onChange={(e) => upd({ semesterId: e.target.value || undefined })}><option value="">—</option>{semesters.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}</Field>
        <Field label={t("عدد الأسئلة (0 = الكل)", "Questions per attempt (0 = all)")}>{(i) => <Input id={i} type="number" min={0} value={quiz.questionCount} onChange={(e) => upd({ questionCount: Math.max(0, Number(e.target.value)) })} />}</Field>
        <Field label={t("المدة بالدقائق (0 = بلا حد)", "Duration in minutes (0 = none)")}>{(i) => <Input id={i} type="number" min={0} value={quiz.durationMin} onChange={(e) => upd({ durationMin: Math.max(0, Number(e.target.value)) })} />}</Field>
        <Field label={t("درجة النجاح %", "Pass score %")}>{(i) => <Input id={i} type="number" min={0} max={100} value={quiz.passScore} onChange={(e) => upd({ passScore: Math.min(100, Math.max(0, Number(e.target.value))) })} />}</Field>
        <label className="flex items-center gap-2 self-end pb-2 text-sm font-bold"><input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={quiz.shuffle} onChange={(e) => upd({ shuffle: e.target.checked })} />{t("ترتيب عشوائي للأسئلة", "Shuffle questions")}</label>
      </section>
      <div className="space-y-3">
        {qs.map((q, i) => <QEditor key={q.id} q={q} i={i} n={qs.length} images={images} onChange={(nq) => setQ(qs.map((x) => (x.id === q.id ? nq : x)))} onMove={(d) => move(i, d)} onDelete={() => setQ(qs.filter((x) => x.id !== q.id))} />)}
        {qs.length === 0 && <EmptyState icon={<Plus />} title={t("أضف أول سؤال", "Add your first question")} />}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">{(Object.keys(labels) as QuestionType[]).map((k) => <Button key={k} onClick={() => add(k)}><Plus size={14} />{labels[k]}</Button>)}</div>
      <Modal open={gen} onClose={() => setGen(false)} title={t("إضافة أسئلة من المحتوى", "Add questions from your content")} footer={<><Button onClick={() => setGen(false)}>{t("إلغاء", "Cancel")}</Button><Button variant="primary" disabled={!genNote && !genDeck} onClick={doGen}>{t("إضافة", "Add")}</Button></>}>
        <div className="space-y-3"><p className="text-sm text-muted">{t("تُنشأ أسئلة «أكمل الفراغ» من جمل الملاحظة بإخفاء أطول كلمة. راجعها وعدّلها قبل الحفظ.", "Fill-in-the-blank questions are drafted from note sentences by hiding the longest word. Review and edit before saving.")}</p>
          <Field label={t("ملاحظة", "Note")}>{(i) => <Select id={i} value={genNote} onChange={(e) => setGenNote(e.target.value)}><option value="">—</option>{notes.map((n) => <option key={n.id} value={n.id}>{n.title || t("بدون عنوان", "Untitled")}</option>)}</Select>}</Field>
          <Field label={t("أو مجموعة بطاقات (سؤال وجواب ← إجابة قصيرة)", "Or a flashcard deck (Q&A → short answer)")}>{(i) => <Select id={i} value={genDeck} onChange={(e) => setGenDeck(e.target.value)}><option value="">—</option>{decks.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>}</Field></div>
      </Modal>
    </div>
  );
}
