// PDF viewer built on PDF.js (loaded lazily, runs fully offline from the locally stored blob).
import { useLiveQuery } from "dexie-react-hooks";
import { Bookmark, BookmarkCheck, ChevronDown, ChevronUp, Highlighter, Layers, Maximize2, Minimize2, MessageSquarePlus, PanelRight, Search, Trash2, ZoomIn, ZoomOut, MoveHorizontal } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { db } from "@/data/db";
import type { Attachment } from "@/data/types";
import { openPdf, pdfjs, type PDFDocumentProxy } from "@/files/pdf";
import { makeSnippet, normalize, queryTerms } from "@/domain/text";
import { addAnnotation, addHighlight, processPdf, savePdfView, toggleBookmark } from "@/services/files";
import { useApp } from "@/ui/app-context";
import { useI18n } from "@/ui/i18n";
import { Button, IconButton, Input, SnippetView, Textarea } from "@/ui/kit";
import { Tabs } from "@/ui/shared";
import { cn } from "@/utils/cn";

interface PageProps {
  doc: PDFDocumentProxy;
  n: number;
  scale: number;
  base: { w: number; h: number };
  hitTerms: string[];
  savedTexts: string[];
}

const PdfPage = memo(function PdfPage({ doc, n, scale, base, hitTerms, savedTexts }: PageProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [size, setSize] = useState({ w: base.w * scale, h: base.h * scale });
  const [rendered, setRendered] = useState(0);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: "700px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => { if (!rendered) setSize({ w: base.w * scale, h: base.h * scale }); }, [base, scale, rendered]);

  useEffect(() => {
    if (!visible) {
      // release memory of off-screen pages
      if (canvas.current) { canvas.current.width = 0; canvas.current.height = 0; }
      text.current?.replaceChildren();
      setRendered(0);
      return;
    }
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<unknown> } | null = null;
    (async () => {
      try {
        const page = await doc.getPage(n);
        if (cancelled || !canvas.current || !text.current) return;
        const viewport = page.getViewport({ scale });
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const c = canvas.current;
        c.width = Math.floor(viewport.width * dpr);
        c.height = Math.floor(viewport.height * dpr);
        c.style.width = `${Math.floor(viewport.width)}px`;
        c.style.height = `${Math.floor(viewport.height)}px`;
        setSize({ w: viewport.width, h: viewport.height });
        const ctx = c.getContext("2d")!;
        task = page.render({ canvasContext: ctx, viewport: page.getViewport({ scale: scale * dpr }), canvas: c });
        await task.promise;
        if (cancelled) return;
        const tl = text.current;
        tl.replaceChildren();
        tl.style.setProperty("--total-scale-factor", String(scale));
        tl.style.width = `${viewport.width}px`;
        tl.style.height = `${viewport.height}px`;
        const layer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: tl, viewport });
        await layer.render();
        if (!cancelled) setRendered(scale);
        page.cleanup();
      } catch (e) {
        if ((e as { name?: string })?.name !== "RenderingCancelledException") console.warn("pdf page render failed", e);
      }
    })();
    return () => { cancelled = true; task?.cancel(); };
  }, [visible, doc, n, scale]);

  // search + saved highlight marks on the text layer
  useEffect(() => {
    const tl = text.current;
    if (!tl || !rendered) return;
    tl.querySelectorAll("span").forEach((s) => {
      const nt = normalize(s.textContent ?? "");
      s.classList.toggle("pdf-hit", !!nt && hitTerms.some((t) => nt.includes(t)));
      s.style.backgroundColor = nt.length > 2 && savedTexts.some((h) => h.includes(nt)) ? "rgba(253,224,71,.45)" : "";
    });
  }, [rendered, hitTerms, savedTexts]);

  return (
    <div ref={wrap} data-page={n} className="pdf-page" style={{ width: size.w, height: size.h }} aria-label={`Page ${n}`}>
      <canvas ref={canvas} />
      <div ref={text} className="textLayer" />
    </div>
  );
});

