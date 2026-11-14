import { useLiveQuery } from "dexie-react-hooks";
import { FolderOpen, LayoutGrid, List, Mic } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { db } from "@/data/db";
import type { Attachment, FileKind } from "@/data/types";
import { normalize } from "@/domain/text";
import { AttachmentCard, AttachmentEditModal } from "@/ui/Files";
import { useI18n } from "@/ui/i18n";
import { Button, EmptyState, Input, PageHeader, Select } from "@/ui/kit";
import { Chip, UploadZone, useIncremental, useSubjects } from "@/ui/shared";

function LinkedTo({ a }: { a: Attachment }) {
  const { t } = useI18n();
  const note = useLiveQuery(() => (a.noteId ? db.notes.get(a.noteId) : undefined), [a.noteId]);
  const lec = useLiveQuery(() => (a.lectureId ? db.lectures.get(a.lectureId) : undefined), [a.lectureId]);
  if (!note && !lec) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-2 px-1 text-xs font-bold text-accent">
      {note && !note.deletedAt && <Link to={`/notes/${note.id}`} className="hover:underline">↗ {t("الملاحظة", "Note")}: {(note.title || t("بدون عنوان", "Untitled")).slice(0, 18)}</Link>}
      {lec && !lec.deletedAt && <Link to={`/lectures/${lec.id}`} className="hover:underline">↗ {t("المحاضرة", "Lecture")}: {lec.title.slice(0, 18)}</Link>}
    </div>
  );
}

export default function Library() {
  const { t } = useI18n();
  const subjects = useSubjects(true);
  const files = useLiveQuery(() => db.attachments.filter((a) => !a.deletedAt).toArray(), []);
  const [view, setView] = useState<"grid" | "list">("grid");
  const [kind, setKind] = useState<FileKind | "all">("all");
  const [subjectId, setSubjectId] = useState("");
  const [date, setDate] = useState("all");
  const [size, setSize] = useState("all");
  const [sort, setSort] = useState("date-desc");
  const [q, setQ] = useState("");
  const [edit, setEdit] = useState<Attachment | null>(null);
  const now = Date.now();
  const MB = 1024 * 1024;
  const nq = normalize(q);
  const list = (files ?? [])
    .filter((a) => kind === "all" || a.kind === kind || (kind === "text" && a.kind === "markdown"))
    .filter((a) => !subjectId || a.subjectId === subjectId)
    .filter((a) => date === "all" || a.createdAt > now - ({ week: 7, month: 30, year: 365 } as Record<string, number>)[date] * 86400000)
    .filter((a) => size === "all" || (size === "s" ? a.size < MB : size === "m" ? a.size >= MB && a.size < 10 * MB : a.size >= 10 * MB))
    .filter((a) => !nq || normalize(a.name + " " + a.description).includes(nq))
    .sort((a, b) => {
      const [k, d] = sort.split("-");
      const v = k === "name" ? a.name.localeCompare(b.name) : k === "size" ? a.size - b.size : a.createdAt - b.createdAt;
      return d === "asc" ? v : -v;
    });
  const { shown, sentinel } = useIncremental(list, 48);
  const kinds: [FileKind | "all", string][] = [["all", t("الكل", "All")], ["pdf", "PDF"], ["image", t("صور", "Images")], ["audio", t("صوت", "Audio")], ["text", t("نصوص", "Text")]];
  return (
    <div>
      <PageHeader title={t("مكتبة الملفات", "File vault")} subtitle={t("كل ملفاتك منظمة في مكان واحد", "All your files organized in one place")}
        actions={<div className="flex flex-wrap items-center gap-2">
          <Link to="/record"><Button variant="primary"><Mic size={16} />{t("تسجيل محاضرة", "Record lecture")}</Button></Link>
          <div className="flex rounded-xl bg-surface2 p-1" role="group" aria-label={t("طريقة العرض", "View")}>
            <button aria-pressed={view === "grid"} aria-label={t("شبكة", "Grid")} onClick={() => setView("grid")} className={`rounded-lg p-2 ${view === "grid" ? "bg-surface shadow" : "text-muted"}`}><LayoutGrid size={16} /></button>
            <button aria-pressed={view === "list"} aria-label={t("قائمة", "List")} onClick={() => setView("list")} className={`rounded-lg p-2 ${view === "list" ? "bg-surface shadow" : "text-muted"}`}><List size={16} /></button>
          </div>
        </div>} />
      <UploadZone />
      <div className="my-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("بحث بالاسم…", "Search by name…")} aria-label={t("بحث بالاسم", "Search by name")} dir="auto" className="lg:col-span-2" />
        <Select aria-label={t("المادة", "Subject")} value={subjectId} onChange={(e) => setSubjectId(e.target.value)}><option value="">{t("كل المواد", "All subjects")}</option>{subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
        <Select aria-label={t("التاريخ", "Date")} value={date} onChange={(e) => setDate(e.target.value)}><option value="all">{t("أي تاريخ", "Any date")}</option><option value="week">{t("آخر 7 أيام", "Last 7 days")}</option><option value="month">{t("آخر 30 يوماً", "Last 30 days")}</option><option value="year">{t("آخر سنة", "Last year")}</option></Select>
        <Select aria-label={t("الحجم", "Size")} value={size} onChange={(e) => setSize(e.target.value)}><option value="all">{t("أي حجم", "Any size")}</option><option value="s">&lt; 1 MB</option><option value="m">1–10 MB</option><option value="l">&gt; 10 MB</option></Select>
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {kinds.map(([k, l]) => <Chip key={k} active={kind === k} onClick={() => setKind(k)}>{l}</Chip>)}
        <div className="w-full sm:ms-auto sm:w-44"><Select aria-label={t("الترتيب", "Sort")} value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="date-desc">{t("الأحدث", "Newest")}</option><option value="date-asc">{t("الأقدم", "Oldest")}</option><option value="name-asc">{t("الاسم (أ→ي)", "Name (A→Z)")}</option><option value="name-desc">{t("الاسم (ي→أ)", "Name (Z→A)")}</option><option value="size-desc">{t("الأكبر حجماً", "Largest")}</option><option value="size-asc">{t("الأصغر حجماً", "Smallest")}</option></Select></div>
      </div>
      {files && list.length === 0 ? <EmptyState icon={<FolderOpen />} title={t("لا توجد ملفات", "No files")} hint={t("أضف ملفات PDF أو صوراً أو نصوصاً أو تسجيلات.", "Add PDFs, images, text files or recordings.")} /> : view === "grid" ? (
        <div className="grid grid-cols-1 gap-3 min-[380px]:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">{shown.map((a) => <div key={a.id} className="min-w-0"><AttachmentCard att={a} onEdit={setEdit} /><LinkedTo a={a} /></div>)}</div>
      ) : (
        <div className="space-y-2">{shown.map((a) => <div key={a.id}><AttachmentCard att={a} onEdit={setEdit} list /><LinkedTo a={a} /></div>)}</div>
      )}
      {sentinel}
      <AttachmentEditModal att={edit} onClose={() => setEdit(null)} />
    </div>
  );
}
