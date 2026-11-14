import { useLiveQuery } from "dexie-react-hooks";
import { ChevronLeft, ChevronRight, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { db } from "@/data/db";
import { todayISO } from "@/domain/text";
import { createEvent, deleteEvent } from "@/services/library";
import { getCalendarItems, type CalendarItem } from "@/services/stats";
import { useApp } from "@/ui/app-context";
import { useI18n } from "@/ui/i18n";
import { Badge, Button, Field, IconButton, Input, Modal, PageHeader, Select } from "@/ui/kit";
import { useSubjects } from "@/ui/shared";
import { cn } from "@/utils/cn";

type View = "month" | "week" | "day";
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

export default function CalendarPage() {
  const { t, lang, fmtDate } = useI18n();
  const { toast, confirm } = useApp();
  const subjects = useSubjects(true);
  const [view, setView] = useState<View>("month");
  const [cursor, setCursor] = useState(() => new Date());
  const [selected, setSelected] = useState(todayISO());
  const [form, setForm] = useState<{ title: string; date: string; subjectId: string } | null>(null);
  const weekStart = lang === "ar" ? 6 : 0;

  const days = useMemo(() => {
    const c = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate());
    if (view === "day") return [c];
    if (view === "week") { const off = (c.getDay() - weekStart + 7) % 7; const s = addDays(c, -off); return Array.from({ length: 7 }, (_, i) => addDays(s, i)); }
    const first = new Date(c.getFullYear(), c.getMonth(), 1);
    const s = addDays(first, -((first.getDay() - weekStart + 7) % 7));
    return Array.from({ length: 42 }, (_, i) => addDays(s, i));
  }, [cursor, view, weekStart]);
  const from = todayISO(days[0]);
  const to = todayISO(days[days.length - 1]);
  const events = useLiveQuery(() => db.events.toArray(), []);
  const items = useLiveQuery(() => getCalendarItems(from, to), [from, to, events?.length]) ?? [];
  const byDay = useMemo(() => { const m = new Map<string, CalendarItem[]>(); items.forEach((i) => m.set(i.date, [...(m.get(i.date) ?? []), i])); return m; }, [items]);
  const nav = (dir: -1 | 1) => setCursor((c) => (view === "month" ? new Date(c.getFullYear(), c.getMonth() + dir, 1) : addDays(c, dir * (view === "week" ? 7 : 1))));
  const title = view === "month" ? fmtDate(cursor.getTime(), { month: "long", year: "numeric" }) : view === "week" ? `${fmtDate(days[0].getTime(), { month: "short", day: "numeric" })} – ${fmtDate(days[6].getTime(), { month: "short", day: "numeric", year: "numeric" })}` : fmtDate(cursor.getTime(), { dateStyle: "full" });
  const dayNames = Array.from({ length: 7 }, (_, i) => fmtDate(days[i % days.length === 0 ? 0 : i].getTime(), { weekday: "short" }));
  const monthDays = view === "month";
  const names = monthDays || view === "week" ? days.slice(0, 7).map((d) => fmtDate(d.getTime(), { weekday: "short" })) : dayNames.slice(0, 1);
  const kindLabel = { lecture: t("محاضرة", "Lecture"), review: t("مراجعة مستحقة", "Reviews due"), exam: t("امتحان", "Exam"), note: t("ملاحظات معدّلة", "Notes edited") };
  const dotColor = (i: CalendarItem) => (i.kind === "exam" ? "var(--danger)" : i.kind === "review" ? "var(--accent)" : i.kind === "note" ? "var(--muted)" : i.color ?? "var(--primary)");
  const selItems = byDay.get(selected) ?? [];
  const save = async () => { if (!form) return; try { await createEvent({ title: form.title, date: form.date, type: "exam", subjectId: form.subjectId || undefined }); setForm(null); toast(t("تمت إضافة الموعد", "Event added")); } catch { toast(t("أدخل عنواناً وتاريخاً", "Enter a title and date"), "err"); } };

  return (
    <div>
      <PageHeader title={t("التقويم الدراسي", "Study calendar")} subtitle={t("المحاضرات ومواعيد المراجعة والامتحانات في مكان واحد", "Lectures, review dates and exams in one place")} actions={<Button variant="primary" onClick={() => setForm({ title: "", date: selected, subjectId: "" })}><Plus size={16} />{t("موعد امتحان", "Add exam")}</Button>} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <IconButton label={t("السابق", "Previous")} onClick={() => nav(-1)}><ChevronRight size={18} className="ltr:rotate-180" /></IconButton>
        <h2 className="min-w-0 flex-1 text-center text-base font-extrabold sm:min-w-40 sm:flex-none sm:text-lg">{title}</h2>
        <IconButton label={t("التالي", "Next")} onClick={() => nav(1)}><ChevronLeft size={18} className="ltr:rotate-180" /></IconButton>
        <Button onClick={() => { setCursor(new Date()); setSelected(todayISO()); }}>{t("اليوم", "Today")}</Button>
        <div className="ms-auto flex rounded-xl bg-surface2 p-1" role="group" aria-label={t("العرض", "View")}>{(["month", "week", "day"] as View[]).map((v) => <button key={v} aria-pressed={view === v} onClick={() => setView(v)} className={cn("rounded-lg px-2.5 py-1.5 text-xs font-bold sm:px-3", view === v ? "bg-surface shadow" : "text-muted")}>{v === "month" ? t("شهر", "Month") : v === "week" ? t("أسبوع", "Week") : t("يوم", "Day")}</button>)}</div>
      </div>
      <div className="mb-3 flex flex-wrap gap-3 text-xs font-bold text-muted">{(["lecture", "review", "exam", "note"] as const).map((k) => <span key={k} className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: dotColor({ kind: k } as CalendarItem) }} />{kindLabel[k]}</span>)}</div>

      {view !== "day" && (
        <div className="card-surface overflow-hidden">
          <div className="grid grid-cols-7 border-b border-line bg-surface2 text-center text-[11px] font-bold text-muted sm:text-xs">{names.map((n, i) => <div key={i} className="min-w-0 truncate px-0.5 py-2">{n}</div>)}</div>
          <div className="grid grid-cols-7">
            {days.map((d) => {
              const k = todayISO(d); const its = byDay.get(k) ?? []; const out = view === "month" && d.getMonth() !== cursor.getMonth();
              return (
                <button key={k} onClick={() => setSelected(k)} aria-label={`${fmtDate(d.getTime(), { dateStyle: "full" })}, ${its.length}`} aria-pressed={selected === k}
                  className={cn("min-h-14 min-w-0 border-b border-e border-line p-1 text-start align-top transition hover:bg-surface2 sm:min-h-24 sm:p-1.5", out && "opacity-40", selected === k && "bg-accent/10", view === "week" && "min-h-36 sm:min-h-40")}>
                  <span className={cn("inline-flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold sm:text-xs", k === todayISO() && "bg-primary text-primary-fg")}>{d.getDate()}</span>
                  <div className="mt-1 space-y-0.5">{its.slice(0, view === "week" ? 8 : 3).map((i) => <div key={i.id} className="flex items-center gap-1 truncate text-[10px] font-semibold sm:text-[11px]"><span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: dotColor(i) }} /><span className="hidden truncate sm:inline">{i.count ? `${i.count} ${kindLabel[i.kind]}` : i.label}</span></div>)}{its.length > 3 && view === "month" && <div className="text-[10px] text-muted">+{its.length - 3}</div>}</div>
                </button>
              );
            })}
          </div>
        </div>
      )}
      <section className="card-surface mt-4 p-5" aria-live="polite">
        <h3 className="mb-3 font-extrabold">{fmtDate(selected, { dateStyle: "full" })}</h3>
        {selItems.length === 0 ? <p className="text-sm text-muted">{t("لا توجد أنشطة في هذا اليوم", "Nothing scheduled for this day")}</p> : (
          <ul className="space-y-2">{selItems.map((i) => (
            <li key={i.id} className="flex items-center gap-3 rounded-xl bg-surface2 p-3 text-sm"><span className="h-3 w-3 rounded-full" style={{ background: dotColor(i) }} /><Badge>{kindLabel[i.kind]}</Badge>
              {i.href ? <Link to={i.href} className="min-w-0 flex-1 truncate font-bold hover:text-accent" dir="auto">{i.count ? `${i.count}` : i.label}</Link> : <span className="min-w-0 flex-1 truncate font-bold" dir="auto">{i.label}</span>}
              {i.kind === "exam" && <IconButton label={t("حذف الموعد", "Delete event")} onClick={async () => { if (await confirm({ title: t("حذف الموعد؟", "Delete this event?"), danger: true })) await deleteEvent(i.id.slice(1)); }}><Trash2 size={15} className="text-danger" /></IconButton>}</li>))}</ul>
        )}
      </section>
      <Modal open={!!form} onClose={() => setForm(null)} title={t("موعد امتحان", "Exam date")} footer={<><Button onClick={() => setForm(null)}>{t("إلغاء", "Cancel")}</Button><Button variant="primary" onClick={() => void save()}>{t("إضافة", "Add")}</Button></>}>
        {form && <div className="space-y-3"><Field label={t("العنوان", "Title")}>{(id) => <Input id={id} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} dir="auto" />}</Field>
          <Field label={t("التاريخ", "Date")}>{(id) => <Input id={id} type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />}</Field>
          <Field label={t("المادة", "Subject")}>{(id) => <Select id={id} value={form.subjectId} onChange={(e) => setForm({ ...form, subjectId: e.target.value })}><option value="">—</option>{subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}</Field></div>}
      </Modal>
    </div>
  );
}