export default function PdfViewer({ att, blob, initialPage, initialQuery }: { att: Attachment; blob: Blob; initialPage?: number; initialQuery?: string }) {
  const { t } = useI18n();
  const { toast, openCard } = useApp();
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState(false);
  const [base, setBase] = useState({ w: 612, h: 792 });
  const [scale, setScale] = useState(1.2);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [panel, setPanel] = useState(false);
  const [tab, setTab] = useState<"bookmarks" | "notes" | "highlights" | "search">("bookmarks");
  const [q, setQ] = useState(initialQuery ?? "");
  const [hitIdx, setHitIdx] = useState(0);
  const [note, setNote] = useState("");
  const [full, setFull] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const restored = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const meta = useLiveQuery(() => db.pdfDocuments.get(att.id), [att.id]);
  const bookmarks = useLiveQuery(() => db.bookmarks.where("attachmentId").equals(att.id).sortBy("page"), [att.id]) ?? [];
  const annotations = useLiveQuery(() => db.annotations.where("attachmentId").equals(att.id).sortBy("page"), [att.id]) ?? [];
  const highlights = useLiveQuery(() => db.highlights.where("attachmentId").equals(att.id).sortBy("page"), [att.id]) ?? [];

  useEffect(() => {
    let alive = true;
    let d: PDFDocumentProxy | null = null;
    openPdf(blob).then(async (p) => {
      d = p;
      if (!alive) return void p.destroy();
      const first = await p.getPage(1);
      const v = first.getViewport({ scale: 1 });
      setBase({ w: v.width, h: v.height });
      setDoc(p);
    }).catch(() => alive && setError(true));
    void processPdf(att.id).catch(() => undefined); // make sure text is extracted/indexed
    return () => { alive = false; void d?.destroy(); };
  }, [blob, att.id]);

  // restore last page and zoom once
  useEffect(() => {
    if (!doc || restored.current || meta === undefined) return;
    restored.current = true;
    if (meta?.zoom) setScale(meta.zoom);
    const target = initialPage ?? meta?.lastPage ?? 1;
    setTimeout(() => goTo(Math.min(Math.max(1, target), doc.numPages), false), 120);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, meta]);

  const goTo = useCallback((n: number, smooth = true) => {
    const el = scroller.current?.querySelector<HTMLElement>(`[data-page="${n}"]`);
    if (el && scroller.current) scroller.current.scrollTo({ top: el.offsetTop - 12, behavior: smooth ? "smooth" : "auto" });
    setPage(n); setPageInput(String(n));
  }, []);

  const onScroll = useCallback(() => {
    const sc = scroller.current;
    if (!sc) return;
    const mid = sc.scrollTop + sc.clientHeight / 3;
    const pages = sc.querySelectorAll<HTMLElement>("[data-page]");
    let cur = 1;
    for (const p of Array.from(pages)) { if (p.offsetTop <= mid) cur = Number(p.dataset.page); else break; }
    setPage((o) => { if (o !== cur) { setPageInput(String(cur)); if (saveTimer.current) clearTimeout(saveTimer.current); saveTimer.current = setTimeout(() => void savePdfView(att.id, { lastPage: cur }), 600); } return cur; });
  }, [att.id]);

  const changeZoom = (s: number) => { const z = Math.max(0.5, Math.min(3.5, Math.round(s * 100) / 100)); setScale(z); void savePdfView(att.id, { zoom: z }); };
  const fitWidth = () => { const w = (scroller.current?.clientWidth ?? 600) - 24; changeZoom(w / base.w); };

  useEffect(() => { const h = () => setFull(!!document.fullscreenElement); document.addEventListener("fullscreenchange", h); return () => document.removeEventListener("fullscreenchange", h); }, []);
  const toggleFull = async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await box.current?.requestFullscreen(); } catch { toast(t("المتصفح لا يدعم ملء الشاشة", "Fullscreen not supported"), "err"); } };

  // text search across stored page texts
  const terms = useMemo(() => queryTerms(q), [q]);
  const hits = useMemo(() => {
    if (!meta || !terms.length) return [] as { page: number; parts: { text: string; hit: boolean }[] }[];
    const out: { page: number; parts: { text: string; hit: boolean }[] }[] = [];
    meta.pageTexts.forEach((tx, i) => { const nt = normalize(tx); if (terms.every((tt) => nt.includes(tt))) out.push({ page: i + 1, parts: makeSnippet(tx, terms, 50).parts }); });
    return out.slice(0, 300);
  }, [meta, terms]);
  useEffect(() => { setHitIdx(0); }, [q]);
  const jumpHit = (i: number) => { if (!hits.length) return; const k = (i + hits.length) % hits.length; setHitIdx(k); goTo(hits[k].page); };
  const savedTexts = useMemo(() => highlights.map((h) => normalize(h.text)), [highlights]);

  const selection = () => {
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? "";
    let pg = page;
    const node = sel?.anchorNode instanceof Element ? sel.anchorNode : sel?.anchorNode?.parentElement;
    const holder = node?.closest("[data-page]") as HTMLElement | null;
    if (holder) pg = Number(holder.dataset.page);
    return { text, page: pg };
  };
  const isBookmarked = bookmarks.some((b) => b.page === page);

  if (error) return <p className="card-surface p-8 text-center text-danger">{t("تعذر فتح ملف PDF (قد يكون تالفاً).", "Could not open this PDF (it may be corrupted).")}</p>;

  return (
    <div ref={box} className={cn("flex flex-col bg-bg", full && "h-screen p-2")}>
      <div className="mb-2 flex flex-wrap items-center gap-1 rounded-2xl border border-line bg-surface p-1.5" role="toolbar" aria-label={t("أدوات PDF", "PDF tools")}>
        <IconButton label={t("الصفحة السابقة", "Previous page")} onClick={() => goTo(Math.max(1, page - 1))} disabled={page <= 1}><ChevronUp size={18} /></IconButton>
        <form className="flex items-center gap-1 text-sm font-bold" onSubmit={(e) => { e.preventDefault(); const n = Number(pageInput); if (doc && n >= 1 && n <= doc.numPages) goTo(n); }}>
          <input aria-label={t("رقم الصفحة", "Page number")} value={pageInput} onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ""))} className="h-9 w-14 rounded-lg border border-line bg-surface text-center" inputMode="numeric" />
          <span className="text-muted">/ {doc?.numPages ?? "…"}</span>
        </form>
        <IconButton label={t("الصفحة التالية", "Next page")} onClick={() => doc && goTo(Math.min(doc.numPages, page + 1))} disabled={!doc || page >= doc.numPages}><ChevronDown size={18} /></IconButton>
        <span className="mx-1 h-5 w-px bg-line" />
        <IconButton label={t("تصغير", "Zoom out")} onClick={() => changeZoom(scale - 0.15)}><ZoomOut size={18} /></IconButton>
        <span className="w-12 text-center text-xs font-bold" dir="ltr">{Math.round(scale * 100)}%</span>
        <IconButton label={t("تكبير", "Zoom in")} onClick={() => changeZoom(scale + 0.15)}><ZoomIn size={18} /></IconButton>
        <IconButton label={t("ملاءمة العرض", "Fit width")} onClick={fitWidth}><MoveHorizontal size={18} /></IconButton>
        <span className="mx-1 h-5 w-px bg-line" />
        <IconButton label={isBookmarked ? t("إزالة الإشارة المرجعية", "Remove bookmark") : t("إشارة مرجعية", "Bookmark page")} aria-pressed={isBookmarked} onClick={async () => { const on = await toggleBookmark(att.id, page, `${t("صفحة", "Page")} ${page}`); toast(on ? t("أُضيفت إشارة مرجعية", "Bookmark added") : t("أُزيلت الإشارة", "Bookmark removed")); }} className={isBookmarked ? "text-accent" : ""}>{isBookmarked ? <BookmarkCheck size={18} /> : <Bookmark size={18} />}</IconButton>
        <IconButton label={t("تمييز النص المحدد", "Highlight selected text")} onClick={async () => { const s = selection(); if (!s.text) return toast(t("حدد نصاً أولاً", "Select some text first"), "info"); await addHighlight(att.id, s.page, s.text); toast(t("تم حفظ التمييز", "Highlight saved")); }}><Highlighter size={18} /></IconButton>
        <IconButton label={t("بطاقة مراجعة من هذه الصفحة", "Flashcard from this page")} onClick={() => { const s = selection(); openCard({ front: s.text, subjectId: att.subjectId, source: { attachmentId: att.id, page: s.page, lectureId: att.lectureId, noteId: att.noteId } }); }}><Layers size={18} /></IconButton>
        <IconButton label={t("ملاحظة على الصفحة", "Page note")} onClick={() => { setPanel(true); setTab("notes"); }}><MessageSquarePlus size={18} /></IconButton>
        <div className="ms-auto flex items-center gap-1">
          <IconButton label={t("بحث داخل الملف", "Search in file")} onClick={() => { setPanel(true); setTab("search"); }}><Search size={18} /></IconButton>
          <IconButton label={t("اللوحة الجانبية", "Side panel")} aria-pressed={panel} onClick={() => setPanel((p) => !p)} className={panel ? "bg-surface2" : ""}><PanelRight size={18} className="rtl:-scale-x-100" /></IconButton>
          <IconButton label={full ? t("إنهاء ملء الشاشة", "Exit fullscreen") : t("ملء الشاشة", "Fullscreen")} onClick={() => void toggleFull()}>{full ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</IconButton>
        </div>
      </div>

      <div className={cn("grid min-h-0 flex-1 gap-3", panel && "lg:grid-cols-[1fr_20rem]")}>
        <div ref={scroller} onScroll={onScroll} className={cn("overflow-auto rounded-2xl bg-surface2 p-3", full ? "h-[calc(100vh-4.5rem)]" : "h-[72dvh]")} aria-label={t("صفحات المستند", "Document pages")}>
          {!doc ? <p className="p-10 text-center text-muted">{t("جارٍ فتح الملف…", "Opening file…")}</p> :
            Array.from({ length: doc.numPages }, (_, i) => <PdfPage key={i + 1} doc={doc} n={i + 1} scale={scale} base={base} hitTerms={terms} savedTexts={savedTexts} />)}
        </div>
        {panel && (
          <aside className={cn("overflow-y-auto rounded-2xl border border-line bg-surface p-3", full ? "h-[calc(100vh-4.5rem)]" : "max-h-[72dvh]")}>
            <Tabs value={tab} onChange={setTab} items={[{ id: "bookmarks", label: t("إشارات", "Marks"), badge: bookmarks.length }, { id: "notes", label: t("ملاحظات", "Notes"), badge: annotations.length }, { id: "highlights", label: t("تمييز", "Highlights"), badge: highlights.length }, { id: "search", label: t("بحث", "Search") }]} />
            {tab === "bookmarks" && (bookmarks.length ? <ul className="space-y-1">{bookmarks.map((b) => <li key={b.id} className="flex items-center gap-1"><button className="flex-1 rounded-lg px-3 py-2 text-start text-sm font-bold hover:bg-surface2" onClick={() => goTo(b.page)}>{t("صفحة", "Page")} {b.page}</button><IconButton label={t("حذف", "Delete")} onClick={() => void db.bookmarks.delete(b.id)}><Trash2 size={15} className="text-danger" /></IconButton></li>)}</ul> : <p className="text-sm text-muted">{t("لا توجد إشارات مرجعية", "No bookmarks")}</p>)}
            {tab === "notes" && (
              <div className="space-y-3">
                <div className="space-y-2"><Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder={`${t("ملاحظة للصفحة", "Note for page")} ${page}`} dir="auto" aria-label={t("نص الملاحظة", "Note text")} />
                  <Button variant="primary" disabled={!note.trim()} onClick={async () => { await addAnnotation(att.id, page, note); setNote(""); toast(t("تمت إضافة الملاحظة", "Note added")); }}>{t("إضافة", "Add")}</Button></div>
                <ul className="space-y-2">{annotations.map((a) => <li key={a.id} className="rounded-xl bg-surface2 p-2.5 text-sm"><button className="mb-1 text-xs font-bold text-accent" onClick={() => goTo(a.page)}>{t("صفحة", "Page")} {a.page}</button><p dir="auto" className="whitespace-pre-wrap">{a.text}</p><button className="mt-1 text-xs text-danger" onClick={() => void db.annotations.delete(a.id)}>{t("حذف", "Delete")}</button></li>)}</ul>
              </div>
            )}
            {tab === "highlights" && (highlights.length ? <ul className="space-y-2">{highlights.map((h) => <li key={h.id} className="rounded-xl p-2.5 text-sm" style={{ background: h.color + "55" }}><button className="mb-1 text-xs font-bold" onClick={() => goTo(h.page)}>{t("صفحة", "Page")} {h.page}</button><p dir="auto">{h.text}</p>
              <div className="mt-1 flex gap-3 text-xs"><button className="font-bold text-accent" onClick={() => openCard({ front: h.text, subjectId: att.subjectId, source: { attachmentId: att.id, page: h.page } })}>{t("بطاقة", "Flashcard")}</button><button className="text-danger" onClick={() => void db.highlights.delete(h.id)}>{t("حذف", "Delete")}</button></div></li>)}</ul> : <p className="text-sm text-muted">{t("حدد نصاً ثم اضغط زر التمييز", "Select text then press the highlight button")}</p>)}
            {tab === "search" && (
              <div className="space-y-2">
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("ابحث في نص الملف…", "Search the file text…")} aria-label={t("بحث في الملف", "Search in file")} dir="auto" autoFocus onKeyDown={(e) => e.key === "Enter" && jumpHit(hitIdx + (e.shiftKey ? -1 : 1))} />
                {!meta?.indexed && <p className="text-xs text-muted">{t("جارٍ استخراج النص…", "Extracting text…")}</p>}
                {meta?.indexed && meta.pageTexts.every((p) => !p) && <p className="text-xs text-warn">{t("لا يحتوي الملف على نص قابل للبحث (قد يكون صوراً ممسوحة).", "This file has no searchable text (it may be scanned images).")}</p>}
                {q && <div className="flex items-center justify-between text-xs font-bold text-muted"><span>{hits.length} {t("صفحة", "pages")}</span><span className="flex gap-1"><button onClick={() => jumpHit(hitIdx - 1)} className="rounded p-1 hover:bg-surface2" aria-label={t("السابق", "Previous")}><ChevronUp size={14} /></button><button onClick={() => jumpHit(hitIdx + 1)} className="rounded p-1 hover:bg-surface2" aria-label={t("التالي", "Next")}><ChevronDown size={14} /></button></span></div>}
                <ul className="space-y-1">{hits.map((h, i) => <li key={h.page}><button onClick={() => { setHitIdx(i); goTo(h.page); }} className={cn("w-full rounded-lg p-2 text-start text-xs hover:bg-surface2", i === hitIdx && "bg-surface2")}><b className="text-accent">{t("صفحة", "p.")} {h.page}</b> <span dir="auto"><SnippetView parts={h.parts} /></span></button></li>)}</ul>
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
