import { useLiveQuery } from "dexie-react-hooks";
import { ArrowRight, Copy, Download, FilePlus2, FileQuestion, Pencil, RotateCw, ScanText, ZoomIn, ZoomOut } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { db } from "@/data/db";
import type { Attachment } from "@/data/types";
import { formatBytes } from "@/domain/text";
import type { OcrLang } from "@/files/ocr";
import { downloadAttachment, getBlob } from "@/services/files";
import { createNote } from "@/services/notes";
import { AttachmentEditModal } from "@/ui/Files";
import { useApp } from "@/ui/app-context";
import { useI18n } from "@/ui/i18n";
import { Badge, Button, EmptyState, IconButton, Select, Skeleton, Textarea } from "@/ui/kit";
import { useBlobUrl } from "@/ui/shared";

const PdfViewer = lazy(() => import("./PdfViewer"));

function ImageView({ att }: { att: Attachment }) {
  const { t } = useI18n();
  const { toast } = useApp();
  const nav = useNavigate();
  const { url, missing } = useBlobUrl(att);
  const [zoom, setZoom] = useState(1);
  const [rot, setRot] = useState(0);
  const [ocrLang, setOcrLang] = useState<OcrLang>("ara+eng");
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrPct, setOcrPct] = useState(0);
  const [ocrText, setOcrText] = useState("");
  if (missing) return <EmptyState icon={<FileQuestion />} title={t("الملف غير موجود في التخزين", "File missing from storage")} />;

  const runOcr = async () => {
    if (ocrBusy) return;
    setOcrBusy(true);
    setOcrPct(0);
    try {
      const blob = await getBlob(att);
      if (!blob) throw new Error("MISSING");
      const { runImageOcr } = await import("@/files/ocr");
      const text = await runImageOcr(blob, ocrLang, setOcrPct);
      setOcrText(text);
      if (!text) toast(t("لم يُعثر على نص واضح في الصورة", "No readable text found"), "info");
    } catch {
      toast(t("تعذر استخراج النص", "OCR failed"), "err");
    } finally {
      setOcrBusy(false);
    }
  };

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-1">
        <IconButton label={t("تصغير", "Zoom out")} onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}><ZoomOut size={18} /></IconButton>
        <IconButton label={t("تكبير", "Zoom in")} onClick={() => setZoom((z) => Math.min(5, z + 0.25))}><ZoomIn size={18} /></IconButton>
        <IconButton label={t("تدوير", "Rotate")} onClick={() => setRot((r) => (r + 90) % 360)}><RotateCw size={18} /></IconButton>
        <span className="self-center text-xs font-bold text-muted" dir="ltr">{Math.round(zoom * 100)}%</span>
        <div className="ms-auto flex flex-wrap items-center gap-2">
          <Select aria-label={t("لغة OCR", "OCR language")} value={ocrLang} onChange={(e) => setOcrLang(e.target.value as OcrLang)} className="!w-auto">
            <option value="ara+eng">{t("العربية + الإنجليزية", "Arabic + English")}</option>
            <option value="eng">English</option>
            <option value="ara">{t("العربية", "Arabic")}</option>
          </Select>
          <Button disabled={ocrBusy} onClick={() => void runOcr()}>
            <ScanText size={16} />
            {ocrBusy ? `${t("جارٍ الاستخراج…", "Extracting…")} ${ocrPct}%` : t("استخراج النص (OCR)", "Extract text (OCR)")}
          </Button>
        </div>
      </div>
      <div className="max-h-[75dvh] overflow-auto rounded-2xl bg-surface2 p-3 text-center">
        {url ? <img src={url} alt={att.description || att.name} style={{ transform: `scale(${zoom}) rotate(${rot}deg)`, transformOrigin: "top center", transition: "transform .2s" }} className="inline-block max-w-full" /> : <Skeleton className="mx-auto h-64 w-full" />}
      </div>
      {ocrText && (
        <div className="card-surface mt-3 space-y-2 p-4">
          <div className="text-sm font-extrabold">{t("النص المستخرج (OCR)", "Extracted text (OCR)")}</div>
          <Textarea rows={5} value={ocrText} onChange={(e) => setOcrText(e.target.value)} dir="auto" />
          <div className="flex flex-wrap gap-2">
            <Button onClick={async () => { await navigator.clipboard?.writeText(ocrText); toast(t("تم النسخ", "Copied")); }}><Copy size={15} />{t("نسخ", "Copy")}</Button>
            <Button variant="primary" onClick={async () => {
              const note = await createNote({
                title: att.name.replace(/\.[^.]+$/, ""),
                subjectId: att.subjectId,
                lectureId: att.lectureId,
                content: { type: "doc", content: ocrText.split(/\n+/).filter(Boolean).map((line) => ({ type: "paragraph", content: [{ type: "text", text: line }] })) },
              });
              nav(`/notes/${note.id}`);
            }}><FilePlus2 size={15} />{t("إنشاء ملاحظة من النص", "Create note from text")}</Button>
          </div>
        </div>
      )}
      {att.description && <p className="mt-2 text-sm text-muted" dir="auto">{att.description}</p>}
    </div>
  );
}

