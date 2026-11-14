// Presentation layer – shared hooks and components used across pages.
import { useLiveQuery } from "dexie-react-hooks";
import { FileAudio, FileImage, FileText, FileType2, Loader2, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { db } from "@/data/db";
import type { Attachment, FileCategory, Subject } from "@/data/types";
import { ACCEPT_ATTR } from "@/files/validate";
import { addFiles, ensureThumb, type AddFailure, type FileLink } from "@/services/files";
import { cn } from "@/utils/cn";
import { useApp } from "./app-context";
import { useI18n } from "./i18n";
import { Button } from "./kit";

export function useBlobUrl(att?: Pick<Attachment, "blobId" | "mime"> | null): { url: string | null; missing: boolean } {
  const [state, setState] = useState<{ url: string | null; missing: boolean }>({ url: null, missing: false });
  const blobId = att?.blobId;
  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    setState({ url: null, missing: false });
    if (!blobId) return;
    db.blobs.get(blobId).then((r) => {
      if (cancelled) return;
      if (!r) return setState({ url: null, missing: true });
      url = URL.createObjectURL(r.blob);
      setState({ url, missing: false });
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [blobId]);
  return state;
}

export function useSubjects(includeArchived = false): Subject[] {
  return (
    useLiveQuery(async () => {
      const all = await db.subjects.filter((s) => !s.deletedAt && (includeArchived || !s.archived)).toArray();
      return all.sort((a, b) => a.name.localeCompare(b.name));
    }, [includeArchived]) ?? []
  );
}

export function useDebounced<T>(value: T, ms = 200): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/** Renders big lists incrementally (windowing by chunks) to keep the UI responsive. */
export function useIncremental<T>(items: T[], chunk = 60): { shown: T[]; sentinel: ReactNode } {
  const [n, setN] = useState(chunk);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => setN(chunk), [items.length, chunk]);
  useEffect(() => {
    const el = ref.current;
    if (!el || n >= items.length) return;
    const io = new IntersectionObserver((e) => e[0].isIntersecting && setN((c) => c + chunk), { rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [n, items.length, chunk]);
  return { shown: items.slice(0, n), sentinel: n < items.length ? <div ref={ref} className="h-8" aria-hidden /> : null };
}

export function useFailureText() {
  const { t } = useI18n();
  return (r: AddFailure | undefined) => {
    switch (r) {
      case "type": return t("نوع الملف غير مدعوم", "Unsupported file type");
      case "size": return t("حجم الملف كبير جداً", "File is too large");
      case "empty": return t("الملف فارغ", "File is empty");
      case "mismatch": return t("محتوى الملف لا يطابق نوعه", "File content does not match its type");
      case "binary_text": return t("الملف النصي يحتوي بيانات ثنائية", "Text file contains binary data");
      case "bad_encoding": return t("تعذر قراءة ترميز الملف النصي", "Could not read text file encoding");
      case "dimensions": return t("أبعاد الصورة كبيرة جداً أو تتجاوز الحد المسموح", "Image dimensions are too large or exceed safe limits");
      case "corrupt": return t("الملف تالف أو بنيته غير صالحة", "File is corrupted or has invalid structure");
      case "quota": return t("مساحة التخزين ممتلئة", "Storage is full");
      default: return t("تعذر حفظ الملف", "Could not save the file");
    }
  };
}

export function KindIcon({ kind, size = 20 }: { kind: Attachment["kind"]; size?: number }) {
  if (kind === "pdf") return <FileType2 size={size} />;
  if (kind === "image") return <FileImage size={size} />;
  if (kind === "audio") return <FileAudio size={size} />;
  return <FileText size={size} />;
}

export function AttachmentThumb({ att, className }: { att: Attachment; className?: string }) {
  const [thumb, setThumb] = useState(att.thumb);
  useEffect(() => {
    setThumb(att.thumb);
    if (!att.thumb && (att.kind === "image" || att.kind === "pdf")) {
      let alive = true;
      ensureThumb(att).then((t) => alive && setThumb(t)).catch(() => undefined);
      return () => { alive = false; };
    }
  }, [att]);
  return (
    <div className={cn("flex items-center justify-center overflow-hidden bg-surface2 text-muted", className)}>
      {thumb ? <img src={thumb} alt="" className="h-full w-full object-cover" loading="lazy" /> : <KindIcon kind={att.kind} size={28} />}
    </div>
  );
}

export function UploadZone({ link, category, compact, onDone }: { link?: FileLink; category?: FileCategory; compact?: boolean; onDone?: (a: Attachment[]) => void }) {
  const { t } = useI18n();
  const { toast } = useApp();
  const failText = useFailureText();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const handle = useCallback(async (list: FileList | File[]) => {
    const files = Array.from(list);
    if (!files.length) return;
    setBusy(true);
    try {
      const res = await addFiles(files, link, { category });
      const ok = res.filter((r) => r.ok);
      const bad = res.filter((r) => !r.ok);
      if (ok.length) toast(t(`تمت إضافة ${ok.length} ملف`, `${ok.length} file(s) added`));
      for (const b of bad) toast(`${b.name}: ${failText(b.reason)}`, "err");
      onDone?.(ok.map((r) => r.attachment!));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }, [link, category, onDone, toast, t, failText]);
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); void handle(e.dataTransfer.files); }}
      className={cn("rounded-2xl border-2 border-dashed border-line text-center transition", drag && "border-accent bg-accent/10", compact ? "p-3" : "p-6")}
    >
      <input ref={input} type="file" multiple accept={ACCEPT_ATTR} className="sr-only" aria-label={t("اختيار ملفات", "Choose files")} onChange={(e) => e.target.files && void handle(e.target.files)} />
      <Button variant="primary" onClick={() => input.current?.click()} disabled={busy}>
        {busy ? <Loader2 className="animate-spin" size={16} /> : <Upload size={16} />}
        {t("إضافة ملفات", "Add files")}
      </Button>
      {!compact && <p className="mt-2 text-xs text-muted">{t("أو اسحب الملفات وأفلتها هنا — PDF، صور، نص، صوت", "or drag & drop files here — PDF, images, text, audio")}</p>}
    </div>
  );
}

export function Chip({ active, onClick, children }: { active?: boolean; onClick?: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active} className={cn("rounded-full border px-3 py-1 text-xs font-bold transition", active ? "border-primary bg-primary text-primary-fg" : "border-line bg-surface text-muted hover:bg-surface2")}>
      {children}
    </button>
  );
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { id: T; label: string; badge?: number }[] }) {
  return (
    <div role="tablist" className="mb-4 flex gap-1 overflow-x-auto rounded-2xl bg-surface2 p-1">
      {items.map((i) => (
        <button key={i.id} role="tab" aria-selected={value === i.id} onClick={() => onChange(i.id)}
          className={cn("flex shrink-0 items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-bold transition", value === i.id ? "bg-surface text-fg shadow" : "text-muted hover:text-fg")}>
          {i.label}
          {i.badge !== undefined && <span className="rounded-full bg-accent/15 px-1.5 text-xs text-accent">{i.badge}</span>}
        </button>
      ))}
    </div>
  );
}

export const relTime = (ms: number, lang: "ar" | "en") => {
  const diff = Date.now() - ms;
  const m = Math.floor(diff / 60000);
  const rtf = new Intl.RelativeTimeFormat(lang === "ar" ? "ar-u-nu-latn" : "en", { numeric: "auto" });
  if (m < 1) return rtf.format(0, "minute");
  if (m < 60) return rtf.format(-m, "minute");
  if (m < 1440) return rtf.format(-Math.floor(m / 60), "hour");
  return rtf.format(-Math.floor(m / 1440), "day");
};
