// Presentation layer – attachment cards, list rows and the edit/link modal.
import { useLiveQuery } from "dexie-react-hooks";
import { Download, Link2, Pencil, Trash2, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { db } from "@/data/db";
import type { Attachment, FileCategory } from "@/data/types";
import { formatBytes } from "@/domain/text";
import { deleteAttachment, downloadAttachment, linkAttachment, updateAttachment } from "@/services/files";
import { ActionMenu } from "./ActionMenu";
import { useApp } from "./app-context";
import { useI18n } from "./i18n";
import { Badge, Button, Field, Input, Modal, Select, Textarea } from "./kit";
import { AttachmentThumb, KindIcon, useSubjects } from "./shared";

export const useCategoryLabels = () => {
  const { t } = useI18n();
  return { lecture: t("محاضرة", "Lecture"), board: t("سبورة", "Whiteboard"), reference: t("مرجع", "Reference"), assignment: t("واجب", "Assignment"), other: t("أخرى", "Other") } as Record<FileCategory, string>;
};

export function useAttachmentActions() {
  const { t } = useI18n();
  const { toast, confirm } = useApp();
  const nav = useNavigate();
  return {
    open: (a: Attachment) => nav(`/files/${a.id}`),
    download: async (a: Attachment) => { try { await downloadAttachment(a); } catch { toast(t("الملف غير متاح", "File unavailable"), "err"); } },
    remove: async (a: Attachment) => {
      if (await confirm({ title: t("حذف الملف؟", "Delete this file?"), message: t("سينتقل إلى سلة المحذوفات ويمكنك استعادته.", "It moves to the trash and can be restored."), danger: true, confirmLabel: t("حذف", "Delete") })) {
        await deleteAttachment(a.id);
        toast(t("تم النقل إلى سلة المحذوفات", "Moved to trash"));
      }
    },
  };
}

export function AttachmentCard({ att, onEdit, list }: { att: Attachment; onEdit: (a: Attachment) => void; list?: boolean }) {
  const { t, fmtDate } = useI18n();
  const cats = useCategoryLabels();
  const act = useAttachmentActions();
  const subject = useLiveQuery(() => (att.subjectId ? db.subjects.get(att.subjectId) : undefined), [att.subjectId]);
  const menu = (
    <ActionMenu items={[
      { label: t("فتح", "Open"), icon: <ExternalLink size={15} />, onClick: () => act.open(att) },
      { label: t("تنزيل", "Download"), icon: <Download size={15} />, onClick: () => void act.download(att) },
      { label: t("تعديل / ربط", "Edit / link"), icon: <Pencil size={15} />, onClick: () => onEdit(att) },
      { label: t("حذف", "Delete"), icon: <Trash2 size={15} />, danger: true, onClick: () => void act.remove(att) },
    ]} />
  );
  if (list)
    return (
      <div className="card-surface flex items-center gap-3 p-2.5">
        <button onClick={() => act.open(att)} className="flex min-w-0 flex-1 items-center gap-3 text-start">
          <AttachmentThumb att={att} className="h-12 w-12 shrink-0 rounded-lg" />
          <span className="min-w-0"><span className="block truncate text-sm font-bold" dir="auto">{att.name}</span>
            <span className="block truncate text-xs text-muted">{cats[att.category]} · {formatBytes(att.size)} · {fmtDate(att.createdAt)}{subject ? ` · ${subject.name}` : ""}</span></span>
        </button>
        {menu}
      </div>
    );
  return (
    <div className="card-surface group relative overflow-hidden">
      <button onClick={() => act.open(att)} className="block w-full text-start" aria-label={att.name}>
        <AttachmentThumb att={att} className="aspect-[4/3] w-full" />
        <div className="p-3">
          <div className="flex items-center gap-1.5 text-accent"><KindIcon kind={att.kind} size={14} /><span className="truncate text-sm font-bold text-fg" dir="auto">{att.name}</span></div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted"><span dir="ltr">{formatBytes(att.size)}</span><Badge>{cats[att.category]}</Badge></div>
        </div>
      </button>
      <div className="absolute end-1 top-1 rounded-xl bg-surface/90 backdrop-blur">{menu}</div>
    </div>
  );
}

export function AttachmentEditModal({ att, onClose }: { att: Attachment | null; onClose: () => void }) {
  const { t } = useI18n();
  const { toast } = useApp();
  const cats = useCategoryLabels();
  const subjects = useSubjects();
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [category, setCategory] = useState<FileCategory>("other");
  const [subjectId, setSubjectId] = useState("");
  const [lectureId, setLectureId] = useState("");
  const [linkKind, setLinkKind] = useState<"lecture" | "note">("note");
  const [linkTarget, setLinkTarget] = useState("");
  const lectures = useLiveQuery(() => (subjectId ? db.lectures.where("subjectId").equals(subjectId).filter((l) => !l.deletedAt).toArray() : []), [subjectId]) ?? [];
  const notes = useLiveQuery(() => db.notes.filter((n) => !n.deletedAt).toArray(), []) ?? [];
  const allLectures = useLiveQuery(() => db.lectures.filter((l) => !l.deletedAt).toArray(), []) ?? [];
  useEffect(() => {
    if (!att) return;
    setName(att.name); setDesc(att.description); setCategory(att.category); setSubjectId(att.subjectId ?? ""); setLectureId(att.lectureId ?? ""); setLinkTarget("");
  }, [att]);
  if (!att) return null;
  const save = async () => {
    try {
      await updateAttachment(att.id, { name, description: desc, category, subjectId: subjectId || undefined, lectureId: lectureId || undefined });
      toast(t("تم الحفظ", "Saved"));
      onClose();
    } catch { toast(t("تعذر الحفظ", "Could not save"), "err"); }
  };
  const link = async () => {
    if (!linkTarget) return;
    try {
      await linkAttachment(att.id, linkKind === "note" ? { noteId: linkTarget } : { lectureId: linkTarget });
      toast(t("تم الربط بنجاح", "Linked successfully"));
    } catch { toast(t("تعذر الربط", "Could not link"), "err"); }
  };
  return (
    <Modal open onClose={onClose} title={t("تعديل الملف", "Edit file")} footer={<><Button onClick={onClose}>{t("إلغاء", "Cancel")}</Button><Button variant="primary" onClick={() => void save()}>{t("حفظ", "Save")}</Button></>}>
      <div className="flex flex-col gap-3">
        <Field label={t("الاسم", "Name")}>{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} dir="auto" />}</Field>
        <Field label={t("الوصف", "Description")}>{(id) => <Textarea id={id} rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} dir="auto" />}</Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t("التصنيف", "Category")}>{(id) => <Select id={id} value={category} onChange={(e) => setCategory(e.target.value as FileCategory)}>{Object.entries(cats).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
          <Field label={t("المادة", "Subject")}>{(id) => <Select id={id} value={subjectId} onChange={(e) => { setSubjectId(e.target.value); setLectureId(""); }}><option value="">—</option>{subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}</Field>
          <Field label={t("المحاضرة", "Lecture")}>{(id) => <Select id={id} value={lectureId} onChange={(e) => setLectureId(e.target.value)} disabled={!subjectId}><option value="">—</option>{lectures.map((l) => <option key={l.id} value={l.id}>{l.title}</option>)}</Select>}</Field>
        </div>
        <div className="rounded-2xl border border-line p-3">
          <div className="mb-2 flex items-center gap-2 text-sm font-bold"><Link2 size={15} />{t("ربط بملاحظة أو محاضرة أخرى", "Link to another note or lecture")}</div>
          <div className="grid gap-2 sm:grid-cols-[8rem_1fr_auto]">
            <Select aria-label={t("نوع الهدف", "Target type")} value={linkKind} onChange={(e) => { setLinkKind(e.target.value as "lecture" | "note"); setLinkTarget(""); }}><option value="note">{t("ملاحظة", "Note")}</option><option value="lecture">{t("محاضرة", "Lecture")}</option></Select>
            <Select aria-label={t("الهدف", "Target")} value={linkTarget} onChange={(e) => setLinkTarget(e.target.value)}>
              <option value="">—</option>
              {(linkKind === "note" ? notes.map((n) => ({ id: n.id, label: n.title || t("بدون عنوان", "Untitled") })) : allLectures.map((l) => ({ id: l.id, label: l.title }))).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </Select>
            <Button onClick={() => void link()} disabled={!linkTarget}>{t("ربط", "Link")}</Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
