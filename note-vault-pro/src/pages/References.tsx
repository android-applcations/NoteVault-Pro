import { useLiveQuery } from "dexie-react-hooks";
import { Bookmark, Copy, Download, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { db } from "@/data/db";
import type { RefType, Reference } from "@/data/types";
import { citationToPlain, formatCitation, toBibtex, type CitationStyle } from "@/domain/citations";
import { safeUrl } from "@/domain/sanitize";
import { normalize, todayISO } from "@/domain/text";
import { deleteReference, emptyRef, saveReference, type RefInput } from "@/services/references";
import { useApp } from "@/ui/app-context";
import { useI18n } from "@/ui/i18n";
import { Badge, Button, EmptyState, Field, Input, Modal, PageHeader, Select, Textarea } from "@/ui/kit";
import { Chip, useSubjects } from "@/ui/shared";

const STYLES: [CitationStyle, string][] = [["apa", "APA 7"], ["mla", "MLA 9"], ["ieee", "IEEE"], ["chicago", "Chicago"]];

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a"); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
async function copy(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select();
    try { return document.execCommand("copy"); } finally { ta.remove(); }
  }
}

export default function References() {
  const { t } = useI18n();
  const { toast, confirm } = useApp();
  const [params, setParams] = useSearchParams();
  const subjects = useSubjects(true);
  const refs = useLiveQuery(() => db.references.toArray(), []);
  const [style, setStyle] = useState<CitationStyle>("apa");
  const [q, setQ] = useState("");
  const [type, setType] = useState<RefType | "all">("all");
  const [form, setForm] = useState<{ id?: string; data: RefInput } | null>(null);
  const types: Record<RefType, string> = { book: t("كتاب", "Book"), article: t("مقال علمي", "Journal article"), website: t("موقع إلكتروني", "Website"), thesis: t("بحث جامعي", "Thesis"), pdf: t("ملف PDF", "PDF"), lecture: t("محاضرة", "Lecture"), other: t("مصدر آخر", "Other") };

  useEffect(() => {
    const id = params.get("ref");
    if (id && refs) { const r = refs.find((x) => x.id === id); if (r) { const { id: rid, createdAt, updatedAt, ...data } = r; void createdAt; void updatedAt; setForm({ id: rid, data }); } params.delete("ref"); setParams(params, { replace: true }); }
  }, [params, refs, setParams]);

  const nq = normalize(q);
  const list = (refs ?? []).filter((r) => type === "all" || r.type === type).filter((r) => !nq || normalize(`${r.title} ${r.authors} ${r.year} ${r.container}`).includes(nq)).sort((a, b) => a.title.localeCompare(b.title));
  const cite = (r: Reference) => formatCitation(r, style);
  const save = async () => {
    if (!form) return;
    try { await saveReference(form.data, form.id); setForm(null); toast(t("تم الحفظ", "Saved")); }
    catch (e) { toast(e instanceof Error && e.message === "BAD_YEAR" ? t("السنة يجب أن تكون 4 أرقام", "Year must be 4 digits") : t("أدخل عنوان المرجع", "Enter the reference title"), "err"); }
  };
  const set = (p: Partial<RefInput>) => form && setForm({ ...form, data: { ...form.data, ...p } });
  const isArticle = form?.data.type === "article";
  const isWeb = form?.data.type === "website";

  return (
    <div>
      <PageHeader title={t("المراجع والمصادر", "References")} subtitle={t("تُنسَّق الاقتباسات من البيانات التي تدخلها فقط — لا يتحقق التطبيق من صحة المراجع.", "Citations are formatted from the data you enter only — the app does not verify references.")}
        actions={<><Button disabled={!list.length} onClick={async () => { const txt = list.map((r) => citationToPlain(cite(r))).join("\n\n"); (await copy(txt)) ? toast(t("تم نسخ الاقتباسات", "Citations copied")) : toast(t("تعذر النسخ", "Copy failed"), "err"); }}><Copy size={16} />{t("نسخ الكل", "Copy all")}</Button>
          <Button disabled={!list.length} onClick={() => download(`references-${style}.txt`, list.map((r) => citationToPlain(cite(r))).join("\n\n"))}><Download size={16} />TXT</Button>
          <Button disabled={!list.length} onClick={() => download("references.bib", list.map(toBibtex).join("\n"))}><Download size={16} />BibTeX</Button>
          <Button variant="primary" onClick={() => setForm({ data: { ...emptyRef(), accessed: todayISO() } })}><Plus size={16} />{t("مرجع", "Reference")}</Button></>} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {STYLES.map(([k, l]) => <Chip key={k} active={style === k} onClick={() => setStyle(k)}>{l}</Chip>)}
        <div className="ms-auto flex w-full gap-2 sm:w-auto"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("بحث…", "Search…")} aria-label={t("بحث في المراجع", "Search references")} dir="auto" className="sm:w-56" />
          <Select aria-label={t("النوع", "Type")} value={type} onChange={(e) => setType(e.target.value as RefType | "all")} className="sm:w-40"><option value="all">{t("كل الأنواع", "All types")}</option>{Object.entries(types).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></div>
      </div>
      {refs && list.length === 0 ? <EmptyState icon={<Bookmark />} title={t("لا توجد مراجع", "No references")} /> : (
        <ul className="space-y-3">
          {list.map((r) => {
            const parts = cite(r);
            const url = safeUrl(r.url);
            return (
              <li key={r.id} className="card-surface p-4">
                <div className="mb-2 flex flex-wrap items-center gap-2"><Badge>{types[r.type]}</Badge>{r.subjectId && <Badge>{subjects.find((s) => s.id === r.subjectId)?.name}</Badge>}
                  <div className="ms-auto flex">
                    <Button variant="ghost" className="!px-2" aria-label={t("نسخ الاقتباس", "Copy citation")} onClick={async () => (await copy(citationToPlain(parts))) ? toast(t("تم النسخ", "Copied")) : toast(t("تعذر النسخ", "Copy failed"), "err")}><Copy size={15} /></Button>
                    <Button variant="ghost" className="!px-2" aria-label={t("تعديل", "Edit")} onClick={() => { const { id, createdAt, updatedAt, ...data } = r; void createdAt; void updatedAt; setForm({ id, data }); }}><Pencil size={15} /></Button>
                    <Button variant="ghost" className="!px-2" aria-label={t("حذف", "Delete")} onClick={async () => { if (await confirm({ title: t("حذف المرجع؟", "Delete this reference?"), danger: true })) await deleteReference(r.id); }}><Trash2 size={15} className="text-danger" /></Button></div></div>
                <p className="nv-selectable ltr-iso text-sm leading-7" dir="ltr" lang="en">{parts.map((p, i) => (p.italic ? <i key={i}>{p.text}</i> : <span key={i}>{p.text}</span>))}</p>
                {url && <a href={url} target="_blank" rel="noopener noreferrer nofollow" className="mt-1 inline-block text-xs font-bold text-accent hover:underline">{t("فتح المصدر", "Open source")} ↗</a>}
                {r.notes && <p className="nv-selectable mt-2 rounded-xl bg-surface2 p-2 text-sm text-muted" dir="auto">{r.notes}</p>}
              </li>
            );
          })}
        </ul>
      )}
      <Modal open={!!form} onClose={() => setForm(null)} title={form?.id ? t("تعديل مرجع", "Edit reference") : t("مرجع جديد", "New reference")} wide footer={<><Button onClick={() => setForm(null)}>{t("إلغاء", "Cancel")}</Button><Button variant="primary" onClick={() => void save()}>{t("حفظ", "Save")}</Button></>}>
        {form && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("النوع", "Type")}>{(id) => <Select id={id} value={form.data.type} onChange={(e) => set({ type: e.target.value as RefType })}>{Object.entries(types).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
            <Field label={t("المادة", "Subject")}>{(id) => <Select id={id} value={form.data.subjectId ?? ""} onChange={(e) => set({ subjectId: e.target.value || undefined })}><option value="">—</option>{subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}</Field>
            <Field label={t("العنوان", "Title")} className="sm:col-span-2">{(id) => <Input id={id} value={form.data.title} onChange={(e) => set({ title: e.target.value })} dir="auto" />}</Field>
            <Field label={t("المؤلفون (سطر لكل مؤلف: الاسم الأول الأخير)", "Authors (one per line: First Last)")} className="sm:col-span-2">{(id) => <Textarea id={id} rows={2} value={form.data.authors} onChange={(e) => set({ authors: e.target.value })} dir="auto" />}</Field>
            {(isArticle || isWeb) && <Field label={isArticle ? t("المجلة", "Journal") : t("اسم الموقع", "Website name")}>{(id) => <Input id={id} value={form.data.container} onChange={(e) => set({ container: e.target.value })} dir="auto" />}</Field>}
            {!isArticle && <Field label={t("الناشر", "Publisher")}>{(id) => <Input id={id} value={form.data.publisher} onChange={(e) => set({ publisher: e.target.value })} dir="auto" />}</Field>}
            <Field label={t("سنة النشر", "Year")}>{(id) => <Input id={id} value={form.data.year} onChange={(e) => set({ year: e.target.value })} inputMode="numeric" maxLength={5} placeholder="2024" />}</Field>
            {isArticle && <><Field label={t("المجلد", "Volume")}>{(id) => <Input id={id} value={form.data.volume} onChange={(e) => set({ volume: e.target.value })} />}</Field><Field label={t("العدد", "Issue")}>{(id) => <Input id={id} value={form.data.issue} onChange={(e) => set({ issue: e.target.value })} />}</Field></>}
            <Field label={t("الصفحات", "Pages")}>{(id) => <Input id={id} value={form.data.pages} onChange={(e) => set({ pages: e.target.value })} placeholder="12-34" />}</Field>
            <Field label="DOI">{(id) => <Input id={id} dir="ltr" value={form.data.doi} onChange={(e) => set({ doi: e.target.value })} placeholder="10.xxxx/xxxxx" />}</Field>
            <Field label={t("الرابط", "URL")}>{(id) => <Input id={id} dir="ltr" value={form.data.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://" />}</Field>
            <Field label={t("تاريخ الوصول", "Accessed on")}>{(id) => <Input id={id} type="date" value={form.data.accessed} onChange={(e) => set({ accessed: e.target.value })} />}</Field>
            <Field label={t("ملاحظات شخصية", "Personal notes")} className="sm:col-span-2">{(id) => <Textarea id={id} rows={2} value={form.data.notes} onChange={(e) => set({ notes: e.target.value })} dir="auto" />}</Field>
          </div>
        )}
      </Modal>
    </div>
  );
}
