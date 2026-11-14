import { useLiveQuery } from "dexie-react-hooks";
import { Archive, ArrowRight, CalendarDays, Copy, FilePlus2, Layers, LayoutGrid, List, Mic, Move, Pencil, Pin, Plus, Rows3, Trash2, GitCommitHorizontal } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { db } from "@/data/db";
import type { Lecture } from "@/data/types";
import { safeCssColor, safeDataImageUrl } from "@/domain/sanitize";
import { softDelete } from "@/services/core";
import { addWeek, duplicateLecture, getSubjectStats, moveLecture, renameWeek, updateLecture } from "@/services/library";
import { ActionMenu } from "@/ui/ActionMenu";
import { useApp } from "@/ui/app-context";
import { AttachmentCard, AttachmentEditModal } from "@/ui/Files";
import { useI18n } from "@/ui/i18n";
import { LectureForm, useStatusLabels } from "@/ui/LectureForm";
import { Badge, Button, EmptyState, Field, IconButton, Input, Modal, ProgressBar } from "@/ui/kit";
import { NewNoteModal } from "@/ui/NewNoteModal";
import { Chip, Tabs, UploadZone, relTime } from "@/ui/shared";
import type { Attachment } from "@/data/types";
import { SubjectForm } from "./Subjects";

type View = "week" | "list" | "cards" | "timeline";

function LectureItem({ l, view, onEdit, onMove }: { l: Lecture; view: View; onEdit: (l: Lecture) => void; onMove: (l: Lecture) => void }) {
  const { t, fmtDate } = useI18n();
  const { toast, confirm } = useApp();
  const nav = useNavigate();
  const statuses = useStatusLabels();
  const notes = useLiveQuery(() => db.notes.where("lectureId").equals(l.id).filter((n) => !n.deletedAt).count(), [l.id]) ?? 0;
  const files = useLiveQuery(() => db.attachments.where("lectureId").equals(l.id).filter((a) => !a.deletedAt).count(), [l.id]) ?? 0;
  const menu = (
    <ActionMenu items={[
      { label: t("تعديل", "Edit"), icon: <Pencil size={15} />, onClick: () => onEdit(l) },
      { label: t("تكرار", "Duplicate"), icon: <Copy size={15} />, onClick: async () => { await duplicateLecture(l.id); toast(t("تم التكرار", "Duplicated")); } },
      { label: t("نقل إلى أسبوع آخر", "Move to another week"), icon: <Move size={15} />, onClick: () => onMove(l) },
      { label: l.archived ? t("إلغاء الأرشفة", "Unarchive") : t("أرشفة", "Archive"), icon: <Archive size={15} />, onClick: async () => { await updateLecture(l.id, { archived: !l.archived }); } },
      { label: t("حذف", "Delete"), icon: <Trash2 size={15} />, danger: true, onClick: async () => {
        if (await confirm({ title: t("حذف المحاضرة؟", "Delete this lecture?"), message: t("ستنتقل مع ملاحظاتها وملفاتها إلى سلة المحذوفات.", "It moves with its notes and files to the trash."), danger: true })) { await softDelete("lecture", l.id); toast(t("تم النقل إلى سلة المحذوفات", "Moved to trash")); }
      } },
    ]} />
  );
  const body = (
    <button onClick={() => nav(`/lectures/${l.id}`)} className="min-w-0 flex-1 text-start">
      <div className="flex flex-wrap items-center gap-2"><span className="truncate font-extrabold" dir="auto">{l.title}</span>{l.archived && <Badge>{t("مؤرشفة", "Archived")}</Badge>}</div>
      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted"><CalendarDays size={12} />{fmtDate(l.date)}<Badge color={l.reviewStatus === "mastered" ? "#15803d" : l.reviewStatus === "reviewing" ? "#b45309" : undefined}>{statuses[l.reviewStatus]}</Badge><span>{notes} {t("ملاحظة", "notes")}</span><span>{files} {t("ملف", "files")}</span></div>
      {view === "cards" && l.description && <p className="mt-2 line-clamp-2 text-sm text-muted" dir="auto">{l.description}</p>}
      <div className="mt-2 max-w-xs"><ProgressBar value={l.progress} /></div>
    </button>
  );
  return (
    <div className={`card-surface flex items-start gap-2 ${view === "cards" ? "p-4" : "p-3"} ${l.archived ? "opacity-60" : ""}`}>
      {body}
      <IconButton
        label={t("تسجيل صوتي للمحاضرة", "Record lecture audio")}
        onClick={() => nav(`/lectures/${l.id}?record=1`)}
        className="text-accent hover:bg-accent/15"
      >
        <Mic size={15} />
      </IconButton>
      {menu}
    </div>
  );
}

