import { useLiveQuery } from "dexie-react-hooks";
import { BarChart3, ClipboardCheck, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { db } from "@/data/db";
import type { Quiz, QuestionType } from "@/data/types";
import { createQuiz, deleteQuiz, analyze } from "@/services/quizzes";
import { useApp } from "@/ui/app-context";
import { useI18n } from "@/ui/i18n";
import { Badge, Button, EmptyState, Modal, PageHeader, ProgressBar } from "@/ui/kit";

export const useTypeLabels = () => {
  const { t } = useI18n();
  return { mcq: t("اختيار من متعدد", "Multiple choice"), tf: t("صح / خطأ", "True / false"), short: t("إجابة قصيرة", "Short answer"), cloze: t("أكمل الفراغ", "Fill in the blank"), match: t("مطابقة", "Matching"), order: t("ترتيب خطوات", "Ordering"), image: t("سؤال بصورة", "Image question") } as Record<QuestionType, string>;
};

export default function Quizzes() {
  const { t, fmtDate } = useI18n();
  const { toast, confirm } = useApp();
  const nav = useNavigate();
  const typeLabels = useTypeLabels();
  const quizzes = useLiveQuery(() => db.quizzes.toArray(), []);
  const counts = useLiveQuery(async () => { const q = await db.quizQuestions.toArray(); const m: Record<string, number> = {}; q.forEach((x) => (m[x.quizId] = (m[x.quizId] ?? 0) + 1)); return m; }, []) ?? {};
  const attempts = useLiveQuery(() => db.quizAttempts.orderBy("finishedAt").reverse().toArray(), []) ?? [];
  const subjects = useLiveQuery(() => db.subjects.toArray(), []) ?? [];
  const [history, setHistory] = useState<Quiz | null>(null);
  const analysis = analyze(attempts);
  const create = async () => { const q = await createQuiz({ title: t("اختبار جديد", "New quiz") }); nav(`/quizzes/${q.id}/edit`); };
  const hist = attempts.filter((a) => a.quizId === history?.id);
  return (
    <div>
      <PageHeader title={t("منشئ الاختبارات", "Quiz builder")} subtitle={t("أنشئ اختبارات من ملاحظاتك واختبر نفسك دون اتصال", "Build quizzes from your notes and test yourself offline")} actions={<Button variant="primary" onClick={() => void create()}><Plus size={16} />{t("اختبار جديد", "New quiz")}</Button>} />
      {quizzes && quizzes.length === 0 ? <EmptyState icon={<ClipboardCheck />} title={t("لا توجد اختبارات", "No quizzes yet")} action={<Button variant="primary" onClick={() => void create()}>{t("إنشاء اختبار", "Create a quiz")}</Button>} /> : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {(quizzes ?? []).sort((a, b) => b.updatedAt - a.updatedAt).map((q) => {
            const at = attempts.filter((a) => a.quizId === q.id);
            const best = at.length ? Math.max(...at.map((a) => a.percent)) : null;
            const n = counts[q.id] ?? 0;
            return (
              <div key={q.id} className="card-surface p-4">
                <div className="flex items-start justify-between gap-2"><div className="min-w-0"><h3 className="truncate text-lg font-extrabold" dir="auto">{q.title}</h3><p className="text-xs text-muted">{subjects.find((s) => s.id === q.subjectId)?.name ?? "—"}</p></div>
                  <Badge>{q.mode === "exam" ? t("امتحان", "Exam") : t("تدريب", "Practice")}</Badge></div>
                <div className="mt-3 flex flex-wrap gap-1.5 text-xs"><Badge>{n} {t("سؤال", "questions")}</Badge>{q.durationMin > 0 && <Badge>{q.durationMin} {t("دقيقة", "min")}</Badge>}<Badge>{t("النجاح", "Pass")} {q.passScore}%</Badge><Badge>{at.length} {t("محاولة", "attempts")}</Badge></div>
                {best !== null && <div className="mt-3"><div className="mb-1 flex justify-between text-xs font-bold"><span>{t("أفضل نتيجة", "Best score")}</span><span>{best}%</span></div><ProgressBar value={best} /></div>}
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button variant="primary" disabled={!n} onClick={() => nav(`/quizzes/${q.id}/take`)}><Play size={15} />{t("ابدأ", "Start")}</Button>
                  <Button onClick={() => nav(`/quizzes/${q.id}/edit`)}><Pencil size={15} />{t("تعديل", "Edit")}</Button>
                  <Button onClick={() => setHistory(q)} disabled={!at.length}><BarChart3 size={15} />{t("السجل", "History")}</Button>
                  <Button variant="ghost" className="ms-auto" aria-label={t("حذف", "Delete")} onClick={async () => { if (await confirm({ title: t("حذف الاختبار ونتائجه؟", "Delete quiz and its results?"), danger: true })) { await deleteQuiz(q.id); toast(t("تم الحذف", "Deleted")); } }}><Trash2 size={15} className="text-danger" /></Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {analysis.length > 0 && (
        <section className="card-surface mt-6 p-5"><h2 className="mb-3 text-lg font-extrabold">{t("نقاط القوة والضعف", "Strengths & weaknesses")}</h2>
          <div className="space-y-2">{analysis.map((a) => <div key={a.type}><div className="mb-1 flex justify-between text-sm font-bold"><span>{typeLabels[a.type]}</span><span>{a.pct}%</span></div><ProgressBar value={a.pct} color={a.pct < 50 ? "var(--danger)" : a.pct < 75 ? "var(--warn)" : "var(--success)"} /></div>)}</div>
          <p className="mt-3 text-xs text-muted">{t("الأنواع الأضعف تظهر أولاً — ركّز عليها في المراجعة.", "Weakest types are listed first — focus your revision on them.")}</p></section>
      )}
      <Modal open={!!history} onClose={() => setHistory(null)} title={`${t("سجل المحاولات", "Attempt history")}: ${history?.title ?? ""}`}>
        <ul className="space-y-2">{hist.map((a) => <li key={a.id} className="flex items-center justify-between gap-2 rounded-xl bg-surface2 p-3 text-sm"><span>{fmtDate(a.finishedAt, { dateStyle: "medium", timeStyle: "short" })}</span><span className="font-bold">{a.score}/{a.total} · {a.percent}%</span><Badge color={a.passed ? "#15803d" : "#c42a3b"}>{a.passed ? t("ناجح", "Passed") : t("راسب", "Failed")}</Badge></li>)}</ul>
        {hist.length > 0 && <div className="mt-4 space-y-2"><h3 className="text-sm font-bold">{t("التحليل لهذا الاختبار", "Analysis for this quiz")}</h3>{analyze(hist).map((a) => <div key={a.type}><div className="mb-1 flex justify-between text-xs font-bold"><span>{typeLabels[a.type]}</span><span>{a.pct}%</span></div><ProgressBar value={a.pct} /></div>)}</div>}
      </Modal>
    </div>
  );
}
