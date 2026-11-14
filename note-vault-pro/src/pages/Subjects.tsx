import { useLiveQuery } from "dexie-react-hooks";
import { motion } from "motion/react";
import { Archive, ArchiveRestore, BookOpen, ImagePlus, Pencil, Plus, Trash2, FolderInput } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { db } from "@/data/db";
import type { Subject } from "@/data/types";
import { safeCssColor, safeDataImageUrl } from "@/domain/sanitize";
import { coverFromFile } from "@/files/validate";
import { errMsg, softDelete } from "@/services/core";
import { createSubject, getSubjectStats, subjectColors, updateSubject } from "@/services/library";
import { ActionMenu } from "@/ui/ActionMenu";
import { useApp } from "@/ui/app-context";
import { useI18n } from "@/ui/i18n";
import { Badge, Button, EmptyState, Field, Input, Modal, PageHeader, ProgressBar, Select, Textarea } from "@/ui/kit";
import { Chip, relTime } from "@/ui/shared";

export function SubjectForm({ open, onClose, subject }: { open: boolean; onClose: () => void; subject?: Subject }) {
  const { t } = useI18n();
  const { toast } = useApp();
  const semesters = useLiveQuery(() => db.semesters.filter((s) => !s.archived).toArray(), []) ?? [];
  const [f, setF] = useState({ name: "", code: "", description: "", teacher: "", color: subjectColors[0], credits: "", semesterId: "", cover: undefined as string | undefined });
  useEffect(() => {
    if (!open) return;
    setF({ name: subject?.name ?? "", code: subject?.code ?? "", description: subject?.description ?? "", teacher: subject?.teacher ?? "", color: subject?.color ?? subjectColors[Math.floor(Math.random() * subjectColors.length)], credits: subject?.credits?.toString() ?? "", semesterId: subject?.semesterId ?? "", cover: subject?.cover });
  }, [open, subject]);
  const save = async () => {
    try {
      const data = { name: f.name, code: f.code, description: f.description, teacher: f.teacher, color: f.color, credits: f.credits ? Number(f.credits) : undefined, semesterId: f.semesterId || undefined, cover: f.cover };
      if (subject) await updateSubject(subject.id, data);
      else await createSubject(data);
      toast(t("تم الحفظ", "Saved"));
      onClose();
    } catch (e) { toast(errMsg(e) === "NAME_REQUIRED" ? t("أدخل اسم المادة", "Enter the subject name") : t("تعذر الحفظ", "Could not save"), "err"); }
  };
  return (
    <Modal open={open} onClose={onClose} title={subject ? t("تعديل المادة", "Edit subject") : t("مادة جديدة", "New subject")} wide
      footer={<><Button onClick={onClose}>{t("إلغاء", "Cancel")}</Button><Button variant="primary" onClick={() => void save()}>{t("حفظ", "Save")}</Button></>}>
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Field label={t("اسم المادة", "Subject name")} className="sm:col-span-2">{(id) => <Input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} dir="auto" required />}</Field>
        <Field label={t("رمز المادة", "Course code")}>{(id) => <Input id={id} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} dir="auto" placeholder="CS101" />}</Field>
        <Field label={t("اسم الأستاذ (اختياري)", "Instructor (optional)")}>{(id) => <Input id={id} value={f.teacher} onChange={(e) => setF({ ...f, teacher: e.target.value })} dir="auto" />}</Field>
        <Field label={t("الفصل الدراسي", "Semester")}>{(id) => <Select id={id} value={f.semesterId} onChange={(e) => setF({ ...f, semesterId: e.target.value })}><option value="">—</option>{semesters.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}</Field>
        <Field label={t("الساعات / الوحدات", "Credits")}>{(id) => <Input id={id} type="number" min={0} max={30} value={f.credits} onChange={(e) => setF({ ...f, credits: e.target.value })} />}</Field>
        <Field label={t("الوصف", "Description")} className="sm:col-span-2">{(id) => <Textarea id={id} rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} dir="auto" />}</Field>
        <div className="sm:col-span-2">
          <span className="text-xs font-semibold text-muted">{t("اللون", "Colour")}</span>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            {subjectColors.map((c) => <button type="button" key={c} aria-label={c} aria-pressed={f.color === c} onClick={() => setF({ ...f, color: c })} className="h-8 w-8 rounded-full ring-offset-2 ring-offset-surface transition" style={{ background: c, outline: f.color === c ? `3px solid ${c}` : "none", outlineOffset: 2 }} />)}
            <input type="color" aria-label={t("لون مخصص", "Custom colour")} value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} className="h-8 w-10 rounded-lg border border-line bg-transparent" />
          </div>
        </div>
        <div className="sm:col-span-2">
          <span className="text-xs font-semibold text-muted">{t("صورة الغلاف", "Cover image")}</span>
          <div className="mt-1.5 flex items-center gap-3">
            {(() => {
              const coverUrl = safeDataImageUrl(f.cover);
              const color = safeCssColor(f.color);
              return <div className="h-16 w-28 rounded-xl border border-line" style={{ background: coverUrl ? `url(${coverUrl}) center/cover` : `linear-gradient(135deg, ${color}, ${color}88)` }} />;
            })()}
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-line bg-surface2 px-3 py-2 text-sm font-semibold hover:bg-line/60">
              <ImagePlus size={16} />{t("اختيار صورة", "Choose image")}
              <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={async (e) => { const file = e.target.files?.[0]; if (file) { const c = await coverFromFile(file); if (c) setF((p) => ({ ...p, cover: c })); else toast(t("صورة غير صالحة", "Invalid image"), "err"); } }} />
            </label>
            {f.cover && <Button variant="ghost" onClick={() => setF({ ...f, cover: undefined })}>{t("إزالة", "Remove")}</Button>}
          </div>
        </div>
        <button type="submit" className="hidden" />
      </form>
    </Modal>
  );
}

