import { useLiveQuery } from "dexie-react-hooks";
import { Layers, Pencil, Play, Plus, Trash2, Zap, Settings2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { db } from "@/data/db";
import type { Flashcard } from "@/data/types";
import { normalize } from "@/domain/text";
import { createDeck, deleteCard, deleteDeck, getReviewStats, updateDeck } from "@/services/cards";
import { useApp } from "@/ui/app-context";
import { CardEditor } from "@/ui/CardEditor";
import { FormulaText } from "@/ui/FormulaView";
import { useI18n } from "@/ui/i18n";
import { Badge, Button, EmptyState, Field, Input, Modal, PageHeader, Select } from "@/ui/kit";
import { Tabs, useIncremental, useSubjects } from "@/ui/shared";

export default function Flashcards() {
  const { t, fmtDate, fmtNum } = useI18n();
  const { toast, confirm, openCard } = useApp();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const subjects = useSubjects(true);
  const semesters = useLiveQuery(() => db.semesters.toArray(), []) ?? [];
  const decks = useLiveQuery(() => db.flashcardDecks.toArray(), []) ?? [];
  const cards = useLiveQuery(() => db.flashcards.toArray(), []);
  const stats = useLiveQuery(() => getReviewStats(14), [cards?.length]);
  const [tab, setTab] = useState<"review" | "cards" | "decks" | "stats">("review");
  const [edit, setEdit] = useState<Flashcard | undefined>();
  const [deckModal, setDeckModal] = useState<{ id?: string; name: string; subjectId: string } | null>(null);
  const [q, setQ] = useState("");
  const [deckFilter, setDeckFilter] = useState("");
  const [subj, setSubj] = useState("");
  const [sem, setSem] = useState("");
  const [custom, setCustom] = useState(20);
  const now = Date.now();
  const due = (cards ?? []).filter((c) => c.due <= now).length;

  useEffect(() => {
    const id = params.get("card");
    if (id && cards) { const c = cards.find((x) => x.id === id); if (c) { setTab("cards"); setEdit(c); } params.delete("card"); setParams(params, { replace: true }); }
  }, [params, cards, setParams]);

  const startReview = (o: Record<string, string | number | undefined>) => {
    const sp = new URLSearchParams();
    Object.entries(o).forEach(([k, v]) => v && sp.set(k, String(v)));
    nav(`/flashcards/review?${sp.toString()}`);
  };
  const dueCount = (f: (c: Flashcard) => boolean) => (cards ?? []).filter((c) => c.due <= now && f(c)).length;
  const nq = normalize(q);
  const list = (cards ?? []).filter((c) => (!deckFilter || c.deckId === deckFilter)).filter((c) => !nq || normalize(c.front + " " + c.back).includes(nq)).sort((a, b) => b.updatedAt - a.updatedAt);
  const { shown, sentinel } = useIncremental(list, 40);
  const deckName = new Map(decks.map((d) => [d.id, d.name]));
  const max = Math.max(1, ...(stats?.days.map((d) => d.count) ?? [1]));
  const states = [t("جديدة", "New"), t("تعلّم", "Learning"), t("مراجعة", "Review"), t("إعادة تعلّم", "Relearning")];

  return (
    <div>
      <PageHeader title={t("استوديو البطاقات", "Flashcards studio")} subtitle={t("مراجعة متباعدة بخوارزمية FSRS تعمل دون اتصال", "Spaced repetition with the FSRS algorithm — works offline")}
        actions={<><Button onClick={() => setDeckModal({ name: "", subjectId: "" })}><Plus size={16} />{t("مجموعة", "Deck")}</Button><Button variant="primary" onClick={() => openCard()}><Plus size={16} />{t("بطاقة", "Card")}</Button></>} />
      <Tabs value={tab} onChange={setTab} items={[{ id: "review", label: t("المراجعة", "Review"), badge: due }, { id: "cards", label: t("البطاقات", "Cards"), badge: cards?.length }, { id: "decks", label: t("المجموعات", "Decks"), badge: decks.length }, { id: "stats", label: t("الإحصائيات", "Statistics") }]} />

      {tab === "review" && (
        <div className="space-y-4">
          <div className="card-surface flex flex-wrap items-center justify-between gap-3 p-5">
            <div><div className="text-4xl font-black text-accent">{fmtNum(due)}</div><div className="text-sm font-bold text-muted">{t("بطاقة مستحقة الآن", "cards due now")}</div></div>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" disabled={!due} onClick={() => startReview({})}><Play size={16} />{t("مراجعة المستحقة", "Review all due")}</Button>
              <Button disabled={!due} onClick={() => startReview({ limit: 10 })}><Zap size={16} />{t("جلسة سريعة (10)", "Quick session (10)")}</Button>
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="card-surface space-y-2 p-4"><h3 className="font-extrabold">{t("حسب المادة", "By subject")}</h3>
              <Select aria-label={t("المادة", "Subject")} value={subj} onChange={(e) => setSubj(e.target.value)}><option value="">—</option>{subjects.map((s) => <option key={s.id} value={s.id}>{s.name} ({dueCount((c) => c.subjectId === s.id)})</option>)}</Select>
              <Button className="w-full" disabled={!subj || !dueCount((c) => c.subjectId === subj)} onClick={() => startReview({ subject: subj })}>{t("ابدأ", "Start")}</Button></div>
            <div className="card-surface space-y-2 p-4"><h3 className="font-extrabold">{t("حسب الفصل", "By semester")}</h3>
              <Select aria-label={t("الفصل", "Semester")} value={sem} onChange={(e) => setSem(e.target.value)}><option value="">—</option>{semesters.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
              <Button className="w-full" disabled={!sem} onClick={() => startReview({ semester: sem })}>{t("ابدأ", "Start")}</Button></div>
            <div className="card-surface space-y-2 p-4"><h3 className="flex items-center gap-2 font-extrabold"><Settings2 size={15} />{t("جلسة مخصصة", "Custom session")}</h3>
              <div className="grid grid-cols-2 gap-2"><Select aria-label={t("المجموعة", "Deck")} value={deckFilter} onChange={(e) => setDeckFilter(e.target.value)}><option value="">{t("كل المجموعات", "All decks")}</option>{decks.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>
                <Input aria-label={t("عدد البطاقات", "Number of cards")} type="number" min={1} max={500} value={custom} onChange={(e) => setCustom(Number(e.target.value))} /></div>
              <Button className="w-full" onClick={() => startReview({ deck: deckFilter, limit: custom })} disabled={!due}>{t("ابدأ", "Start")}</Button></div>
          </div>
          {cards && cards.length === 0 && <EmptyState icon={<Layers />} title={t("لا توجد بطاقات بعد", "No cards yet")} hint={t("حدّد نصاً في أي ملاحظة أو صفحة PDF لإنشاء بطاقة، أو أنشئ واحدة يدوياً.", "Select text in any note or PDF page to create a card, or create one manually.")} action={<Button variant="primary" onClick={() => openCard()}>{t("بطاقة جديدة", "New card")}</Button>} />}
        </div>
      )}

      {tab === "cards" && (
        <div>
          <div className="mb-3 grid gap-2 sm:grid-cols-[1fr_14rem]"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("بحث في البطاقات…", "Search cards…")} aria-label={t("بحث في البطاقات", "Search cards")} dir="auto" />
            <Select aria-label={t("المجموعة", "Deck")} value={deckFilter} onChange={(e) => setDeckFilter(e.target.value)}><option value="">{t("كل المجموعات", "All decks")}</option>{decks.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select></div>
          {cards && list.length === 0 ? <EmptyState icon={<Layers />} title={t("لا توجد بطاقات", "No cards")} /> : (
            <div className="grid gap-2 md:grid-cols-2">{shown.map((c) => (
              <div key={c.id} className="card-surface p-3">
                <div className="flex items-start gap-2"><div className="min-w-0 flex-1"><div className="line-clamp-2 font-bold" dir="auto"><FormulaText text={c.front || "—"} /></div><div className="line-clamp-1 text-sm text-muted" dir="auto"><FormulaText text={c.back} /></div></div>
                  <Button variant="ghost" className="!px-2" aria-label={t("تعديل", "Edit")} onClick={() => setEdit(c)}><Pencil size={15} /></Button>
                  <Button variant="ghost" className="!px-2" aria-label={t("حذف", "Delete")} onClick={async () => { if (await confirm({ title: t("حذف البطاقة؟", "Delete this card?"), message: t("سيُحذف سجل مراجعتها أيضاً.", "Its review history is deleted too."), danger: true })) { await deleteCard(c.id); toast(t("تم الحذف", "Deleted")); } }}><Trash2 size={15} className="text-danger" /></Button></div>
                <div className="mt-2 flex flex-wrap gap-1.5 text-xs"><Badge>{deckName.get(c.deckId)}</Badge><Badge>{states[c.state]}</Badge><Badge color="#15803d">✓ {c.successCount}</Badge><Badge color="#c42a3b">✗ {c.failCount}</Badge><span className="text-muted">{t("القادمة", "Next")}: {fmtDate(c.due, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span></div>
              </div>))}</div>
          )}
          {sentinel}
        </div>
      )}

      {tab === "decks" && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {decks.map((d) => {
            const dc = (cards ?? []).filter((c) => c.deckId === d.id);
            const dd = dc.filter((c) => c.due <= now).length;
            return (
              <div key={d.id} className="card-surface p-4"><div className="flex items-start justify-between gap-2"><h3 className="font-extrabold" dir="auto">{d.name}</h3>
                <div className="flex"><Button variant="ghost" className="!px-2" aria-label={t("تعديل", "Edit")} onClick={() => setDeckModal({ id: d.id, name: d.name, subjectId: d.subjectId ?? "" })}><Pencil size={15} /></Button>
                  <Button variant="ghost" className="!px-2" aria-label={t("حذف", "Delete")} onClick={async () => { if (await confirm({ title: t("حذف المجموعة وبطاقاتها؟", "Delete deck and its cards?"), danger: true })) await deleteDeck(d.id); }}><Trash2 size={15} className="text-danger" /></Button></div></div>
                <p className="text-xs text-muted">{subjects.find((s) => s.id === d.subjectId)?.name ?? "—"}</p>
                <div className="mt-3 flex items-center gap-2 text-sm"><Badge>{dc.length} {t("بطاقة", "cards")}</Badge><Badge color="#0b8579">{dd} {t("مستحقة", "due")}</Badge><Button className="ms-auto !min-h-8 !py-1" disabled={!dd} onClick={() => startReview({ deck: d.id })}><Play size={13} />{t("مراجعة", "Review")}</Button></div></div>
            );
          })}
          {decks.length === 0 && <div className="sm:col-span-2 lg:col-span-3"><EmptyState icon={<Layers />} title={t("لا توجد مجموعات", "No decks")} /></div>}
        </div>
      )}

      {tab === "stats" && stats && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            {[[t("البطاقات", "Cards"), stats.totalCards], [t("مستحقة", "Due"), stats.due], [t("جديدة", "New"), stats.newCards], [t("في المراجعة", "In review"), stats.learned], [t("مرات المراجعة", "Reviews"), stats.totalReviews], [t("نسبة التذكر", "Retention"), `${stats.retention}%`]].map(([l, v]) => <div key={l as string} className="card-surface p-4 text-center"><div className="text-2xl font-black">{typeof v === "number" ? fmtNum(v) : v}</div><div className="text-xs font-bold text-muted">{l}</div></div>)}
          </div>
          <div className="card-surface p-5"><h3 className="mb-4 font-extrabold">{t("المراجعات في آخر 14 يوماً", "Reviews in the last 14 days")}</h3>
            <div className="flex h-40 items-end gap-1.5" role="img" aria-label={t("رسم بياني للمراجعات", "Review chart")}>
              {stats.days.map((d) => <div key={d.date} className="flex flex-1 flex-col items-center gap-1"><div className="flex w-full flex-1 items-end"><div className="w-full rounded-t-lg bg-accent/30" style={{ height: `${(d.count / max) * 100}%`, minHeight: d.count ? 4 : 0 }}><div className="w-full rounded-t-lg bg-accent" style={{ height: `${d.count ? (d.correct / d.count) * 100 : 0}%` }} /></div></div><span className="text-[10px] text-muted" dir="ltr">{d.date.slice(8)}</span></div>)}
            </div></div>
          <p className="text-xs text-muted">{t(`جلسات المراجعة: ${stats.sessions}`, `Review sessions: ${stats.sessions}`)}</p>
        </div>
      )}

      <CardEditor open={!!edit} card={edit} onClose={() => setEdit(undefined)} />
      <Modal open={!!deckModal} onClose={() => setDeckModal(null)} title={deckModal?.id ? t("تعديل المجموعة", "Edit deck") : t("مجموعة جديدة", "New deck")} footer={<><Button onClick={() => setDeckModal(null)}>{t("إلغاء", "Cancel")}</Button><Button variant="primary" onClick={async () => { if (!deckModal) return; try { if (deckModal.id) await updateDeck(deckModal.id, { name: deckModal.name, subjectId: deckModal.subjectId || undefined }); else await createDeck({ name: deckModal.name, subjectId: deckModal.subjectId || undefined }); setDeckModal(null); } catch { toast(t("أدخل اسماً", "Enter a name"), "err"); } }}>{t("حفظ", "Save")}</Button></>}>
        <div className="space-y-3"><Field label={t("الاسم", "Name")}>{(id) => <Input id={id} value={deckModal?.name ?? ""} onChange={(e) => deckModal && setDeckModal({ ...deckModal, name: e.target.value })} dir="auto" />}</Field>
          <Field label={t("المادة", "Subject")}>{(id) => <Select id={id} value={deckModal?.subjectId ?? ""} onChange={(e) => deckModal && setDeckModal({ ...deckModal, subjectId: e.target.value })}><option value="">—</option>{subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}</Field></div>
      </Modal>
    </div>
  );
}
