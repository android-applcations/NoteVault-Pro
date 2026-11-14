import { CheckCircle2, Trophy, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import type { Flashcard } from "@/data/types";
import { formatInterval, previewIntervals, type GradeNum } from "@/domain/srs";
import { getDueCards, reviewCard } from "@/services/cards";
import { CardView } from "@/ui/CardView";
import { useI18n } from "@/ui/i18n";
import { Button, EmptyState, IconButton, ProgressBar, Skeleton } from "@/ui/kit";
import { useApp } from "@/ui/app-context";
import { cn } from "@/utils/cn";

export default function Review() {
  const { t, lang } = useI18n();
  const { toast } = useApp();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [queue, setQueue] = useState<Flashcard[] | null>(null);
  const [total, setTotal] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [counts, setCounts] = useState<Record<GradeNum, number>>({ 1: 0, 2: 0, 3: 0, 4: 0 });
  const [done, setDone] = useState(0);
  const start = useRef(Date.now());
  const busy = useRef(false);

  useEffect(() => {
    const limit = Number(params.get("limit")) || undefined;
    getDueCards({ subjectId: params.get("subject") || undefined, semesterId: params.get("semester") || undefined, deckId: params.get("deck") || undefined, limit }).then((c) => { setQueue(c); setTotal(c.length); start.current = Date.now(); });
  }, [params]);

  const card = queue?.[0];
  const preview = card ? previewIntervals(card) : null;

  const grade = useCallback(async (g: GradeNum) => {
    if (!card || busy.current) return;
    busy.current = true;
    try {
      const updated = await reviewCard(card.id, g);
      setCounts((c) => ({ ...c, [g]: c[g] + 1 }));
      setQueue((q) => {
        if (!q) return q;
        const rest = q.slice(1);
        // cards that come back within this session (learning steps) are re-queued at the end
        if (updated.due < Date.now() + 20 * 60000) rest.push(updated);
        else setDone((d) => d + 1);
        return rest;
      });
      setRevealed(false);
    } catch { toast(t("تعذر حفظ المراجعة", "Could not save the review"), "err"); } finally { busy.current = false; }
  }, [card, toast, t]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input,textarea,select")) return;
      if (!revealed && (e.key === " " || e.key === "Enter")) { e.preventDefault(); setRevealed(true); }
      else if (revealed && ["1", "2", "3", "4"].includes(e.key)) void grade(Number(e.key) as GradeNum);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [revealed, grade]);

  if (!queue) return <Skeleton className="mx-auto h-80 max-w-2xl" />;
  if (total === 0) return <EmptyState icon={<CheckCircle2 />} title={t("لا توجد بطاقات مستحقة", "No cards due")} hint={t("عد لاحقاً أو أنشئ بطاقات جديدة.", "Come back later or create new cards.")} action={<Link to="/flashcards"><Button variant="primary">{t("البطاقات", "Flashcards")}</Button></Link>} />;

  if (!card) {
    const reviewed = counts[1] + counts[2] + counts[3] + counts[4];
    const ok = counts[2] + counts[3] + counts[4];
    const mins = Math.max(1, Math.round((Date.now() - start.current) / 60000));
    return (
      <div className="mx-auto max-w-lg text-center">
        <div className="card-surface p-8"><Trophy className="mx-auto mb-3 text-warn" size={48} /><h1 className="text-2xl font-black">{t("أحسنت! انتهت الجلسة", "Session complete!")}</h1>
          <div className="my-5 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">{([[1, t("مرة أخرى", "Again"), "text-danger"], [2, t("صعب", "Hard"), "text-warn"], [3, t("جيد", "Good"), "text-success"], [4, t("سهل", "Easy"), "text-accent"]] as [GradeNum, string, string][]).map(([g, l, c]) => <div key={g} className="rounded-xl bg-surface2 p-3"><div className={cn("text-2xl font-black", c)}>{counts[g]}</div><div className="text-xs text-muted">{l}</div></div>)}</div>
          <p className="text-sm text-muted">{reviewed} {t("مراجعة", "reviews")} · {reviewed ? Math.round((ok / reviewed) * 100) : 0}% {t("نجاح", "success")} · ~{mins} {t("د", "min")}</p>
          <div className="mt-5 flex justify-center gap-2"><Link to="/flashcards"><Button>{t("إحصائيات", "Statistics")}</Button></Link><Link to="/"><Button variant="primary">{t("الرئيسية", "Home")}</Button></Link></div></div>
      </div>
    );
  }

  const btns: [GradeNum, string, string][] = [[1, t("مرة أخرى", "Again"), "bg-danger"], [2, t("صعب", "Hard"), "bg-warn"], [3, t("جيد", "Good"), "bg-success"], [4, t("سهل", "Easy"), "bg-accent"]];
  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-4 flex items-center gap-3">
        <IconButton label={t("إنهاء الجلسة", "End session")} onClick={() => nav("/flashcards")}><X size={18} /></IconButton>
        <div className="flex-1"><ProgressBar value={(done / total) * 100} /></div>
        <span className="text-sm font-bold tabular-nums" dir="ltr">{done}/{total}</span>
      </div>
      <div className="card-surface flex min-h-[22rem] flex-col justify-center p-6 sm:p-10" onClick={() => !revealed && setRevealed(true)} role="group" aria-label={t("بطاقة المراجعة", "Review card")}>
        <CardView card={card} revealed={revealed} />
      </div>
      <div className="mt-4">
        {!revealed ? (
          <Button variant="primary" className="w-full !py-3.5 text-base" onClick={() => setRevealed(true)}>{t("إظهار الإجابة", "Show answer")}</Button>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {btns.map(([g, label, cls]) => (
              <button key={g} onClick={() => void grade(g)} className={cn("rounded-2xl py-3 text-white shadow transition active:scale-95", cls)}>
                <div className="text-sm font-extrabold">{label}</div>
                <div className="text-xs opacity-90" dir="ltr">{preview ? formatInterval(preview[g], Date.now(), lang) : ""} · {g}</div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
