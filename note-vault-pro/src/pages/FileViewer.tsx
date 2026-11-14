import { useLiveQuery } from "dexie-react-hooks";
import { ArrowRight, Download, FileQuestion, Pencil, RotateCw, ZoomIn, ZoomOut } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { db } from "@/data/db";
import type { Attachment } from "@/data/types";
import { formatBytes } from "@/domain/text";
import { downloadAttachment, getBlob } from "@/services/files";
import { AttachmentEditModal } from "@/ui/Files";
import { useI18n } from "@/ui/i18n";
import { Badge, Button, EmptyState, IconButton, Skeleton } from "@/ui/kit";
import { useBlobUrl } from "@/ui/shared";

const PdfViewer = lazy(() => import("./PdfViewer"));

function ImageView({ att }: { att: Attachment }) {
  const { t } = useI18n();
  const { url, missing } = useBlobUrl(att);
  const [zoom, setZoom] = useState(1);
  const [rot, setRot] = useState(0);
  if (missing) return <EmptyState icon={<FileQuestion />} title={t("الملف غير موجود في التخزين", "File missing from storage")} />;
  return (
    <div>
      <div className="mb-2 flex gap-1"><IconButton label={t("تصغير", "Zoom out")} onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}><ZoomOut size={18} /></IconButton><IconButton label={t("تكبير", "Zoom in")} onClick={() => setZoom((z) => Math.min(5, z + 0.25))}><ZoomIn size={18} /></IconButton><IconButton label={t("تدوير", "Rotate")} onClick={() => setRot((r) => (r + 90) % 360)}><RotateCw size={18} /></IconButton><span className="self-center text-xs font-bold text-muted" dir="ltr">{Math.round(zoom * 100)}%</span></div>
      <div className="max-h-[75dvh] overflow-auto rounded-2xl bg-surface2 p-3 text-center">
        {url ? <img src={url} alt={att.description || att.name} style={{ transform: `scale(${zoom}) rotate(${rot}deg)`, transformOrigin: "top center", transition: "transform .2s" }} className="inline-block max-w-full" /> : <Skeleton className="mx-auto h-64 w-full" />}
      </div>
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
  useEffect(() => { getBlob(att).then(setBlob); }, [att]);
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