function SubjectCard({ s, onEdit }: { s: Subject; onEdit: (s: Subject) => void }) {
  const { t, lang, fmtNum } = useI18n();
  const { toast, confirm } = useApp();
  const stats = useLiveQuery(() => getSubjectStats(s.id), [s.id]);
  const semester = useLiveQuery(() => (s.semesterId ? db.semesters.get(s.semesterId) : undefined), [s.semesterId]);
  const coverUrl = safeDataImageUrl(s.cover);
  const color = safeCssColor(s.color);
  return (
    <motion.div layout initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="card-surface relative overflow-hidden">
      <Link to={`/subjects/${s.id}`} className="block">
        <div className="h-24" style={{ background: coverUrl ? `url(${coverUrl}) center/cover` : `linear-gradient(135deg, ${color}, ${color}77)` }} />
        <div className="p-4">
          <div className="flex items-center gap-2"><h3 className="truncate text-lg font-extrabold" dir="auto">{s.name}</h3>{s.archived && <Badge>{t("مؤرشفة", "Archived")}</Badge>}</div>
          <p className="truncate text-xs text-muted" dir="auto">{[s.code, s.teacher, semester?.name].filter(Boolean).join(" · ") || "—"}</p>
          <div className="mt-3 grid grid-cols-2 gap-1.5 text-center text-xs min-[360px]:grid-cols-4">
            {[[t("محاضرات", "Lectures"), stats?.lectures], [t("ملاحظات", "Notes"), stats?.notes], [t("ملفات", "Files"), stats?.files], [t("بطاقات", "Cards"), stats?.cards]].map(([l, v]) => (
              <div key={l as string} className="rounded-lg bg-surface2 py-1.5"><div className="text-base font-black">{fmtNum((v as number) ?? 0)}</div><div className="text-muted">{l}</div></div>
            ))}
          </div>
          <div className="mt-3"><ProgressBar value={stats?.completion ?? 0} color={s.color} /></div>
          {!!stats?.lastActivity && <p className="mt-1.5 text-xs text-muted">{t("آخر نشاط", "Last activity")}: {relTime(stats.lastActivity, lang)}</p>}
        </div>
      </Link>
      <div className="absolute end-2 top-2 rounded-xl bg-surface/90 backdrop-blur">
        <ActionMenu items={[
          { label: t("تعديل", "Edit"), icon: <Pencil size={15} />, onClick: () => onEdit(s) },
          { label: s.archived ? t("إلغاء الأرشفة", "Unarchive") : t("أرشفة", "Archive"), icon: s.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />, onClick: async () => { await updateSubject(s.id, { archived: !s.archived }); toast(t("تم", "Done")); } },
          { label: t("حذف", "Delete"), icon: <Trash2 size={15} />, danger: true, onClick: async () => {
            if (await confirm({ title: t(`حذف المادة "${s.name}"؟`, `Delete "${s.name}"?`), message: t("سيتم نقل المادة مع محاضراتها وملاحظاتها وملفاتها إلى سلة المحذوفات.", "The subject with its lectures, notes and files moves to the trash."), danger: true, confirmLabel: t("حذف", "Delete") })) { await softDelete("subject", s.id); toast(t("تم النقل إلى سلة المحذوفات", "Moved to trash")); }
          } },
        ]} />
      </div>
    </motion.div>
  );
}