export default function SubjectPage() {
  const { id = "" } = useParams();
  const { t, lang, fmtNum, fmtDate } = useI18n();
  const { toast, openCard } = useApp();
  const nav = useNavigate();
  const subject = useLiveQuery(() => db.subjects.get(id), [id]);
  const stats = useLiveQuery(() => getSubjectStats(id), [id]);
  const lectures = useLiveQuery(() => db.lectures.where("subjectId").equals(id).filter((l) => !l.deletedAt).toArray(), [id]) ?? [];
  const notes = useLiveQuery(() => db.notes.where("subjectId").equals(id).filter((n) => !n.deletedAt && !n.archived).toArray(), [id]) ?? [];
  const files = useLiveQuery(() => db.attachments.where("subjectId").equals(id).filter((a) => !a.deletedAt).toArray(), [id]) ?? [];
  const cards = useLiveQuery(() => db.flashcards.where("subjectId").equals(id).toArray(), [id]) ?? [];
  const [tab, setTab] = useState<"lectures" | "notes" | "files" | "cards">("lectures");
  const [view, setView] = useState<View>("week");
  const [sort, setSort] = useState<"date" | "updated">("date");
  const [showArchived, setShowArchived] = useState(false);
  const [lecForm, setLecForm] = useState<{ open: boolean; lecture?: Lecture; week?: number }>({ open: false });
  const [moving, setMoving] = useState<Lecture | null>(null);
  const [moveWeek, setMoveWeek] = useState(1);
  const [editSubject, setEditSubject] = useState(false);
  const [newNote, setNewNote] = useState(false);
  const [editFile, setEditFile] = useState<Attachment | null>(null);
  const [weekEdit, setWeekEdit] = useState<{ n: number; label: string } | null>(null);

  const visible = useMemo(() => {
    const l = lectures.filter((x) => showArchived || !x.archived);
    return l.sort((a, b) => (sort === "date" ? a.date.localeCompare(b.date) || a.updatedAt - b.updatedAt : b.updatedAt - a.updatedAt));
  }, [lectures, sort, showArchived]);

  if (subject === undefined) return null;
  if (!subject || subject.deletedAt) return <EmptyState icon={<Layers />} title={t("المادة غير موجودة", "Subject not found")} action={<Link to="/subjects"><Button>{t("العودة", "Back")}</Button></Link>} />;

  const weekLabel = (n: number) => subject.weeks.find((w) => w.n === n)?.label || t(`الأسبوع ${n}`, `Week ${n}`);
  const weekNums = Array.from(new Set([...subject.weeks.map((w) => w.n), ...lectures.map((l) => l.week)])).sort((a, b) => a - b);
  const item = (l: Lecture, v: View) => <LectureItem key={l.id} l={l} view={v} onEdit={(lecture) => setLecForm({ open: true, lecture })} onMove={(lec) => { setMoving(lec); setMoveWeek(lec.week); }} />;
  const recentNotes = [...notes].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5);
  const coverUrl = safeDataImageUrl(subject.cover);
  const safeColor = safeCssColor(subject.color);

  return (
    <div>
      <Link to="/subjects" className="mb-3 inline-flex items-center gap-1 text-sm font-bold text-muted hover:text-fg"><ArrowRight size={14} className="ltr:rotate-180" />{t("المواد", "Subjects")}</Link>
      <div className="card-surface mb-5 overflow-hidden">
        <div className="relative h-28 sm:h-36" style={{ background: coverUrl ? `url(${coverUrl}) center/cover` : `linear-gradient(135deg, ${safeColor}, ${safeColor}66)` }}>
          <div className="absolute end-3 top-3"><Button onClick={() => setEditSubject(true)}><Pencil size={15} />{t("تعديل", "Edit")}</Button></div>
        </div>
        <div className="p-5">
          <div className="flex flex-wrap items-center gap-2"><h1 className="text-2xl font-black" dir="auto">{subject.name}</h1>{subject.code && <Badge color={subject.color}>{subject.code}</Badge>}{subject.archived && <Badge>{t("مؤرشفة", "Archived")}</Badge>}</div>
          {subject.description && <p className="mt-1 text-sm text-muted" dir="auto">{subject.description}</p>}
          <p className="mt-1 text-xs text-muted">{[subject.teacher, subject.credits ? `${subject.credits} ${t("ساعات", "credits")}` : ""].filter(Boolean).join(" · ")}</p>
          <div className="mt-4 grid grid-cols-2 gap-2 min-[380px]:grid-cols-3 md:grid-cols-6">
            {[[t("محاضرات", "Lectures"), stats?.lectures], [t("ملاحظات", "Notes"), stats?.notes], [t("ملفات", "Files"), stats?.files], [t("بطاقات", "Cards"), stats?.cards], [t("الإكمال", "Completion"), `${stats?.completion ?? 0}%`], [t("آخر نشاط", "Last activity"), stats?.lastActivity ? relTime(stats.lastActivity, lang) : "—"]].map(([l, v]) => (
              <div key={l as string} className="rounded-xl bg-surface2 p-2.5 text-center"><div className="truncate text-lg font-black">{typeof v === "number" ? fmtNum(v) : v ?? "…"}</div><div className="text-xs text-muted">{l}</div></div>
            ))}
          </div>
          <div className="mt-3"><ProgressBar value={stats?.completion ?? 0} color={subject.color} /></div>
        </div>
      </div>

      <Tabs value={tab} onChange={setTab} items={[
        { id: "lectures", label: t("المحاضرات", "Lectures"), badge: lectures.length }, { id: "notes", label: t("الملاحظات", "Notes"), badge: notes.length },
        { id: "files", label: t("الملفات", "Files"), badge: files.length }, { id: "cards", label: t("البطاقات", "Cards"), badge: cards.length },
      ]} />

      {tab === "lectures" && (
        <div>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap rounded-xl bg-surface2 p-1" role="group" aria-label={t("طريقة العرض", "View mode")}>
              {([["week", Rows3, t("أسبوعي", "Weekly")], ["list", List, t("قائمة", "List")], ["cards", LayoutGrid, t("بطاقات", "Cards")], ["timeline", GitCommitHorizontal, t("زمني", "Timeline")]] as const).map(([v, Icon, label]) => (
                <button key={v} onClick={() => setView(v)} aria-pressed={view === v} className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold ${view === v ? "bg-surface shadow" : "text-muted"}`}><Icon size={14} />{label}</button>
              ))}
            </div>
            <Chip active={sort === "date"} onClick={() => setSort("date")}>{t("حسب التاريخ", "By date")}</Chip>
            <Chip active={sort === "updated"} onClick={() => setSort("updated")}>{t("حسب آخر تحديث", "By last update")}</Chip>
            <Chip active={showArchived} onClick={() => setShowArchived((v) => !v)}>{t("المؤرشفة", "Archived")}</Chip>
            <div className="ms-auto flex flex-wrap gap-2">
              <Button onClick={() => nav(`/record?subjectId=${id}`)}><Mic size={15} />{t("تسجيل صوتي", "Record audio")}</Button>
              <Button onClick={async () => { const n = await addWeek(id); toast(t(`أُضيف الأسبوع ${n}`, `Week ${n} added`)); }}><Plus size={15} />{t("أسبوع", "Week")}</Button>
              <Button variant="primary" onClick={() => setLecForm({ open: true })}><Plus size={15} />{t("محاضرة", "Lecture")}</Button>
            </div>
          </div>
          {visible.length === 0 && weekNums.length === 0 && <EmptyState icon={<CalendarDays />} title={t("لا توجد محاضرات", "No lectures yet")} action={<Button variant="primary" onClick={() => setLecForm({ open: true })}><Plus size={16} />{t("إضافة محاضرة", "Add a lecture")}</Button>} />}
          {view === "week" && (
            <div className="space-y-5">
              {weekNums.map((n) => {
                const inWeek = visible.filter((l) => l.week === n);
                return (
                  <section key={n} aria-label={weekLabel(n)}>
                    <div className="mb-2 flex items-center gap-2">
                      <h2 className="text-base font-extrabold">{weekLabel(n)}</h2><Badge>{inWeek.length}</Badge>
                      <button className="rounded-lg p-1 text-muted hover:bg-surface2" aria-label={t("إعادة تسمية الأسبوع", "Rename week")} onClick={() => setWeekEdit({ n, label: subject.weeks.find((w) => w.n === n)?.label ?? "" })}><Pencil size={13} /></button>
                      <Button variant="ghost" className="ms-auto !min-h-8 !py-1 text-xs" onClick={() => setLecForm({ open: true, week: n })}><Plus size={13} />{t("محاضرة", "Lecture")}</Button>
                    </div>
                    <div className="grid gap-2 md:grid-cols-2">{inWeek.map((l) => item(l, "week"))}{inWeek.length === 0 && <p className="rounded-xl border border-dashed border-line p-3 text-sm text-muted">{t("أسبوع فارغ", "Empty week")}</p>}</div>
                  </section>
                );
              })}
            </div>
          )}
          {view === "list" && <div className="space-y-2">{visible.map((l) => item(l, "list"))}</div>}
          {view === "cards" && <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{visible.map((l) => item(l, "cards"))}</div>}
          {view === "timeline" && (
            <ol className="relative ms-3 space-y-4 border-s-2 border-line ps-6">
              {[...visible].sort((a, b) => a.date.localeCompare(b.date)).map((l) => (
                <li key={l.id} className="relative"><span className="absolute -start-[31px] top-4 h-3 w-3 rounded-full border-2 border-bg" style={{ background: safeColor }} /><div className="mb-1 text-xs font-bold text-muted">{fmtDate(l.date, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</div>{item(l, "timeline")}</li>
              ))}
            </ol>
          )}
          {recentNotes.length > 0 && (
            <div className="mt-8"><h2 className="mb-2 text-base font-extrabold">{t("الملاحظات الحديثة", "Recent notes")}</h2>
              <div className="grid gap-2 sm:grid-cols-2">{recentNotes.map((n) => <Link key={n.id} to={`/notes/${n.id}`} className="card-surface p-3 hover:border-accent"><div className="truncate font-bold" dir="auto">{n.title || t("بدون عنوان", "Untitled")}</div><div className="truncate text-xs text-muted" dir="auto">{n.text.slice(0, 80)}</div></Link>)}</div></div>
          )}
          {files.length > 0 && (
            <div className="mt-8"><h2 className="mb-2 text-base font-extrabold">{t("الملفات الحديثة", "Recent files")}</h2>
              <div className="grid grid-cols-1 gap-3 min-[380px]:grid-cols-2 md:grid-cols-4">{[...files].sort((a, b) => b.createdAt - a.createdAt).slice(0, 4).map((f) => <AttachmentCard key={f.id} att={f} onEdit={setEditFile} />)}</div></div>
          )}
        </div>
      )}

      {tab === "notes" && (
        <div>
          <div className="mb-3 flex justify-end"><Button variant="primary" onClick={() => setNewNote(true)}><FilePlus2 size={15} />{t("ملاحظة جديدة", "New note")}</Button></div>
          {notes.length === 0 ? <EmptyState icon={<FilePlus2 />} title={t("لا توجد ملاحظات", "No notes")} /> : (
            <div className="grid gap-2 md:grid-cols-2">{[...notes].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt).map((n) => (
              <Link key={n.id} to={`/notes/${n.id}`} className="card-surface min-w-0 p-4 hover:border-accent"><div className="flex items-center gap-1.5 font-extrabold">{n.pinned && <Pin size={13} className="shrink-0 text-accent" />}<span className="truncate" dir="auto">{n.title || t("بدون عنوان", "Untitled")}</span></div><p className="mt-1 line-clamp-2 text-sm text-muted" dir="auto">{n.text.slice(0, 140)}</p><div className="mt-2 text-xs text-muted">{fmtDate(n.updatedAt)}</div></Link>
            ))}</div>
          )}
        </div>
      )}
      {tab === "files" && (
        <div className="space-y-4"><UploadZone link={{ subjectId: id }} compact />
          <div className="grid grid-cols-1 gap-3 min-[380px]:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">{files.map((f) => <AttachmentCard key={f.id} att={f} onEdit={setEditFile} />)}</div>
          {files.length === 0 && <p className="text-center text-sm text-muted">{t("لا توجد ملفات", "No files")}</p>}</div>
      )}
      {tab === "cards" && (
        <div>
          <div className="mb-3 flex flex-wrap justify-end gap-2"><Button onClick={() => nav("/flashcards")}>{t("إدارة البطاقات", "Manage cards")}</Button><Button variant="primary" onClick={() => openCard({ subjectId: id })}><Plus size={15} />{t("بطاقة جديدة", "New card")}</Button></div>
          {cards.length === 0 ? <EmptyState icon={<Layers />} title={t("لا توجد بطاقات", "No cards")} /> : <div className="grid gap-2 md:grid-cols-2">{cards.slice(0, 40).map((c) => <div key={c.id} className="nv-selectable card-surface break-words p-3 text-sm"><div className="font-bold" dir="auto">{c.front.slice(0, 120)}</div><div className="mt-1 text-xs text-muted">{t("المراجعة القادمة", "Next review")}: {fmtDate(c.due)}</div></div>)}</div>}
        </div>
      )}

      <LectureForm open={lecForm.open} lecture={lecForm.lecture} defaultWeek={lecForm.week} subjectId={id} onClose={() => setLecForm({ open: false })} />
      <SubjectForm open={editSubject} subject={subject} onClose={() => setEditSubject(false)} />
      <NewNoteModal open={newNote} onClose={() => setNewNote(false)} subjectId={id} />
      <AttachmentEditModal att={editFile} onClose={() => setEditFile(null)} />
      <Modal open={!!moving} onClose={() => setMoving(null)} title={t("نقل المحاضرة", "Move lecture")} footer={<><Button onClick={() => setMoving(null)}>{t("إلغاء", "Cancel")}</Button><Button variant="primary" onClick={async () => { if (moving) { await moveLecture(moving.id, Math.max(1, moveWeek)); setMoving(null); toast(t("تم النقل", "Moved")); } }}>{t("نقل", "Move")}</Button></>}>
        <Field label={t("رقم الأسبوع", "Week number")}>{(fid) => <Input id={fid} type="number" min={1} value={moveWeek} onChange={(e) => setMoveWeek(Number(e.target.value))} />}</Field>
        <div className="mt-2 flex flex-wrap gap-1.5">{weekNums.map((n) => <Chip key={n} active={moveWeek === n} onClick={() => setMoveWeek(n)}>{weekLabel(n)}</Chip>)}</div>
      </Modal>
      <Modal open={!!weekEdit} onClose={() => setWeekEdit(null)} title={t("اسم الأسبوع", "Week name")} footer={<><Button onClick={() => setWeekEdit(null)}>{t("إلغاء", "Cancel")}</Button><Button variant="primary" onClick={async () => { if (weekEdit) { await renameWeek(id, weekEdit.n, weekEdit.label); setWeekEdit(null); } }}>{t("حفظ", "Save")}</Button></>}>
        <Field label={t("اسم مخصص (اتركه فارغاً للاسم الافتراضي)", "Custom name (empty = default)")}>{(fid) => <Input id={fid} value={weekEdit?.label ?? ""} onChange={(e) => weekEdit && setWeekEdit({ ...weekEdit, label: e.target.value })} dir="auto" />}</Field>
      </Modal>
    </div>
  );
}
