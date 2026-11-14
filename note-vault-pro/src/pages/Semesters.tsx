import { useLiveQuery } from "dexie-react-hooks";
import { Archive, ArchiveRestore, CalendarRange, Plus, Trash2 } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { db } from "@/data/db";
import { safeCssColor } from "@/domain/sanitize";
import { todayISO } from "@/domain/text";
import { errMsg } from "@/services/core";
import { createSemester, deleteSemester, updateSemester } from "@/services/library";
import { useApp } from "@/ui/app-context";
import { useI18n } from "@/ui/i18n";
import { Badge, Button, EmptyState, Field, Input, Modal, PageHeader, Select } from "@/ui/kit";

const defaultForm = () => ({
  name: "",
  startDate: todayISO(),
  endDate: todayISO(new Date(Date.now() + 110 * 86400000)),
});

export default function Semesters() {
  const { t, fmtDate } = useI18n();
  const { toast, confirm } = useApp();
  const semesters = useLiveQuery(() => db.semesters.orderBy("startDate").reverse().toArray(), []);
  const subjects = useLiveQuery(() => db.subjects.filter((s) => !s.deletedAt).toArray(), []) ?? [];
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [f, setF] = useState(defaultForm);
  const [showArchived, setShowArchived] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  const openModal = useCallback(() => {
    setF(defaultForm());
    setSaving(false);
    setOpen(true);
  }, []);

  const closeModal = useCallback(() => {
    setOpen(false);
    setSaving(false);
  }, []);

  const save = async () => {
    if (saving) return;
    if (!f.name.trim()) {
      toast(t("أدخل اسم الفصل", "Enter a semester name"), "err");
      nameRef.current?.focus();
      return;
    }
    setSaving(true);
    try {
      await createSemester({ ...f, name: f.name.trim() });
      setOpen(false);
      toast(t("تم إنشاء الفصل", "Semester created"));
    } catch (e) {
      toast(errMsg(e) === "BAD_DATES" ? t("تاريخ النهاية قبل البداية", "End date is before start date") : t("أدخل اسم الفصل", "Enter a semester name"), "err");
      nameRef.current?.focus();
    } finally {
      setSaving(false);
    }
  };

  const list = (semesters ?? []).filter((s) => showArchived || !s.archived);
  return (
    <div>
      <PageHeader title={t("الفصول الدراسية", "Semesters")} subtitle={t("الفصول المؤرشفة تحتفظ بكل ملاحظاتها وملفاتها", "Archived semesters keep all their notes and files")}
        actions={<><Button onClick={() => setShowArchived((v) => !v)} aria-pressed={showArchived}>{showArchived ? t("إخفاء المؤرشفة", "Hide archived") : t("تصفح الفصول السابقة", "Browse past semesters")}</Button><Button variant="primary" onClick={openModal}><Plus size={16} />{t("فصل جديد", "New semester")}</Button></>} />
      {semesters && list.length === 0 && <EmptyState icon={<CalendarRange />} title={t("لا توجد فصول", "No semesters")} hint={t("أنشئ فصلاً ثم انقل المواد إليه.", "Create a semester then move subjects into it.")} />}
      <div className="space-y-4">
        {list.map((s) => {
          const subs = subjects.filter((x) => x.semesterId === s.id);
          return (
            <section key={s.id} className="card-surface p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div><h2 className="flex items-center gap-2 text-lg font-extrabold">{s.name}{s.archived && <Badge>{t("مؤرشف", "Archived")}</Badge>}</h2>
                  <p className="text-xs text-muted">{fmtDate(s.startDate)} → {fmtDate(s.endDate)}</p></div>
                <div className="flex gap-1">
                  <Button onClick={async () => { await updateSemester(s.id, { archived: !s.archived }); }}>{s.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}{s.archived ? t("استعادة", "Unarchive") : t("أرشفة", "Archive")}</Button>
                  <Button variant="ghost" aria-label={t("حذف الفصل", "Delete semester")} onClick={async () => { if (await confirm({ title: t("حذف الفصل؟", "Delete this semester?"), message: t("المواد لن تُحذف وستصبح بدون فصل.", "Subjects are kept and become unassigned."), danger: true })) await deleteSemester(s.id); }}><Trash2 size={15} className="text-danger" /></Button>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {subs.map((x) => (
                  <span key={x.id} className="flex items-center gap-1 rounded-xl border border-line bg-surface2 ps-3 pe-1 py-1 text-sm font-bold">
                    <Link to={`/subjects/${x.id}`} style={{ color: safeCssColor(x.color) }}>{x.name}</Link>
                  </span>
                ))}
                {subs.length === 0 && <span className="text-sm text-muted">{t("لا توجد مواد في هذا الفصل", "No subjects in this semester")}</span>}
              </div>
              <div className="mt-3 max-w-xs">
                <Select aria-label={t("نقل مادة إلى هذا الفصل", "Move a subject to this semester")} value="" onChange={async (e) => { if (e.target.value) { await db.subjects.update(e.target.value, { semesterId: s.id, updatedAt: Date.now() }); toast(t("تم نقل المادة", "Subject moved")); } }}>
                  <option value="">{t("+ نقل مادة إلى هذا الفصل…", "+ Move a subject here…")}</option>
                  {subjects.filter((x) => x.semesterId !== s.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </Select>
              </div>
            </section>
          );
        })}
      </div>
      <Modal
        open={open}
        onClose={closeModal}
        title={t("فصل دراسي جديد", "New semester")}
        footer={
          <>
            <Button type="button" onClick={closeModal}>{t("إلغاء", "Cancel")}</Button>
            <Button type="submit" form="new-semester-form" variant="primary" disabled={saving}>{saving ? t("جارٍ الإنشاء…", "Creating…") : t("إنشاء", "Create")}</Button>
          </>
        }
      >
        <form id="new-semester-form" onSubmit={(e) => { e.preventDefault(); void save(); }} className="flex flex-col gap-3">
          <Field label={t("اسم الفصل", "Name")}>{(id) => <Input ref={nameRef} id={id} value={f.name} onChange={(e) => setF((p) => ({ ...p, name: e.target.value }))} placeholder={t("الفصل الأول 2025", "Fall 2025")} dir="auto" />}</Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("البداية", "Start")}>{(id) => <Input id={id} type="date" value={f.startDate} onChange={(e) => setF((p) => ({ ...p, startDate: e.target.value }))} />}</Field>
            <Field label={t("النهاية", "End")}>{(id) => <Input id={id} type="date" value={f.endDate} onChange={(e) => setF((p) => ({ ...p, endDate: e.target.value }))} />}</Field>
          </div>
        </form>
      </Modal>
    </div>
  );
}
