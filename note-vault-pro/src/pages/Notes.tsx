import { useLiveQuery } from "dexie-react-hooks";
import { Archive, Copy, FilePlus2, Pin, Star, Trash2, Zap, NotebookText } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { db } from "@/data/db";
import type { Note } from "@/data/types";
import { normalize } from "@/domain/text";
import { softDelete } from "@/services/core";
import { duplicateNote, updateNoteMeta } from "@/services/notes";
import { ActionMenu } from "@/ui/ActionMenu";
import { useApp } from "@/ui/app-context";
import { useI18n } from "@/ui/i18n";
import { Badge, Button, EmptyState, Input, PageHeader, Select } from "@/ui/kit";
import { NewNoteModal } from "@/ui/NewNoteModal";
import { Chip, relTime, useIncremental, useSubjects } from "@/ui/shared";

type Filter = "all" | "pinned" | "favorite" | "quick" | "archived";

function NoteRow({ n, subject }: { n: Note; subject?: { name: string; color: string } }) {
  const { t, lang } = useI18n();
  const { toast, confirm } = useApp();
  const nav = useNavigate();
  const tags = useLiveQuery(async () => {
    const links = await db.noteTags.where("noteId").equals(n.id).toArray();
    return (await db.tags.bulkGet(links.map((l) => l.tagId))).filter(Boolean).map((x) => x!.name);
  }, [n.id]) ?? [];
  return (
    <div className="card-surface flex items-start gap-2 p-3 transition hover:border-accent">
      <button onClick={() => nav(`/notes/${n.id}`)} className="min-w-0 flex-1 text-start">
        <div className="flex items-center gap-1.5">
          {n.pinned && <Pin size={13} className="shrink-0 text-accent" />}{n.favorite && <Star size={13} className="shrink-0 text-warn" fill="currentColor" />}{n.kind === "quick" && <Zap size={13} className="shrink-0 text-accent" />}
          <span className="truncate font-extrabold" dir="auto">{n.title || t("بدون عنوان", "Untitled")}</span>
        </div>
        <p className="mt-0.5 line-clamp-2 text-sm text-muted" dir="auto">{n.text.slice(0, 160) || "—"}</p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted">
          {subject && <Badge color={subject.color}>{subject.name}</Badge>}{tags.map((x) => <Badge key={x}>#{x}</Badge>)}<span>{relTime(n.updatedAt, lang)}</span>
        </div>
      </button>
      <ActionMenu items={[
        { label: n.pinned ? t("إلغاء التثبيت", "Unpin") : t("تثبيت", "Pin"), icon: <Pin size={15} />, onClick: () => void updateNoteMeta(n.id, { pinned: !n.pinned }) },
        { label: n.favorite ? t("إزالة من المفضلة", "Remove favourite") : t("مفضلة", "Favourite"), icon: <Star size={15} />, onClick: () => void updateNoteMeta(n.id, { favorite: !n.favorite }) },
        { label: n.archived ? t("إلغاء الأرشفة", "Unarchive") : t("أرشفة", "Archive"), icon: <Archive size={15} />, onClick: () => void updateNoteMeta(n.id, { archived: !n.archived }) },
        { label: t("تكرار", "Duplicate"), icon: <Copy size={15} />, onClick: async () => { await duplicateNote(n.id); toast(t("تم التكرار", "Duplicated")); } },
        { label: t("حذف", "Delete"), icon: <Trash2 size={15} />, danger: true, onClick: async () => { if (await confirm({ title: t("حذف الملاحظة؟", "Delete this note?"), danger: true, message: t("ستنتقل إلى سلة المحذوفات.", "It moves to the trash.") })) { await softDelete("note", n.id); toast(t("تم النقل إلى سلة المحذوفات", "Moved to trash")); } } },
      ]} />
    </div>
  );
}

export default function Notes() {
  const { t } = useI18n();
  const { setQuickOpen } = useApp();
  const subjects = useSubjects(true);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [subjectId, setSubjectId] = useState("");
  const [tag, setTag] = useState("");
  const [open, setOpen] = useState(false);
  const notes = useLiveQuery(() => db.notes.filter((n) => !n.deletedAt).toArray(), []);
  const tags = useLiveQuery(() => db.tags.toArray(), []) ?? [];
  const tagged = useLiveQuery(async () => (tag ? new Set((await db.noteTags.where("tagId").equals(tag).toArray()).map((l) => l.noteId)) : null), [tag]);
  const sMap = new Map(subjects.map((s) => [s.id, s]));
  const nq = normalize(q);
  const list = (notes ?? [])
    .filter((n) => (filter === "archived" ? n.archived : !n.archived) && (filter !== "pinned" || n.pinned) && (filter !== "favorite" || n.favorite) && (filter !== "quick" || n.kind === "quick"))
    .filter((n) => !subjectId || n.subjectId === subjectId)
    .filter((n) => !tagged || tagged.has(n.id))
    .filter((n) => !nq || normalize(n.title + " " + n.text).includes(nq))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
  const { shown, sentinel } = useIncremental(list, 40);
  return (
    <div>
      <PageHeader title={t("الملاحظات", "Notes")} subtitle={t("كل ملاحظاتك العادية والسريعة", "All your regular and quick notes")}
        actions={<><Button onClick={() => setQuickOpen(true)}><Zap size={16} />{t("التقاط سريع", "Quick capture")}</Button><Button variant="primary" onClick={() => setOpen(true)}><FilePlus2 size={16} />{t("ملاحظة جديدة", "New note")}</Button></>} />
      <div className="mb-3 grid gap-2 sm:grid-cols-[1fr_12rem_10rem]">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("تصفية بالعنوان أو المحتوى…", "Filter by title or content…")} aria-label={t("تصفية الملاحظات", "Filter notes")} dir="auto" />
        <Select aria-label={t("المادة", "Subject")} value={subjectId} onChange={(e) => setSubjectId(e.target.value)}><option value="">{t("كل المواد", "All subjects")}</option>{subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
        <Select aria-label={t("الوسم", "Tag")} value={tag} onChange={(e) => setTag(e.target.value)}><option value="">{t("كل الوسوم", "All tags")}</option>{tags.map((x) => <option key={x.id} value={x.id}>#{x.name}</option>)}</Select>
      </div>
      <div className="mb-4 flex flex-wrap gap-2">
        {([["all", t("الكل", "All")], ["pinned", t("المثبتة", "Pinned")], ["favorite", t("المفضلة", "Favourites")], ["quick", t("السريعة", "Quick")], ["archived", t("المؤرشفة", "Archived")]] as [Filter, string][]).map(([k, l]) => <Chip key={k} active={filter === k} onClick={() => setFilter(k)}>{l}</Chip>)}
        <Link to="/trash" className="ms-auto text-sm font-bold text-muted hover:text-fg">{t("سلة المحذوفات", "Trash")}</Link>
      </div>
      {notes && list.length === 0 ? <EmptyState icon={<NotebookText />} title={t("لا توجد ملاحظات", "No notes found")} action={<Button variant="primary" onClick={() => setOpen(true)}>{t("ملاحظة جديدة", "New note")}</Button>} /> : (
        <div className="grid gap-2 lg:grid-cols-2">{shown.map((n) => <NoteRow key={n.id} n={n} subject={n.subjectId ? sMap.get(n.subjectId) : undefined} />)}</div>
      )}
      {sentinel}
      <NewNoteModal open={open} onClose={() => setOpen(false)} />
    </div>
  );
}
