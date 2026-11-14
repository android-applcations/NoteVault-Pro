// PDF viewer built on PDF.js (loaded lazily, runs fully offline from the locally stored blob).
import { useLiveQuery } from "dexie-react-hooks";
import {
  Bookmark,
  BookmarkCheck,
  ChevronDown,
  ChevronUp,
  Highlighter,
  Layers,
  Maximize2,
  Minimize2,
  MessageSquarePlus,
  MoveHorizontal,
  PanelRight,
  Pause,
  Play,
  Search,
  Trash2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { db } from "@/data/db";
import type { Attachment, Highlight, HighlightRect } from "@/data/types";
import { safeHexColor } from "@/domain/sanitize";
import { makeSnippet, normalize, queryTerms } from "@/domain/text";
import { openPdf, pdfjs, type PDFDocumentProxy } from "@/files/pdf";
import { addAnnotation, addHighlight, pausePdfIndexing, processPdf, savePdfView, toggleBookmark } from "@/services/files";
import { useApp } from "@/ui/app-context";
import { useI18n } from "@/ui/i18n";
import { Button, IconButton, Input, ProgressBar, SnippetView, Textarea } from "@/ui/kit";
import { Tabs } from "@/ui/shared";
import { cn } from "@/utils/cn";

const PAGE_GAP = 16;
const OVERSCAN_PAGES = 2;
const PDF_HL_COLORS = ["#fde047", "#86efac", "#93c5fd", "#f9a8d4"] as const;

interface PageProps {
  doc: PDFDocumentProxy;
  n: number;
  scale: number;
  width: number;
  height: number;
  hitTerms: string[];
  pageHighlights: Highlight[];
  onMeasure: (n: number, unscaledW: number, unscaledH: number) => void;
}

const PdfPage = memo(function PdfPage({
  doc,
  n,
  scale,
  width,
  height,
  hitTerms,
  pageHighlights,
  onMeasure,
}: PageProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<unknown> } | null = null;
    let textLayer: { cancel: () => void; render: () => Promise<void> } | null = null;
    let pageProxy: Awaited<ReturnType<PDFDocumentProxy["getPage"]>> | null = null;

    const cEl = canvas.current;
    const tEl = text.current;

    (async () => {
      try {
        const page = await doc.getPage(n);
        pageProxy = page;
        if (cancelled || !cEl || !tEl) {
          page.cleanup();
          return;
        }
        const v1 = page.getViewport({ scale: 1 });
        onMeasure(n, v1.width, v1.height);

        const viewport = page.getViewport({ scale });
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        cEl.width = Math.floor(viewport.width * dpr);
        cEl.height = Math.floor(viewport.height * dpr);
        cEl.style.width = `${Math.floor(viewport.width)}px`;
        cEl.style.height = `${Math.floor(viewport.height)}px`;
        const ctx = cEl.getContext("2d");
        if (!ctx) {
          page.cleanup();
          return;
        }
        renderTask = page.render({
          canvasContext: ctx,
          viewport: page.getViewport({ scale: scale * dpr }),
          canvas: cEl,
        });
        await renderTask.promise;
        if (cancelled) {
          page.cleanup();
          return;
        }
        tEl.replaceChildren();
        tEl.style.setProperty("--total-scale-factor", String(scale));
        tEl.style.width = `${viewport.width}px`;
        tEl.style.height = `${viewport.height}px`;
        textLayer = new pdfjs.TextLayer({
          textContentSource: page.streamTextContent(),
          container: tEl,
          viewport,
        });
        await textLayer.render();
        if (!cancelled) setRendered(scale);
        page.cleanup();
      } catch (e) {
        if ((e as { name?: string })?.name !== "RenderingCancelledException") {
          console.warn("pdf page render failed", e);
        }
      }
    })();

    return () => {
      cancelled = true;
      try {
        renderTask?.cancel();
      } catch {
        /* ignore cancel errors */
      }
      try {
        textLayer?.cancel();
      } catch {
        /* ignore */
      }
      try {
        pageProxy?.cleanup();
      } catch {
        /* ignore */
      }
      if (cEl) {
        cEl.width = 0;
        cEl.height = 0;
      }
      tEl?.replaceChildren();
      setRendered(0);
    };
  }, [doc, n, scale, onMeasure]);

  // search + legacy (rect-less) highlight marks on the text layer
  const legacySavedTexts = useMemo(
    () => pageHighlights.filter((h) => !h.rects?.length).map((h) => normalize(h.text)),
    [pageHighlights]
  );

  useEffect(() => {
    const tl = text.current;
    if (!tl || !rendered) return;
    tl.querySelectorAll("span").forEach((s) => {
      const nt = normalize(s.textContent ?? "");
      s.classList.toggle("pdf-hit", !!nt && hitTerms.some((t) => nt.includes(t)));
      s.style.backgroundColor =
        nt.length > 2 && legacySavedTexts.some((h) => h.includes(nt)) ? "rgba(253,224,71,.45)" : "";
    });
  }, [rendered, hitTerms, legacySavedTexts]);

  return (
    <div
      data-page={n}
      className="pdf-page"
      style={{ width, height, marginBottom: PAGE_GAP }}
      aria-label={`Page ${n}`}
    >
      {!rendered && (
        <span className="pointer-events-none absolute inset-x-0 top-3 text-center text-xs font-bold text-muted">
          {n}
        </span>
      )}
      <canvas ref={canvas} />
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        {pageHighlights.flatMap((h) =>
          (h.rects ?? []).map((r, idx) => (
            <span
              key={`${h.id}-${idx}`}
              className="absolute rounded-xs opacity-45 mix-blend-multiply dark:opacity-35 dark:mix-blend-screen"
              style={{
                left: `${r.x * 100}%`,
                top: `${r.y * 100}%`,
                width: `${r.w * 100}%`,
                height: `${r.h * 100}%`,
                backgroundColor: safeHexColor(h.color, "#fde047"),
              }}
            />
          ))
        )}
      </div>
      <div ref={text} className="textLayer" />
    </div>
  );
});

