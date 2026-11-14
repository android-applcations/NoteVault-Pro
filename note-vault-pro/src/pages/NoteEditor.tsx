import type { Editor, JSONContent } from "@tiptap/core";
import { useLiveQuery } from "dexie-react-hooks";
import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, ArrowRight, Archive, Check, Clock, CloudUpload, Copy, Download, History, Info, Loader2, Mic, Paperclip, Pin, RotateCcw, Star, Trash2, Zap } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { db } from "@/data/db";
import type { Note, NoteVersion } from "@/data/types";
import { sanitizeDoc } from "@/domain/sanitize";
import { formatDuration } from "@/domain/text";
import { softDelete } from "@/services/core";
import { getNoteTagNames, setNoteTags } from "@/services/library";
import { AutoSaver, deleteVersion, duplicateNote, getVersions, restoreVersion, saveNoteContent, updateNoteMeta, type SaveStatus } from "@/services/notes";
import { ActionMenu } from "@/ui/ActionMenu";
import { useApp } from "@/ui/app-context";
import { RichEditor } from "@/editor/RichEditor";
import { AttachmentCard, AttachmentEditModal } from "@/ui/Files";
import { useI18n } from "@/ui/i18n";
import { Badge, Button, EmptyState, Field, IconButton, Input, Modal, Select } from "@/ui/kit";
import { UploadZone, useSubjects } from "@/ui/shared";
import type { Attachment } from "@/data/types";

function SaveBadge({ status, onRetry }: { status: SaveStatus; onRetry: () => void }) {
  const { t } = useI18n();
  const map: Record<SaveStatus, { icon: React.ReactNode; text: string; cls: string }> = {
    idle: { icon: <Check size={14} />, text: t("تم الحفظ", "Saved"), cls: "text-muted" },
    dirty: { icon: <CloudUpload size={14} />, text: t("تعديلات غير محفوظة…", "Unsaved changes…"), cls: "text-warn" },
    saving: { icon: <Loader2 size={14} className="animate-spin" />, text: t("جارٍ الحفظ…", "Saving…"), cls: "text-muted" },
    saved: { icon: <Check size={14} />, text: t("تم الحفظ", "Saved"), cls: "text-success" },
    error: { icon: <AlertTriangle size={14} />, text: t("تعذر الحفظ", "Could not save"), cls: "text-danger" },
  };
  const m = map[status];
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div key={status} initial={{ opacity: 0, y: -4, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0 }} role="status" aria-live="polite" className={`flex items-center gap-1.5 text-xs font-bold ${m.cls}`}>
        {m.icon}{m.text}{status === "error" && <button className="underline" onClick={onRetry}>{t("إعادة المحاولة", "Retry")}</button>}
      </motion.div>
    </AnimatePresence>
  );
}