function TextView({ att }: { att: Attachment }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => { getBlob(att).then(async (b) => setText(b ? (await b.text()).slice(0, 2_000_000) : "")); }, [att]);
  // rendered strictly as plain text – never interpreted as HTML
  return <pre dir="auto" className="max-h-[75dvh] overflow-auto whitespace-pre-wrap rounded-2xl border border-line bg-surface p-4 text-sm leading-7">{text ?? "…"}</pre>;
}

function AudioView({ att }: { att: Attachment }) {
  const { url } = useBlobUrl(att);
  return <div className="card-surface p-6">{url ? <audio controls src={url} className="w-full" /> : <Skeleton className="h-12" />}{att.description && <p className="mt-3 text-sm text-muted" dir="auto">{att.description}</p>}</div>;
}

function PdfLoader({ att, page, q }: { att: Attachment; page?: number; q?: string }) {
  const { t } = useI18n();
  const [blob, setBlob] = useState<Blob | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void getBlob(att).then((b) => {
      if (alive) setBlob(b);
    });
    return () => {
      alive = false;
    };
    // Only reload the PDF binary if the attachment id or underlying blobId changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [att.id, att.blobId]);
  if (blob === undefined) return <Skeleton className="h-[60dvh]" />;
  if (!blob) return <EmptyState icon={<FileQuestion />} title={t("الملف غير موجود في التخزين", "File missing from storage")} />;
  return <Suspense fallback={<Skeleton className="h-[60dvh]" />}><PdfViewer att={att} blob={blob} initialPage={page} initialQuery={q} /></Suspense>;
}

export default function FileViewer() {
  const { id = "" } = useParams();
  const { t, fmtDate } = useI18n();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const att = useLiveQuery(async () => (await db.attachments.get(id)) ?? null, [id]);
  const [edit, setEdit] = useState<Attachment | null>(null);
  if (att === undefined) return null;
  if (!att || att.deletedAt) return <EmptyState icon={<FileQuestion />} title={t("الملف غير موجود", "File not found")} action={<Link to="/library"><Button>{t("المكتبة", "Library")}</Button></Link>} />;
  const page = Number(params.get("page")) || undefined;
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <IconButton label={t("رجوع", "Back")} onClick={() => nav(-1)}><ArrowRight size={18} className="ltr:rotate-180" /></IconButton>
        <div className="min-w-0 flex-1"><h1 className="truncate text-lg font-extrabold" dir="auto">{att.name}</h1><p className="text-xs text-muted"><span dir="ltr">{formatBytes(att.size)}</span> · {fmtDate(att.createdAt)} {att.originalSize && <Badge>{t("مضغوطة", "Compressed")}</Badge>}</p></div>
        <Button onClick={() => setEdit(att)}><Pencil size={15} />{t("تعديل", "Edit")}</Button>
        <Button onClick={() => void downloadAttachment(att)}><Download size={15} />{t("تنزيل", "Download")}</Button>
      </div>
      {att.kind === "pdf" && <PdfLoader att={att} page={page} q={params.get("q") ?? undefined} />}
      {att.kind === "image" && <ImageView att={att} />}
      {att.kind === "audio" && <AudioView att={att} />}
      {(att.kind === "text" || att.kind === "markdown") && <TextView att={att} />}
      <AttachmentEditModal att={edit} onClose={() => setEdit(null)} />
    </div>
  );
}