function findPageAtY(y: number, starts: Float64Array, numPages: number): number {
  if (numPages <= 0) return 1;
  let lo = 0;
  let hi = numPages - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

export default function PdfViewer({
  att,
  blob,
  initialPage,
  initialQuery,
}: {
  att: Attachment;
  blob: Blob;
  initialPage?: number;
  initialQuery?: string;
}) {
  const { t, fmtNum } = useI18n();
  const { toast, openCard } = useApp();
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState(false);
  const [base, setBase] = useState({ w: 612, h: 792 });
  const [scale, setScale] = useState(1.2);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [range, setRange] = useState({ start: 1, end: 5 });
  const [dimsTick, setDimsTick] = useState(0);
  const [panel, setPanel] = useState(false);
  const [tab, setTab] = useState<"bookmarks" | "notes" | "highlights" | "search">("bookmarks");
  const [q, setQ] = useState(initialQuery ?? "");
  const [hitIdx, setHitIdx] = useState(0);
  const [note, setNote] = useState("");
  const [hlColor, setHlColor] = useState<string>(PDF_HL_COLORS[0]);
  const [full, setFull] = useState(false);

  const box = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pageDimsRef = useRef<Map<number, { w: number; h: number }>>(new Map());
  const restored = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestPageRef = useRef(1);
  const rafScrollRef = useRef<number | null>(null);
  const rafDimsRef = useRef<number | null>(null);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const programmaticScrollUntilRef = useRef(0);

  const meta = useLiveQuery(async () => (await db.pdfDocuments.get(att.id)) ?? null, [att.id]);
  const bookmarks = useLiveQuery(() => db.bookmarks.where("attachmentId").equals(att.id).sortBy("page"), [att.id]) ?? [];
  const annotations = useLiveQuery(() => db.annotations.where("attachmentId").equals(att.id).sortBy("page"), [att.id]) ?? [];
  const highlights = useLiveQuery(() => db.highlights.where("attachmentId").equals(att.id).sortBy("page"), [att.id]) ?? [];

  useEffect(() => {
    pageDimsRef.current.clear();
    restored.current = false;
    latestPageRef.current = 1;
    setDoc(null);
    setError(false);
    let alive = true;
    let d: PDFDocumentProxy | null = null;
    openPdf(blob)
      .then(async (p) => {
        d = p;
        if (!alive) return void p.destroy();
        const first = await p.getPage(1);
        const v = first.getViewport({ scale: 1 });
        first.cleanup();
        if (!alive) return void p.destroy();
        pageDimsRef.current.set(1, { w: v.width, h: v.height });
        setBase({ w: v.width, h: v.height });
        setDoc(p);
        setRange({ start: 1, end: Math.min(p.numPages, 1 + OVERSCAN_PAGES * 2) });
      })
      .catch(() => alive && setError(true));
    void processPdf(att.id).catch(() => undefined);
    return () => {
      alive = false;
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        void savePdfView(att.id, { lastPage: latestPageRef.current }).catch(() => undefined);
      }
      if (rafScrollRef.current) cancelAnimationFrame(rafScrollRef.current);
      if (rafDimsRef.current) cancelAnimationFrame(rafDimsRef.current);
      void d?.destroy();
    };
  }, [blob, att.id]);

  // Precomputed offset table in O(N) typed array for virtual scrolling
  const metrics = useMemo(() => {
    const numPages = doc?.numPages ?? 0;
    const starts = new Float64Array(numPages + 1);
    const heights = new Float64Array(numPages);
    const widths = new Float64Array(numPages);
    for (let i = 1; i <= numPages; i++) {
      const d = pageDimsRef.current.get(i) ?? base;
      const w = Math.floor(d.w * scale);
      const h = Math.floor(d.h * scale);
      widths[i - 1] = w;
      heights[i - 1] = h;
      starts[i] = starts[i - 1] + h + PAGE_GAP;
    }
    const totalHeight = numPages > 0 ? Math.max(0, starts[numPages] - PAGE_GAP) : 0;
    return { numPages, starts, heights, widths, totalHeight };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, base, scale, dimsTick]);
  const metricsRef = useRef(metrics);
  metricsRef.current = metrics;

  const onMeasurePage = useCallback((n: number, w: number, h: number) => {
    const prev = pageDimsRef.current.get(n);
    if (prev && Math.abs(prev.w - w) < 1 && Math.abs(prev.h - h) < 1) return;
    const oldH = Math.floor((prev?.h ?? base.h) * scaleRef.current);
    const newH = Math.floor(h * scaleRef.current);
    pageDimsRef.current.set(n, { w, h });
    if (n < latestPageRef.current && scroller.current && oldH !== newH) {
      scroller.current.scrollTop += newH - oldH;
    }
    if (!rafDimsRef.current) {
      rafDimsRef.current = requestAnimationFrame(() => {
        rafDimsRef.current = null;
        setDimsTick((v) => v + 1);
      });
    }
  }, [base.h]);

  const goTo = useCallback(
    (n: number, smooth = true) => {
      const m = metricsRef.current;
      const numPages = m.numPages || doc?.numPages || 1;
      const target = Math.max(1, Math.min(numPages, n));
      const useSmooth = smooth && Math.abs(target - latestPageRef.current) <= 4;
      latestPageRef.current = target;
      setPage(target);
      setPageInput(String(target));
      setRange({
        start: Math.max(1, target - OVERSCAN_PAGES),
        end: Math.min(numPages, target + OVERSCAN_PAGES + 1),
      });
      programmaticScrollUntilRef.current = Date.now() + (useSmooth ? 650 : 180);
      const y = m.starts[target - 1] ?? 0;
      if (scroller.current) {
        scroller.current.scrollTo({ top: Math.max(0, y - 4), behavior: useSmooth ? "smooth" : "auto" });
      }
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        void savePdfView(att.id, { lastPage: target });
      }, 300);
    },
    [att.id, doc]
  );

  // Restore lastPage and zoom once metadata & doc load
  useEffect(() => {
    if (!doc || restored.current || meta === undefined) return;
    restored.current = true;
    const restoredScale = meta?.zoom || 1.2;
    if (meta?.zoom) setScale(meta.zoom);
    const target = Math.min(Math.max(1, initialPage ?? meta?.lastPage ?? 1), doc.numPages);
    latestPageRef.current = target;
    setPage(target);
    setPageInput(String(target));
    setRange({
      start: Math.max(1, target - OVERSCAN_PAGES),
      end: Math.min(doc.numPages, target + OVERSCAN_PAGES + 1),
    });
    programmaticScrollUntilRef.current = Date.now() + 250;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const m = metricsRef.current;
        const y = m.starts[target - 1] ?? (target - 1) * (Math.floor(base.h * restoredScale) + PAGE_GAP);
        if (scroller.current) scroller.current.scrollTop = Math.max(0, y - 4);
      });
    });
  }, [doc, meta, initialPage, base.h]);

  const onScroll = useCallback(() => {
    if (rafScrollRef.current) return;
    rafScrollRef.current = requestAnimationFrame(() => {
      rafScrollRef.current = null;
      if (Date.now() < programmaticScrollUntilRef.current) return;
      const sc = scroller.current;
      const m = metricsRef.current;
      if (!sc || !m.numPages) return;
      const top = sc.scrollTop;
      const viewH = sc.clientHeight || 600;
      const firstVis = findPageAtY(top, m.starts, m.numPages);
      const lastVis = findPageAtY(top + viewH, m.starts, m.numPages);
      const nextStart = Math.max(1, firstVis - OVERSCAN_PAGES);
      const nextEnd = Math.min(m.numPages, lastVis + OVERSCAN_PAGES);
      setRange((prev) => (prev.start === nextStart && prev.end === nextEnd ? prev : { start: nextStart, end: nextEnd }));

      const cur = findPageAtY(top + viewH / 3, m.starts, m.numPages);
      if (cur !== latestPageRef.current) {
        latestPageRef.current = cur;
        setPage(cur);
        setPageInput(String(cur));
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          saveTimer.current = null;
          void savePdfView(att.id, { lastPage: cur });
        }, 600);
      }
    });
  }, [att.id]);

  const changeZoom = (s: number) => {
    const z = Math.max(0.5, Math.min(3.5, Math.round(s * 100) / 100));
    const curPage = latestPageRef.current;
    programmaticScrollUntilRef.current = Date.now() + 250;
    setScale(z);
    void savePdfView(att.id, { zoom: z });
    requestAnimationFrame(() => {
      const d = pageDimsRef.current.get(curPage) ?? base;
      let y = 0;
      for (let i = 1; i < curPage; i++) {
        const pd = pageDimsRef.current.get(i) ?? d;
        y += Math.floor(pd.h * z) + PAGE_GAP;
      }
      if (scroller.current) scroller.current.scrollTop = Math.max(0, y - 4);
    });
  };
  const fitWidth = () => {
    const w = (scroller.current?.clientWidth ?? 600) - 28;
    changeZoom(w / base.w);
  };

  useEffect(() => {
    if (!full) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFull(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [full]);
  const toggleFull = () => setFull((f) => !f);

  const terms = useMemo(() => queryTerms(q), [q]);
  const hits = useMemo(() => {
    if (!meta || !terms.length) return [] as { page: number; parts: { text: string; hit: boolean }[] }[];
    const out: { page: number; parts: { text: string; hit: boolean }[] }[] = [];
    meta.pageTexts.forEach((tx, i) => {
      const nt = normalize(tx);
      if (terms.every((tt) => nt.includes(tt))) out.push({ page: i + 1, parts: makeSnippet(tx, terms, 50).parts });
    });
    return out.slice(0, 300);
  }, [meta, terms]);
  useEffect(() => {
    setHitIdx(0);
  }, [q]);
  const jumpHit = (i: number) => {
    if (!hits.length) return;
    const k = (i + hits.length) % hits.length;
    setHitIdx(k);
    goTo(hits[k].page);
  };

  const highlightsByPage = useMemo(() => {
    const m = new Map<number, Highlight[]>();
    for (const h of highlights) {
      const arr = m.get(h.page) ?? [];
      arr.push(h);
      m.set(h.page, arr);
    }
    return m;
  }, [highlights]);

  const selection = () => {
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? "";
    let pg = page;
    const node = sel?.anchorNode instanceof Element ? sel.anchorNode : sel?.anchorNode?.parentElement;
    const holder = node?.closest("[data-page]") as HTMLElement | null;
    if (holder) pg = Number(holder.dataset.page);
    const rects: HighlightRect[] = [];
    if (sel && sel.rangeCount > 0 && holder) {
      const boxRect = holder.getBoundingClientRect();
      if (boxRect.width > 0 && boxRect.height > 0) {
        for (const r of Array.from(sel.getRangeAt(0).getClientRects())) {
          if (r.width < 2 || r.height < 2) continue;
          const x0 = Math.max(0, Math.min(1, (r.left - boxRect.left) / boxRect.width));
          const y0 = Math.max(0, Math.min(1, (r.top - boxRect.top) / boxRect.height));
          const x1 = Math.max(0, Math.min(1, (r.right - boxRect.left) / boxRect.width));
          const y1 = Math.max(0, Math.min(1, (r.bottom - boxRect.top) / boxRect.height));
          if (x1 - x0 <= 0.001 || y1 - y0 <= 0.001) continue;
          const nr: HighlightRect = {
            x: Math.round(x0 * 10000) / 10000,
            y: Math.round(y0 * 10000) / 10000,
            w: Math.round((x1 - x0) * 10000) / 10000,
            h: Math.round((y1 - y0) * 10000) / 10000,
          };
          const prev = rects[rects.length - 1];
          if (prev && Math.abs(prev.y - nr.y) < 0.008 && Math.abs(prev.h - nr.h) < 0.01) {
            const left = Math.min(prev.x, nr.x);
            const top = Math.min(prev.y, nr.y);
            const right = Math.max(prev.x + prev.w, nr.x + nr.w);
            const bottom = Math.max(prev.y + prev.h, nr.y + nr.h);
            prev.x = left;
            prev.y = top;
            prev.w = Math.round((right - left) * 10000) / 10000;
            prev.h = Math.round((bottom - top) * 10000) / 10000;
          } else {
            rects.push(nr);
          }
          if (rects.length >= 200) break;
        }
      }
    }
    return { text, page: pg, rects };
  };
  const isBookmarked = bookmarks.some((b) => b.page === page);

  const visiblePages = useMemo(() => {
    if (!doc || !metrics.numPages) return [] as number[];
    const s = Math.max(1, Math.min(metrics.numPages, range.start));
    const e = Math.max(s, Math.min(metrics.numPages, range.end));
    const out: number[] = [];
    for (let i = s; i <= e; i++) out.push(i);
    return out;
  }, [doc, metrics.numPages, range]);

  const topSpacer = metrics.numPages ? metrics.starts[Math.max(0, (visiblePages[0] ?? 1) - 1)] : 0;
  const lastShown = visiblePages[visiblePages.length - 1] ?? 0;
  const bottomSpacer =
    metrics.numPages && lastShown
      ? Math.max(0, metrics.totalHeight - Math.max(0, metrics.starts[lastShown] - PAGE_GAP))
      : 0;

  const totalDocPages = meta?.pages || doc?.numPages || 0;
  const indexedCount = meta?.indexedPages ?? meta?.pageTexts.length ?? 0;
  const indexPct = totalDocPages > 0 ? Math.min(100, Math.round((indexedCount / totalDocPages) * 100)) : 0;
  const indexStatus = meta?.indexStatus ?? (meta?.indexed ? "done" : "idle");

  if (error) {
    return (
      <p className="card-surface p-8 text-center text-danger">
        {t("تعذر فتح ملف PDF (قد يكون تالفاً).", "Could not open this PDF (it may be corrupted).")}
      </p>
    );
  }

  return (
    <div ref={box} className={cn("flex flex-col bg-bg", full && "safe-top safe-bottom safe-x fixed inset-0 z-50 p-2 sm:p-3")}>
      <div
        className="mb-2 flex flex-wrap items-center gap-1 rounded-2xl border border-line bg-surface p-1.5"
        role="toolbar"
        aria-label={t("أدوات PDF", "PDF tools")}
      >
        <IconButton label={t("الصفحة السابقة", "Previous page")} onClick={() => goTo(Math.max(1, page - 1))} disabled={page <= 1}>
          <ChevronUp size={18} />
        </IconButton>
        <form
          className="flex items-center gap-1 text-sm font-bold"
          onSubmit={(e) => {
            e.preventDefault();
            const n = Number(pageInput);
            if (doc && n >= 1 && n <= doc.numPages) goTo(n);
          }}
        >
          <input
            aria-label={t("رقم الصفحة", "Page number")}
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ""))}
            className="h-9 w-14 rounded-lg border border-line bg-surface text-center"
            inputMode="numeric"
          />
          <span className="text-muted">/ {doc?.numPages ?? "…"}</span>
        </form>
        <IconButton
          label={t("الصفحة التالية", "Next page")}
          onClick={() => doc && goTo(Math.min(doc.numPages, page + 1))}
          disabled={!doc || page >= doc.numPages}
        >
          <ChevronDown size={18} />
        </IconButton>
        <span className="mx-1 h-5 w-px bg-line" />
        <IconButton label={t("تصغير", "Zoom out")} onClick={() => changeZoom(scale - 0.15)}>
          <ZoomOut size={18} />
        </IconButton>
        <span className="w-12 text-center text-xs font-bold" dir="ltr">
          {Math.round(scale * 100)}%
        </span>
        <IconButton label={t("تكبير", "Zoom in")} onClick={() => changeZoom(scale + 0.15)}>
          <ZoomIn size={18} />
        </IconButton>
        <IconButton label={t("ملاءمة العرض", "Fit width")} onClick={fitWidth}>
          <MoveHorizontal size={18} />
        </IconButton>
        <span className="mx-1 h-5 w-px bg-line" />
        <IconButton
          label={isBookmarked ? t("إزالة الإشارة المرجعية", "Remove bookmark") : t("إشارة مرجعية", "Bookmark page")}
          aria-pressed={isBookmarked}
          onClick={async () => {
            const on = await toggleBookmark(att.id, page, `${t("صفحة", "Page")} ${page}`);
            toast(on ? t("أُضيفت إشارة مرجعية", "Bookmark added") : t("أُزيلت الإشارة", "Bookmark removed"));
          }}
          className={isBookmarked ? "text-accent" : ""}
        >
          {isBookmarked ? <BookmarkCheck size={18} /> : <Bookmark size={18} />}
        </IconButton>
        <div className="flex items-center gap-1">
          <IconButton
            label={t("تمييز النص المحدد", "Highlight selected text")}
            onClick={async () => {
              const s = selection();
              if (!s.text) return toast(t("حدد نصاً أولاً", "Select some text first"), "info");
              await addHighlight(att.id, s.page, s.text, hlColor, s.rects.length ? s.rects : undefined);
              window.getSelection()?.removeAllRanges();
              toast(t("تم حفظ التمييز", "Highlight saved"));
            }}
          >
            <Highlighter size={18} />
          </IconButton>
          {PDF_HL_COLORS.map((col) => (
            <button
              key={col}
              type="button"
              aria-label={`${t("لون التمييز", "Highlight color")} ${col}`}
              aria-pressed={hlColor === col}
              onClick={() => setHlColor(col)}
              className={cn("h-5 w-5 rounded-full border transition", hlColor === col ? "scale-110 border-fg ring-1 ring-fg" : "border-line")}
              style={{ backgroundColor: col }}
            />
          ))}
        </div>
        <IconButton
          label={t("بطاقة مراجعة من هذه الصفحة", "Flashcard from this page")}
          onClick={() => {
            const s = selection();
            openCard({
              front: s.text,
              subjectId: att.subjectId,
              source: { attachmentId: att.id, page: s.page, lectureId: att.lectureId, noteId: att.noteId },
            });
          }}
        >
          <Layers size={18} />
        </IconButton>
        <IconButton
          label={t("ملاحظة على الصفحة", "Page note")}
          onClick={() => {
            setPanel(true);
            setTab("notes");
          }}
        >
          <MessageSquarePlus size={18} />
        </IconButton>
        <div className="ms-auto flex items-center gap-1">
          {indexStatus === "indexing" && (
            <button
              type="button"
              onClick={() => pausePdfIndexing(att.id)}
              className="hidden items-center gap-1 rounded-lg bg-surface2 px-2.5 py-1 text-xs font-bold text-muted hover:text-fg sm:inline-flex"
              aria-label={t("إيقاف الفهرسة مؤقتاً", "Pause indexing")}
            >
              <Pause size={13} />
              <span>
                {fmtNum(indexedCount)}/{fmtNum(totalDocPages)}
              </span>
            </button>
          )}
          <IconButton
            label={t("بحث داخل الملف", "Search in file")}
            onClick={() => {
              setPanel(true);
              setTab("search");
            }}
          >
            <Search size={18} />
          </IconButton>
          <IconButton
            label={t("اللوحة الجانبية", "Side panel")}
            aria-pressed={panel}
            onClick={() => setPanel((p) => !p)}
            className={panel ? "bg-surface2" : ""}
          >
            <PanelRight size={18} className="rtl:-scale-x-100" />
          </IconButton>
          <IconButton
            label={full ? t("تصغير العرض", "Exit expanded view") : t("توسيع العرض", "Expand view")}
            aria-pressed={full}
            onClick={toggleFull}
          >
            {full ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
          </IconButton>
        </div>
      </div>

      <div className={cn("grid min-h-0 flex-1 gap-3", panel && "md:grid-cols-[1fr_18rem] lg:grid-cols-[1fr_20rem]")}>
        <div
          ref={scroller}
          onScroll={onScroll}
          className={cn("min-w-0 overflow-auto rounded-2xl bg-surface2 p-2 sm:p-3", full ? "min-h-0 flex-1" : "h-[68dvh] md:h-[74dvh]")}
          aria-label={t("صفحات المستند", "Document pages")}
        >
          {!doc ? (
            <p className="p-10 text-center text-muted">{t("جارٍ فتح الملف…", "Opening file…")}</p>
          ) : (
            <div>
              {topSpacer > 0 && <div style={{ height: topSpacer }} aria-hidden />}
              {visiblePages.map((n) => (
                <PdfPage
                  key={n}
                  doc={doc}
                  n={n}
                  scale={scale}
                  width={metrics.widths[n - 1] || Math.floor(base.w * scale)}
                  height={metrics.heights[n - 1] || Math.floor(base.h * scale)}
                  hitTerms={terms}
                  pageHighlights={highlightsByPage.get(n) ?? []}
                  onMeasure={onMeasurePage}
                />
              ))}
              {bottomSpacer > 0 && <div style={{ height: bottomSpacer }} aria-hidden />}
            </div>
          )}
        </div>
        {panel && (
          <aside className={cn("overflow-y-auto rounded-2xl border border-line bg-surface p-3", full ? "max-h-[38dvh] md:max-h-none md:h-full" : "max-h-[55dvh] md:max-h-[74dvh]")}>
            <Tabs
              value={tab}
              onChange={setTab}
              items={[
                { id: "bookmarks", label: t("إشارات", "Marks"), badge: bookmarks.length },
                { id: "notes", label: t("ملاحظات", "Notes"), badge: annotations.length },
                { id: "highlights", label: t("تمييز", "Highlights"), badge: highlights.length },
                { id: "search", label: t("بحث", "Search") },
              ]}
            />
            {tab === "bookmarks" &&
              (bookmarks.length ? (
                <ul className="space-y-1">
                  {bookmarks.map((b) => (
                    <li key={b.id} className="flex items-center gap-1">
                      <button
                        className="flex-1 rounded-lg px-3 py-2 text-start text-sm font-bold hover:bg-surface2"
                        onClick={() => goTo(b.page)}
                      >
                        {t("صفحة", "Page")} {b.page}
                      </button>
                      <IconButton label={t("حذف", "Delete")} onClick={() => void db.bookmarks.delete(b.id)}>
                        <Trash2 size={15} className="text-danger" />
                      </IconButton>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted">{t("لا توجد إشارات مرجعية", "No bookmarks")}</p>
              ))}
            {tab === "notes" && (
              <div className="space-y-3">
                <div className="space-y-2">
                  <Textarea
                    rows={3}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder={`${t("ملاحظة للصفحة", "Note for page")} ${page}`}
                    dir="auto"
                    aria-label={t("نص الملاحظة", "Note text")}
                  />
                  <Button
                    variant="primary"
                    disabled={!note.trim()}
                    onClick={async () => {
                      await addAnnotation(att.id, page, note);
                      setNote("");
                      toast(t("تمت إضافة الملاحظة", "Note added"));
                    }}
                  >
                    {t("إضافة", "Add")}
                  </Button>
                </div>
                <ul className="space-y-2">
                  {annotations.map((a) => (
                    <li key={a.id} className="rounded-xl bg-surface2 p-2.5 text-sm">
                      <button className="mb-1 text-xs font-bold text-accent" onClick={() => goTo(a.page)}>
                        {t("صفحة", "Page")} {a.page}
                      </button>
                      <p dir="auto" className="nv-selectable whitespace-pre-wrap">
                        {a.text}
                      </p>
                      <button className="mt-1 text-xs text-danger" onClick={() => void db.annotations.delete(a.id)}>
                        {t("حذف", "Delete")}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {tab === "highlights" &&
              (highlights.length ? (
                <ul className="space-y-2">
                  {highlights.map((h) => (
                    <li key={h.id} className="rounded-xl p-2.5 text-sm" style={{ background: safeHexColor(h.color, "#fde047") + "55" }}>
                      <button className="mb-1 text-xs font-bold" onClick={() => goTo(h.page)}>
                        {t("صفحة", "Page")} {h.page}
                      </button>
                      <p dir="auto" className="nv-selectable">{h.text}</p>
                      <div className="mt-1 flex gap-3 text-xs">
                        <button
                          className="font-bold text-accent"
                          onClick={() => openCard({ front: h.text, subjectId: att.subjectId, source: { attachmentId: att.id, page: h.page } })}
                        >
                          {t("بطاقة", "Flashcard")}
                        </button>
                        <button className="text-danger" onClick={() => void db.highlights.delete(h.id)}>
                          {t("حذف", "Delete")}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted">
                  {t("حدد نصاً ثم اضغط زر التمييز", "Select text then press the highlight button")}
                </p>
              ))}
            {tab === "search" && (
              <div className="space-y-2.5">
                <Input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={t("ابحث في نص الملف…", "Search the file text…")}
                  aria-label={t("بحث في الملف", "Search in file")}
                  dir="auto"
                  autoFocus
                  onKeyDown={(e) => e.key === "Enter" && jumpHit(hitIdx + (e.shiftKey ? -1 : 1))}
                />
                {totalDocPages > 0 && indexStatus !== "done" && (
                  <div className="rounded-xl border border-line bg-surface2 p-2.5 text-xs" aria-live="polite">
                    <div className="mb-1.5 flex items-center justify-between font-bold">
                      <span>
                        {indexStatus === "indexing"
                          ? t("جارٍ الفهرسة…", "Indexing…")
                          : indexStatus === "paused"
                          ? t("الفهرسة متوقفة مؤقتاً", "Indexing paused")
                          : t("فهرسة جزئية", "Partially indexed")}
                      </span>
                      <span dir="ltr">
                        {fmtNum(indexedCount)} / {fmtNum(totalDocPages)} ({indexPct}%)
                      </span>
                    </div>
                    <ProgressBar value={indexPct} />
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {indexStatus === "indexing" ? (
                        <Button className="!min-h-8 !px-2.5 !py-1 text-xs" onClick={() => pausePdfIndexing(att.id)}>
                          <Pause size={13} />
                          {t("إيقاف مؤقت", "Pause")}
                        </Button>
                      ) : indexedCount < totalDocPages ? (
                        <>
                          <Button
                            variant="primary"
                            className="!min-h-8 !px-2.5 !py-1 text-xs"
                            onClick={() => void processPdf(att.id, { continueFrom: true })}
                          >
                            <Play size={13} />
                            {indexStatus === "paused" ? t("استئناف الفهرسة", "Resume indexing") : t("فهرسة الصفحات التالية", "Index next pages")}
                          </Button>
                          {totalDocPages - indexedCount > 0 && (
                            <Button
                              className="!min-h-8 !px-2.5 !py-1 text-xs"
                              onClick={() => void processPdf(att.id, { continueFrom: true, limit: totalDocPages - indexedCount })}
                            >
                              {t("فهرسة الباقي", "Index all remaining")}
                            </Button>
                          )}
                        </>
                      ) : null}
                    </div>
                  </div>
                )}
                {indexStatus === "done" && meta && meta.pageTexts.every((p) => !p) && (
                  <p className="text-xs text-warn">
                    {t(
                      "لا يحتوي الملف على نص قابل للبحث (قد يكون صوراً ممسوحة).",
                      "This file has no searchable text (it may be scanned images)."
                    )}
                  </p>
                )}
                {q && (
                  <div className="flex items-center justify-between text-xs font-bold text-muted">
                    <span>
                      {hits.length} {t("صفحة", "pages")}
                    </span>
                    <span className="flex gap-1">
                      <button
                        onClick={() => jumpHit(hitIdx - 1)}
                        className="rounded p-1 hover:bg-surface2"
                        aria-label={t("السابق", "Previous")}
                      >
                        <ChevronUp size={14} />
                      </button>
                      <button
                        onClick={() => jumpHit(hitIdx + 1)}
                        className="rounded p-1 hover:bg-surface2"
                        aria-label={t("التالي", "Next")}
                      >
                        <ChevronDown size={14} />
                      </button>
                    </span>
                  </div>
                )}
                <ul className="space-y-1">
                  {hits.map((h, i) => (
                    <li key={h.page}>
                      <button
                        onClick={() => {
                          setHitIdx(i);
                          goTo(h.page);
                        }}
                        className={cn("w-full rounded-lg p-2 text-start text-xs hover:bg-surface2", i === hitIdx && "bg-surface2")}
                      >
                        <b className="text-accent">
                          {t("صفحة", "p.")} {h.page}
                        </b>{" "}
                        <span dir="auto">
                          <SnippetView parts={h.parts} />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
