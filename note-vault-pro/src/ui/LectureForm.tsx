import { useEffect, useState } from "react";
import type { Lecture, ReviewStatus } from "@/data/types";
import { todayISO } from "@/domain/text";
import { createLecture, updateLecture } from "@/services/library";
import { errMsg } from "@/services/core";
import { useApp } from "./app-context";
import { useI18n } from "./i18n";
import { Button, Field, Input, Modal, Select, Textarea } from "./kit";

export const useStatusLabels = () => {
  const { t } = useI18n();
  return { new: t("جديدة", "New"), reviewing: t("قيد المراجعة", "Reviewing"), mastered: t("متقنة", "Mastered") } as Record<ReviewStatus, string>;
};

export function LectureForm({ open, onClose, subjectId, lecture, defaultWeek, onSaved }: { open: boolean; onClose: () => void; subjectId: string; lecture?: Lecture; defaultWeek?: number; onSaved?: (l: Lecture) => void }) {
  const { t } = useI18n();
  const { toast } = useApp();
  const statuses = useStatusLabels();
  const [saving, setSaving] = useState(false);
  const [f, setF] = useState({ title: "", date: todayISO(), week: 1, description: "", keywords: "", reviewStatus: "new" as ReviewStatus, progress: 0 });
  useEffect(() => {
    if (!open) return;
    setSaving(false);
    setF({
      title: lecture?.title ?? "", date: lecture?.date ?? todayISO(), week: lecture?.week ?? defaultWeek ?? 1, description: lecture?.description ?? "",
      keywords: (lecture?.keywords ?? []).join(", "), reviewStatus: lecture?.reviewStatus ?? "new", progress: lecture?.progress ?? 0,
    });
  }, [open, lecture, defaultWeek]);
  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const data = { title: f.title, date: f.date, week: Math.max(1, Math.round(f.week) || 1), description: f.description, keywords: f.keywords.split(/[,،]+/).map((k) => k.trim()).filter(Boolean), reviewStatus: f.reviewStatus, progress: f.progress };
      const saved = lecture
        ? await updateLecture(lecture.id, data)
        : await createLecture({ subjectId, ...data });
      onSaved?.(saved);
      toast(t("تم الحفظ", "Saved"));
      onClose();
    } catch (e) {
      const code = errMsg(e);
      toast(
        code === "NAME_REQUIRED" ? t("أدخل عنوان المحاضرة", "Enter a lecture title") :
        code === "QUOTA_EXCEEDED" ? t("مساحة التخزين ممتلئة. احذف بعض الملفات أو صدّر نسخة احتياطية.", "Storage is full. Remove some files or export a backup.") :
        code === "NOT_FOUND" ? t("المادة أو المحاضرة غير موجودة", "Subject or lecture was not found") :
        t("تعذر الحفظ", "Could not save"),
        "err",
      );
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal open={open} onClose={() => { if (!saving) onClose(); }} title={lecture ? t("تعديل المحاضرة", "Edit lecture") : t("محاضرة جديدة", "New lecture")}
      footer={<><Button disabled={saving} onClick={onClose}>{t("إلغاء", "Cancel")}</Button><Button variant="primary" disabled={saving} onClick={() => void save()}>{t("حفظ", "Save")}</Button></>}>
      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Field label={t("عنوان المحاضرة", "Lecture title")}>{(id) => <Input id={id} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} dir="auto" required />}</Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("التاريخ", "Date")}>{(id) => <Input id={id} type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />}</Field>
          <Field label={t("رقم الأسبوع", "Week number")}>{(id) => <Input id={id} type="number" min={1} max={99} value={f.week} onChange={(e) => setF({ ...f, week: Number(e.target.value) })} />}</Field>
        </div>
        <Field label={t("الوصف", "Description")}>{(id) => <Textarea id={id} rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} dir="auto" />}</Field>
        <Field label={t("الكلمات المفتاحية (مفصولة بفاصلة)", "Keywords (comma separated)")}>{(id) => <Input id={id} value={f.keywords} onChange={(e) => setF({ ...f, keywords: e.target.value })} dir="auto" />}</Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("حالة المراجعة", "Review status")}>{(id) => <Select id={id} value={f.reviewStatus} onChange={(e) => setF({ ...f, reviewStatus: e.target.value as ReviewStatus })}>{Object.entries(statuses).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
          <Field label={`${t("نسبة الإنجاز", "Progress")}: ${f.progress}%`}>{(id) => <input id={id} type="range" min={0} max={100} step={5} value={f.progress} onChange={(e) => setF({ ...f, progress: Number(e.target.value) })} className="h-10 accent-[var(--accent)]" />}</Field>
        </div>
        <button type="submit" className="hidden" />
      </form>
    </Modal>
  );
}