export default function Subjects() {
  const { t } = useI18n();
  const [form, setForm] = useState<{ open: boolean; subject?: Subject }>({ open: false });
  const [sem, setSem] = useState("all");
  const [showArchived, setShowArchived] = useState(false);
  const semesters = useLiveQuery(() => db.semesters.toArray(), []) ?? [];
  const subjects = useLiveQuery(() => db.subjects.filter((s) => !s.deletedAt).toArray(), []);
  const list = (subjects ?? []).filter((s) => (showArchived ? s.archived : !s.archived) && (sem === "all" || (sem === "none" ? !s.semesterId : s.semesterId === sem))).sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    <div>
      <PageHeader title={t("المواد الدراسية", "Subjects")} subtitle={t("لكل مادة مساحة عمل مستقلة بمحاضراتها وملفاتها وبطاقاتها", "Each subject has its own workspace of lectures, files and cards")}
        actions={<><Link to="/semesters"><Button><FolderInput size={16} />{t("الفصول", "Semesters")}</Button></Link><Button variant="primary" onClick={() => setForm({ open: true })}><Plus size={16} />{t("مادة جديدة", "New subject")}</Button></>} />
      <div className="mb-4 flex flex-wrap gap-2">
        <Chip active={sem === "all"} onClick={() => setSem("all")}>{t("كل الفصول", "All semesters")}</Chip>
        {semesters.map((s) => <Chip key={s.id} active={sem === s.id} onClick={() => setSem(s.id)}>{s.name}{s.archived ? " ⌂" : ""}</Chip>)}
        <Chip active={sem === "none"} onClick={() => setSem("none")}>{t("بدون فصل", "No semester")}</Chip>
        <span className="mx-1 w-px bg-line" />
        <Chip active={showArchived} onClick={() => setShowArchived((v) => !v)}>{t("المؤرشفة", "Archived")}</Chip>
      </div>
      {subjects && list.length === 0 ? (
        <EmptyState icon={<BookOpen />} title={t("لا توجد مواد", "No subjects")} hint={t("أنشئ مادة لتنظيم محاضراتك.", "Create a subject to organise your lectures.")} action={<Button variant="primary" onClick={() => setForm({ open: true })}><Plus size={16} />{t("مادة جديدة", "New subject")}</Button>} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{list.map((s) => <SubjectCard key={s.id} s={s} onEdit={(subject) => setForm({ open: true, subject })} />)}</div>
      )}
      <SubjectForm open={form.open} subject={form.subject} onClose={() => setForm({ open: false })} />
    </div>
  );
}
