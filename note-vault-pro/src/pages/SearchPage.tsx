import { useLiveQuery } from "dexie-react-hooks";
import { BookOpen, Clock, FileText, FileType2, History, Layers, Link2, NotebookText, Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { db } from "@/data/db";
import type { SearchKind } from "@/data/types";
import { clearRecentSearches, getRecentSearches, pushRecentSearch, search, suggest, type SearchHit } from "@/services/search";
import { useI18n } from "@/ui/i18n";
import { Badge, EmptyState, Input, PageHeader, Select, SnippetView } from "@/ui/kit";
import { Chip, useDebounced, useSubjects } from "@/ui/shared";

const ICONS: Record<SearchKind, React.ReactNode> = {
  subject: <BookOpen size={16} />, lecture: <Clock size={16} />, note: <NotebookText size={16} />, file: <FileText size={16} />, pdf: <FileType2 size={16} />, card: <Layers size={16} />, reference: <Link2 size={16} />,
};

export default function SearchPage() {
  const { t, fmtDate } = useI18n();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [kinds, setKinds] = useState<SearchKind[]>([]);
  const [subjectId, setSubjectId] = useState("");
  const [range, setRange] = useState("all");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [recent, setRecent] = useState<string[]>([]);
  const subjects = useSubjects(true);
  const dq = useDebounced(q, 150);
  const subjectMap = new Map(subjects.map((s) => [s.id, s.name]));
  const lectures = useLiveQuery(() => db.lectures.toArray(), []) ?? [];
  const lMap = new Map(lectures.map((l) => [l.id, l.title]));

  useEffect(() => { const p = params.get("q"); if (p !== null && p !== q) setQ(p); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [params]);
  useEffect(() => { void getRecentSearches().then(setRecent); }, []);
  useEffect(() => {
    let alive = true;
    if (!dq.trim()) { setHits(null); setSuggestions([]); return; }
    const from = range === "all" ? undefined : Date.now() - ({ week: 7, month: 30, year: 365 } as Record<string, number>)[range] * 86400000;
    search(dq, { kinds: kinds.length ? kinds : undefined, subjectId: subjectId || undefined, from }).then((h) => alive && setHits(h));
    suggest(dq.split(/\s+/).pop() ?? "").then((s) => alive && setSuggestions(s));
    return () => { alive = false; };
  }, [dq, kinds, subjectId, range]);

  const toggleKind = (k: SearchKind) => setKinds((c) => (c.includes(k) ? c.filter((x) => x !== k) : [...c, k]));
  const labels: Record<SearchKind, string> = { subject: t("مواد", "Subjects"), lecture: t("محاضرات", "Lectures"), note: t("ملاحظات", "Notes"), file: t("ملفات", "Files"), pdf: "PDF", card: t("بطاقات", "Cards"), reference: t("مراجع", "References") };
  const go = (h: SearchHit) => {
    void pushRecentSearch(dq);
    const term = encodeURIComponent(dq.replace(/"/g, ""));
    switch (h.doc.kind) {
      case "subject": return nav(`/subjects/${h.doc.refId}`);
      case "lecture": return nav(`/lectures/${h.doc.refId}`);
      case "note": return nav(`/notes/${h.doc.refId}?q=${term}`);
      case "pdf": return nav(`/files/${h.doc.refId}?page=${h.page ?? 1}&q=${term}`);
      case "file": return nav(`/files/${h.doc.refId}`);
      case "card": return nav(`/flashcards?card=${h.doc.refId}`);
      case "reference": return nav(`/references?ref=${h.doc.refId}`);
    }
  };
  return (
    <div>
      <PageHeader title={t("البحث الشامل", "Universal search")} subtitle={t("ابحث في المواد والمحاضرات والملاحظات والملفات والبطاقات", "Search subjects, lectures, notes, files and cards")} />
      <div className="relative">
        <Search size={18} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted" />
        <Input autoFocus value={q} aria-label={t("كلمة البحث", "Search query")} placeholder={t('اكتب كلمة أو "عبارة بين علامتين"…', 'Type a word or "an exact phrase"…')} className="!h-12 ps-10 text-base" dir="auto"
          onChange={(e) => { setQ(e.target.value); setParams(e.target.value ? { q: e.target.value } : {}, { replace: true }); }} />
        {q && <button aria-label={t("مسح", "Clear")} className="absolute end-3 top-1/2 -translate-y-1/2 text-muted" onClick={() => { setQ(""); setParams({}, { replace: true }); }}><X size={16} /></button>}
      </div>
      {suggestions.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{suggestions.map((s) => <Chip key={s} onClick={() => { const parts = q.split(/\s+/); parts[parts.length - 1] = s; setQ(parts.join(" ")); }}>{s}</Chip>)}</div>}
      <div className="my-4 flex flex-wrap items-center gap-2">
        {(Object.keys(labels) as SearchKind[]).map((k) => <Chip key={k} active={kinds.includes(k)} onClick={() => toggleKind(k)}>{labels[k]}</Chip>)}
        <div className="flex w-full flex-wrap gap-2 sm:ms-auto sm:w-auto">
          <div className="min-w-0 flex-1 sm:w-40 sm:flex-none"><Select aria-label={t("المادة", "Subject")} value={subjectId} onChange={(e) => setSubjectId(e.target.value)}><option value="">{t("كل المواد", "All subjects")}</option>{subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></div>
          <div className="min-w-0 flex-1 sm:w-36 sm:flex-none"><Select aria-label={t("التاريخ", "Date")} value={range} onChange={(e) => setRange(e.target.value)}><option value="all">{t("أي تاريخ", "Any date")}</option><option value="week">{t("آخر 7 أيام", "Last 7 days")}</option><option value="month">{t("آخر 30 يوماً", "Last 30 days")}</option><option value="year">{t("آخر سنة", "Last year")}</option></Select></div>
        </div>
      </div>
      {hits === null ? (
        <div>
          {recent.length > 0 && (
            <div className="card-surface p-4"><div className="mb-2 flex items-center justify-between text-sm font-bold"><span className="flex items-center gap-2"><History size={15} />{t("عمليات البحث الأخيرة", "Recent searches")}</span>
              <button className="text-xs text-muted hover:text-danger" onClick={async () => { await clearRecentSearches(); setRecent([]); }}>{t("مسح السجل", "Clear")}</button></div>
              <div className="flex flex-wrap gap-2">{recent.map((r) => <Chip key={r} onClick={() => { setQ(r); setParams({ q: r }); }}>{r}</Chip>)}</div></div>
          )}
          {recent.length === 0 && <EmptyState icon={<Search />} title={t("ابدأ بالكتابة", "Start typing")} hint={t("يدعم البحث العربية والإنجليزية، ويتجاهل التشكيل واختلاف الهمزات، ويطابق جزءاً من الكلمة.", "Works in Arabic and English, ignores diacritics and letter variants, and matches partial words.")} />}
        </div>
      ) : hits.length === 0 ? <EmptyState icon={<Search />} title={t("لا توجد نتائج", "No results")} hint={t("جرّب كلمات أقل أو تحقق من الفلاتر.", "Try fewer words or check the filters.")} /> : (
        <ul className="space-y-2" aria-label={t("نتائج البحث", "Search results")}>
          <li className="text-xs font-bold text-muted">{hits.length} {t("نتيجة", "results")}</li>
          {hits.map((h) => (
            <li key={h.doc.id}>
              <button onClick={() => go(h)} className="card-surface block w-full p-4 text-start transition hover:border-accent">
                <div className="flex items-center gap-2"><span className="text-accent">{ICONS[h.doc.kind]}</span><span className="truncate font-extrabold" dir="auto">{h.doc.title || t("بدون عنوان", "Untitled")}</span><Badge>{labels[h.doc.kind]}</Badge>{h.page && <Badge>{t("صفحة", "p.")} {h.page}</Badge>}</div>
                {h.parts.length > 0 && <p className="mt-1.5 text-sm text-muted" dir="auto"><SnippetView parts={h.parts} /></p>}
                <div className="mt-1.5 flex flex-wrap gap-1.5 text-xs text-muted">
                  {h.doc.subjectId && subjectMap.get(h.doc.subjectId) && <span>{subjectMap.get(h.doc.subjectId)}</span>}
                  {h.doc.lectureId && lMap.get(h.doc.lectureId) && h.doc.kind !== "lecture" && <span>› {lMap.get(h.doc.lectureId)}</span>}
                  <span>· {fmtDate(h.doc.updatedAt)}</span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
