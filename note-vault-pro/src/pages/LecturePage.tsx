import { useLiveQuery } from "dexie-react-hooks";
import { ArrowRight, FilePlus2, Layers, Pencil, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { db } from "@/data/db";
import type { Attachment, ReviewStatus } from "@/data/types";
import { setReviewStatus, updateLecture } from "@/services/library";
import { useApp } from "@/ui/app-context";
import { AttachmentCard, AttachmentEditModal } from "@/ui/Files";
import { useI18n } from "@/ui/i18n";
import { LectureForm, useStatusLabels } from "@/ui/LectureForm";
import { LectureRecorderPanel } from "@/ui/LectureRecorderPanel";
import { Badge, Button, EmptyState, ProgressBar } from "@/ui/kit";
import { NewNoteModal } from "@/ui/NewNoteModal";
import { Chip, UploadZone } from "@/ui/shared";

export default function LecturePage() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const { t, fmtDate } = useI18n();
  const { openCard } = useApp();
  const statuses = useStatusLabels();
  const lecture = useLiveQuery(() => db.lectures.get(id), [id]);
  const subject = useLiveQuery(() => (lecture ? db.subjects.get(lecture.subjectId) : undefined), [lecture?.subjectId]);
  const notes = useLiveQuery(() => db.notes.where("lectureId").equals(id).filter((n) => !n.deletedAt).toArray(), [id]) ?? [];
  const files = useLiveQuery(() => db.attachments.where("lectureId").equals(id).filter((a) => !a.deletedAt).toArray(), [id]) ?? [];
  const cards = useLiveQuery(() => db.flashcards.filter((c) => c.source?.lectureId === id).toArray(), [id]) ?? [];
  const [edit, setEdit] = useState(false);
  const [newNote, setNewNote] = useState(false);
  const [editFile, setEditFile] = useState<Attachment | null>(null);
  const recSectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (params.get("record") === "1" && recSectionRef.current) {
      recSectionRef.current.scrollIntoView?.({ behavior: "smooth", block: "start" });
    }
  }, [params, lecture?.id]);

  if (lecture === undefined) return null;
  if (!lecture || lecture.deletedAt) return <EmptyState icon={<Layers />} title={t("المحاضرة غير موجودة", "Lecture not found")} action={<Link to="/subjects"><Button>{t("العودة", "Back")}</Button></Link>} />;
  const week = subject?.weeks.find((w) => w.n === lecture.week)?.label || t(`الأسبوع ${lecture.week}`, `Week ${lecture.week}`);
  const audio = files.filter((f) => f.kind === "audio");
  const others = files.filter((f) => f.kind !== "audio");

  return (
    <div className="space-y-6">
      <div>
        <Link to={subject ? `/subjects/${subject.id}` : "/subjects"} className="mb-2 inline-flex items-center gap-1 text-sm font-bold text-muted hover:text-fg"><ArrowRight size={14} className="ltr:rotate-180" />{subject?.name ?? t("المواد", "Subjects")}</Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1"><h1 className="break-words text-xl font-black sm:text-3xl" dir="auto">{lecture.title}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted"><span>{week}</span><span>·</span><span>{fmtDate(lecture.date, { dateStyle: "full" })}</span><Badge>{statuses[lecture.reviewStatus]}</Badge></div></div>
          <Button onClick={() => setEdit(true)}><Pencil size={15} />{t("تعديل", "Edit")}</Button>
        </div>
        {lecture.description && <p className="nv-selectable mt-2 break-words text-sm text-muted" dir="auto">{lecture.description}</p>}
        {lecture.keywords.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{lecture.keywords.map((k) => <Badge key={k} color={subject?.color}>#{k}</Badge>)}</div>}
      </div>

      <section className="card-surface grid gap-4 p-4 sm:grid-cols-2 sm:p-5">
        <div>
          <div className="mb-2 text-sm font-bold">{t("حالة المراجعة", "Review status")}</div>
          <div className="flex flex-wrap gap-2">{(Object.keys(statuses) as ReviewStatus[]).map((s) => <Chip key={s} active={lecture.reviewStatus === s} onClick={() => void setReviewStatus(id, s)}>{statuses[s]}</Chip>)}</div>
        </div>
        <div>
          <div className="mb-2 flex justify-between text-sm font-bold"><label htmlFor="prog">{t("نسبة الإنجاز", "Progress")}</label><span>{lecture.progress}%</span></div>
          <input id="prog" type="range" min={0} max={100} step={5} value={lecture.progress} onChange={(e) => void updateLecture(id, { progress: Number(e.target.value) })} className="h-9 w-full accent-[var(--accent)]" />
          <ProgressBar value={lecture.progress} />
        </div>
      </section>

      <section ref={recSectionRef} id="lecture-recorder">
        <LectureRecorderPanel lectureId={id} subjectId={lecture.subjectId} lectureTitle={lecture.title} />
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-extrabold">{t("ملاحظات المحاضرة", "Lecture notes")}</h2><Button variant="primary" onClick={() => setNewNote(true)}><FilePlus2 size={15} />{t("ملاحظة", "Note")}</Button></div>
        {notes.length === 0 ? <EmptyState icon={<FilePlus2 />} title={t("لا توجد ملاحظات لهذه المحاضرة", "No notes for this lecture")} action={<Button variant="primary" onClick={() => setNewNote(true)}>{t("ابدأ بقالب جاهز", "Start from a template")}</Button>} /> : (
          <div className="grid gap-2 md:grid-cols-2">{notes.map((n) => <Link key={n.id} to={`/notes/${n.id}`} className="card-surface min-w-0 p-4 hover:border-accent"><div className="truncate font-extrabold" dir="auto">{n.title || t("بدون عنوان", "Untitled")}</div><p className="mt-1 line-clamp-2 text-sm text-muted" dir="auto">{n.text.slice(0, 140)}</p></Link>)}</div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-extrabold">{t("الملفات والمرفقات", "Files & attachments")}</h2>
        <UploadZone link={{ lectureId: id }} compact />
        <div className="mt-3 grid grid-cols-1 gap-3 min-[380px]:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">{others.map((f) => <AttachmentCard key={f.id} att={f} onEdit={setEditFile} />)}</div>
        {audio.length > 0 && <div className="mt-4 space-y-2"><h3 className="text-sm font-bold">{t("التسجيلات الصوتية", "Audio recordings")}</h3>{audio.map((f) => <AttachmentCard key={f.id} att={f} onEdit={setEditFile} list />)}</div>}
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-extrabold">{t("بطاقات مرتبطة", "Linked cards")}</h2>
          <Button onClick={() => openCard({ subjectId: lecture.subjectId, source: { lectureId: id } })}><Plus size={15} />{t("بطاقة", "Card")}</Button></div>
        {cards.length === 0 ? <p className="text-sm text-muted">{t("لا توجد بطاقات مرتبطة", "No linked cards")}</p> : <div className="grid gap-2 md:grid-cols-2">{cards.map((c) => <div key={c.id} className="nv-selectable card-surface break-words p-3 text-sm font-bold" dir="auto">{c.front.slice(0, 100)}</div>)}</div>}
      </section>

      <LectureForm open={edit} onClose={() => setEdit(false)} subjectId={lecture.subjectId} lecture={lecture} />
      <NewNoteModal open={newNote} onClose={() => setNewNote(false)} lectureId={id} subjectId={lecture.subjectId} />
      <AttachmentEditModal att={editFile} onClose={() => setEditFile(null)} />
    </div>
  );
}