function NoteView({ note }: { note: Note }) {
  const { t, lang, fmtDate } = useI18n();
  const { toast, confirm, openCard, recorder } = useApp();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const subjects = useSubjects();
  const [title, setTitle] = useState(note.title);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [panel, setPanel] = useState<null | "files" | "info">(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [versions, setVersions] = useState<NoteVersion[]>([]);
  const [tags, setTags] = useState("");
  const [editFile, setEditFile] = useState<Attachment | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const contentRef = useRef<JSONContent | null>(note.content);
  const titleRef = useRef(note.title);
  const saverRef = useRef<AutoSaver | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const lectures = useLiveQuery(() => (note.subjectId ? db.lectures.where("subjectId").equals(note.subjectId).filter((l) => !l.deletedAt).toArray() : []), [note.subjectId]) ?? [];
  const files = useLiveQuery(() => db.attachments.where("noteId").equals(note.id).filter((a) => !a.deletedAt).toArray(), [note.id]) ?? [];
  const live = useLiveQuery(() => db.notes.get(note.id), [note.id]) ?? note;
  const initial = useRef(sanitizeDoc(note.content));

  useEffect(() => {
    const s = new AutoSaver(note.id, (st, err) => { setStatus(st); if (st === "error") console.error("autosave failed", err); });
    saverRef.current = s;
    const flush = () => { void s.flush(); };
    const onVis = () => document.visibilityState === "hidden" && flush();
    const onBefore = (e: BeforeUnloadEvent) => { if (s.hasPending()) { flush(); e.preventDefault(); } };
    const onExternal = async (ev: Event) => {
      const detail = (ev as CustomEvent<{ noteId?: string }>).detail;
      if (detail?.noteId !== note.id) return;
      const fresh = await db.notes.get(note.id);
      if (!fresh || fresh.deletedAt) return;
      const safe = sanitizeDoc(fresh.content);
      contentRef.current = safe;
      titleRef.current = fresh.title;
      setTitle(fresh.title);
      editorRef.current?.commands.setContent(safe, { emitUpdate: false });
      setStatus("saved");
    };
    const onJumpAudio = async (ev: Event) => {
      const detail = (ev as CustomEvent<{ recordingId?: string; attachmentId?: string; timeMs?: number }>).detail;
      if (!detail) return;
      const tSec = Math.max(0, Math.floor((detail.timeMs ?? 0) / 1000));
      if (detail.attachmentId) {
        await s.flush();
        nav(`/files/${detail.attachmentId}?t=${tSec}`);
        return;
      }
      if (!detail.recordingId) return;
      const rec = await db.recordings.get(detail.recordingId);
      if (rec && !rec.deletedAt && rec.attachmentId) {
        await s.flush();
        nav(`/files/${rec.attachmentId}?t=${tSec}`);
      } else {
        toast(t("التسجيل الصوتي ما زال قيد التجهيز أو غير متوفر", "Audio recording is not finalized yet"), "info");
      }
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", onBefore);
    window.addEventListener("nv-note-external-update", onExternal);
    window.addEventListener("nv-jump-audio", onJumpAudio);
    getNoteTagNames(note.id).then((n) => setTags(n.join(", ")));
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", onBefore);
      window.removeEventListener("nv-note-external-update", onExternal);
      window.removeEventListener("nv-jump-audio", onJumpAudio);
      void s.dispose();
    };
  }, [note.id, nav, toast, t]);

  const schedule = useCallback(() => {
    saverRef.current?.schedule(() => ({ title: titleRef.current, content: contentRef.current ?? editorRef.current?.getJSON() ?? { type: "doc", content: [{ type: "paragraph" }] } }));
  }, []);
  const onUpdate = useCallback((doc: JSONContent) => { contentRef.current = doc; schedule(); }, [schedule]);
  const onTitle = (v: string) => { setTitle(v); titleRef.current = v; if (!contentRef.current) contentRef.current = editorRef.current?.getJSON() ?? { type: "doc", content: [{ type: "paragraph" }] }; schedule(); };

  const openHistory = async () => { await saverRef.current?.flush(); setVersions(await getVersions(note.id)); setHistoryOpen(true); };
  const doRestore = async (v: NoteVersion) => {
    if (!(await confirm({ title: t("استعادة هذه النسخة؟", "Restore this version?"), message: t("سيتم حفظ النسخة الحالية في السجل أولاً.", "The current version is saved to history first."), confirmLabel: t("استعادة", "Restore") }))) return;
    await saverRef.current?.flush();
    const doc = await restoreVersion(note.id, v.id);
    contentRef.current = doc;
    titleRef.current = v.title;
    setTitle(v.title);
    editorRef.current?.commands.setContent(doc, { emitUpdate: false });
    setHistoryOpen(false);
    setReloadKey((k) => k + 1);
    toast(t("تمت استعادة النسخة", "Version restored"));
  };
  const exportMd = () => {
    const text = `# ${titleRef.current}\n\n${editorRef.current?.getText({ blockSeparator: "\n\n" }) ?? note.text}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = (titleRef.current || "note").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80) + ".md"; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };
  const del = async () => {
    if (!(await confirm({ title: t("حذف الملاحظة؟", "Delete this note?"), message: t("ستنتقل إلى سلة المحذوفات.", "It moves to the trash."), danger: true, confirmLabel: t("حذف", "Delete") }))) return;
    await saverRef.current?.flush();
    await softDelete("note", note.id);
    toast(t("تم النقل إلى سلة المحذوفات", "Moved to trash"));
    nav(-1);
  };

  const insertLiveTimestamp = () => {
    const ed = editorRef.current;
    if (!ed || !recorder.recordingId) return;
    const ms = Math.max(0, Math.round(recorder.elapsedMs));
    ed.chain()
      .focus()
      .insertContent([
        {
          type: "audioTimestamp",
          attrs: { recordingId: recorder.recordingId, timeMs: ms, label: "" },
        },
        { type: "text", text: " " },
      ])
      .run();
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <IconButton label={t("رجوع", "Back")} onClick={() => nav(-1)}><ArrowRight size={18} className="ltr:rotate-180" /></IconButton>
        <SaveBadge status={status} onRetry={() => void saverRef.current?.flush()} />
        {live.kind === "quick" && <Badge color="#0b8579"><Zap size={11} />{t("سريعة", "Quick")}</Badge>}
        {recorder.recordingId && (recorder.phase === "recording" || recorder.phase === "paused") && (
          <Button className="h-8 bg-danger/10 px-2.5 text-xs text-danger hover:bg-danger/20" onClick={insertLiveTimestamp}>
            <Clock size={13} />
            {t("إدراج طابع زمني", "Insert timestamp")} ({formatDuration(recorder.elapsedMs)})
          </Button>
        )}
        <div className="ms-auto flex items-center gap-1">
          <IconButton
            label={t("تسجيل محاضرة صوتياً", "Record lecture audio")}
            onClick={async () => {
              await saverRef.current?.flush();
              nav(note.lectureId ? `/lectures/${note.lectureId}?record=1` : note.subjectId ? `/record?subjectId=${note.subjectId}` : "/record");
            }}
            className="text-accent"
          >
            <Mic size={18} />
          </IconButton>
          <IconButton label={live.pinned ? t("إلغاء التثبيت", "Unpin") : t("تثبيت", "Pin")} aria-pressed={live.pinned} onClick={() => void updateNoteMeta(note.id, { pinned: !live.pinned })} className={live.pinned ? "text-accent" : ""}><Pin size={18} /></IconButton>
          <IconButton label={live.favorite ? t("إزالة من المفضلة", "Remove favourite") : t("مفضلة", "Favourite")} aria-pressed={live.favorite} onClick={() => void updateNoteMeta(note.id, { favorite: !live.favorite })} className={live.favorite ? "text-warn" : ""}><Star size={18} fill={live.favorite ? "currentColor" : "none"} /></IconButton>
          <IconButton label={t("المرفقات", "Attachments")} onClick={() => setPanel(panel === "files" ? null : "files")} className={panel === "files" ? "bg-surface2" : ""}><Paperclip size={18} />{files.length > 0 && <span className="absolute -mt-5 ms-5 rounded-full bg-accent px-1 text-[10px] font-bold text-white">{files.length}</span>}</IconButton>
          <IconButton label={t("التفاصيل والوسوم", "Details & tags")} onClick={() => setPanel(panel === "info" ? null : "info")} className={panel === "info" ? "bg-surface2" : ""}><Info size={18} /></IconButton>
          <IconButton label={t("سجل النسخ", "Version history")} onClick={() => void openHistory()}><History size={18} /></IconButton>
          <ActionMenu items={[
            { label: t("حفظ نسخة الآن", "Save a version now"), icon: <History size={15} />, onClick: async () => { await saverRef.current?.flush(true); if (contentRef.current) await saveNoteContent(note.id, { title: titleRef.current, content: contentRef.current }, { forceVersion: true, label: "manual" }); toast(t("تم حفظ نسخة", "Version saved")); } },
            ...(live.kind === "quick" ? [{ label: t("تحويل إلى ملاحظة منظمة", "Convert to structured note"), icon: <RotateCcw size={15} />, onClick: async () => { await updateNoteMeta(note.id, { kind: "note" }); toast(t("تم التحويل", "Converted")); } }] : []),
            { label: t("تكرار", "Duplicate"), icon: <Copy size={15} />, onClick: async () => { await saverRef.current?.flush(); const c = await duplicateNote(note.id); nav(`/notes/${c.id}`); } },
            { label: t("تصدير Markdown", "Export Markdown"), icon: <Download size={15} />, onClick: exportMd },
            { label: live.archived ? t("إلغاء الأرشفة", "Unarchive") : t("أرشفة", "Archive"), icon: <Archive size={15} />, onClick: async () => { await updateNoteMeta(note.id, { archived: !live.archived }); toast(t("تم", "Done")); } },
            { label: t("حذف", "Delete"), icon: <Trash2 size={15} />, danger: true, onClick: () => void del() },
          ]} />
        </div>
      </div>

      <input value={title} onChange={(e) => onTitle(e.target.value)} dir="auto" aria-label={t("عنوان الملاحظة", "Note title")} placeholder={t("عنوان الملاحظة", "Note title")} className="mb-1 w-full bg-transparent text-2xl font-black tracking-tight placeholder:text-muted/50 focus:outline-none sm:text-4xl" />
      <p className="mb-3 text-xs text-muted">{fmtDate(live.updatedAt, { dateStyle: "medium", timeStyle: "short" })} · {live.wordCount} {t("كلمة", "words")}</p>

      <AnimatePresence initial={false}>
        {panel && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="card-surface mb-4 p-4">
              {panel === "info" ? (
                <div className="grid gap-3 md:grid-cols-3">
                  <Field label={t("المادة", "Subject")}>{(id) => <Select id={id} value={live.subjectId ?? ""} onChange={(e) => void updateNoteMeta(note.id, { subjectId: e.target.value || undefined, lectureId: undefined })}><option value="">—</option>{subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}</Field>
                  <Field label={t("المحاضرة", "Lecture")}>{(id) => <Select id={id} value={live.lectureId ?? ""} disabled={!live.subjectId} onChange={(e) => void updateNoteMeta(note.id, e.target.value ? { lectureId: e.target.value } : { lectureId: undefined })}><option value="">—</option>{lectures.map((l) => <option key={l.id} value={l.id}>{l.title}</option>)}</Select>}</Field>
                  <Field label={t("الوسوم (مفصولة بفاصلة)", "Tags (comma separated)")}>{(id) => <Input id={id} value={tags} dir="auto" onChange={(e) => setTags(e.target.value)} onBlur={() => void setNoteTags(note.id, tags.split(/[,،]+/))} />}</Field>
                </div>
              ) : (
                <div className="space-y-3"><UploadZone link={{ noteId: note.id }} compact />
                  <div className="grid grid-cols-1 gap-3 min-[380px]:grid-cols-2 md:grid-cols-4">{files.map((f) => <AttachmentCard key={f.id} att={f} onEdit={setEditFile} />)}</div></div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <RichEditor key={reloadKey} noteId={note.id} content={reloadKey ? sanitizeDoc(contentRef.current) : initial.current} onUpdate={onUpdate} searchTerm={params.get("q") ?? undefined} editorRef={(e) => { editorRef.current = e; }}
        onCreateCard={(text) => openCard({ front: text, source: { noteId: note.id, lectureId: note.lectureId }, subjectId: note.subjectId })} />

      <Modal open={historyOpen} onClose={() => setHistoryOpen(false)} title={t("سجل الإصدارات", "Version history")} wide>
        {versions.length === 0 ? <EmptyState icon={<History />} title={t("لا توجد نسخ محفوظة بعد", "No saved versions yet")} hint={t("تُنشأ النسخ تلقائياً عند التعديل كل بضع دقائق.", "Versions are created automatically every few minutes while you edit.")} /> : (
          <ul className="space-y-2">
            {versions.map((v, i) => (
              <li key={v.id} className="flex flex-wrap items-center gap-2 rounded-2xl border border-line p-3 sm:flex-nowrap sm:gap-3">
                <div className="min-w-0 flex-1 basis-44"><div className="flex flex-wrap items-center gap-2 text-sm font-bold">{fmtDate(v.createdAt, { dateStyle: "medium", timeStyle: "short" })}{i === 0 && <Badge>{t("الأحدث", "Latest")}</Badge>}{v.label && <Badge>{v.label === "manual" ? t("يدوية", "Manual") : v.label === "restored" ? t("مستعادة", "Restored") : t("قبل الاستعادة", "Before restore")}</Badge>}</div>
                  <p className="truncate text-xs text-muted" dir="auto">{v.text.slice(0, 100) || "—"}</p></div>
                <div className="ms-auto flex items-center gap-1.5">
                  <Button onClick={() => void doRestore(v)}>{t("استعادة", "Restore")}</Button>
                  <IconButton label={t("حذف النسخة", "Delete version")} onClick={async () => { await deleteVersion(v.id); setVersions(await getVersions(note.id)); }}><Trash2 size={16} className="text-danger" /></IconButton>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-muted">{lang === "ar" ? "يمكنك تحديد عدد النسخ المحفوظة من الإعدادات." : "You can change how many versions are kept in Settings."}</p>
      </Modal>
      <AttachmentEditModal att={editFile} onClose={() => setEditFile(null)} />
    </div>
  );
}

export default function NoteEditor() {
  const { id = "" } = useParams();
  const { t } = useI18n();
  const note = useLiveQuery(async () => (await db.notes.get(id)) ?? null, [id]);
  const [loaded, setLoaded] = useState<Note | null | undefined>(undefined);
  useEffect(() => { db.notes.get(id).then((n) => setLoaded(n ?? null)); }, [id]);
  void note;
  if (loaded === undefined) return null;
  if (!loaded || loaded.deletedAt) return <EmptyState icon={<AlertTriangle />} title={t("الملاحظة غير موجودة", "Note not found")} action={<Link to="/notes"><Button>{t("الملاحظات", "Notes")}</Button></Link>} />;
  return <NoteView key={loaded.id} note={loaded} />;
}
