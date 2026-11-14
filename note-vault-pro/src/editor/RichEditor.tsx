// Presentation layer – rich-text editor UI (toolbar, selection bubble, slash menu, image viewer).
import type { Editor, JSONContent } from "@tiptap/core";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import {
  AlignCenter, AlignLeft, AlignRight, Bold, Code2, Copy, FileText, Heading1, Heading2, Heading3, Highlighter, ImagePlus, Italic, Layers, Link2, List, ListChecks, ListOrdered,
  Minus, Palette, Pilcrow, Quote, Redo2, ScanText, Sigma, StickyNote, Strikethrough, Table2, Underline, Undo2, RotateCw, ZoomIn, ZoomOut, Unlink,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { db } from "@/data/db";
import type { Attachment } from "@/data/types";
import { safeUrl } from "@/domain/sanitize";
import { normalizeWithMap, normalize } from "@/domain/text";
import type { OcrLang } from "@/files/ocr";
import { addFile, getBlob, updateAttachment } from "@/services/files";
import { useApp } from "@/ui/app-context";
import { FormulaView } from "@/ui/FormulaView";
import { useI18n } from "@/ui/i18n";
import { Button, Field, Input, Modal, Select, Textarea } from "@/ui/kit";
import { useBlobUrl, useFailureText } from "@/ui/shared";
import { cn } from "@/utils/cn";
import { buildExtensions } from "./extensions";

const COLORS = ["#17162b", "#c42a3b", "#d97706", "#15803d", "#2563eb", "#7c3aed", "#db2777", "#64627c"];
const HL = ["#fde68a", "#bbf7d0", "#bfdbfe", "#fbcfe8", "#ddd6fe"];
const SIZES = ["", "14px", "16px", "18px", "22px", "28px", "36px"];

function Btn({ label, active, onClick, children, disabled }: { label: string; active?: boolean; onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button type="button" title={label} aria-label={label} aria-pressed={active} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={onClick}
      className={cn("flex h-10 min-w-10 shrink-0 items-center justify-center rounded-lg text-fg transition hover:bg-surface2 active:scale-95 sm:h-9 sm:min-w-9", active && "bg-primary text-primary-fg hover:bg-primary")}>
      {children}
    </button>
  );
}
const Sep = () => <span className="mx-0.5 h-5 w-px shrink-0 bg-line" aria-hidden />;

function ImageViewer({
  attId,
  onClose,
  onInsertText,
}: {
  attId: string | null;
  onClose: () => void;
  onInsertText?: (text: string) => void;
}) {
  const { t } = useI18n();
  const { toast } = useApp();
  const [att, setAtt] = useState<Attachment | undefined>(undefined);
  const [zoom, setZoom] = useState(1);
  const [rot, setRot] = useState(0);
  const [desc, setDesc] = useState("");
  const [ocrLang, setOcrLang] = useState<OcrLang>("ara+eng");
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrPct, setOcrPct] = useState(0);
  const [ocrText, setOcrText] = useState("");
  const { url } = useBlobUrl(att);
  useEffect(() => {
    setZoom(1);
    setRot(0);
    setOcrText("");
    setOcrBusy(false);
    setOcrPct(0);
    if (attId) db.attachments.get(attId).then((a) => { setAtt(a); setDesc(a?.description ?? ""); });
  }, [attId]);

  const extractOcr = async () => {
    if (!att || ocrBusy) return;
    setOcrBusy(true);
    setOcrPct(0);
    try {
      const blob = await getBlob(att);
      if (!blob) throw new Error("NO_BLOB");
      const { runImageOcr } = await import("@/files/ocr");
      const text = await runImageOcr(blob, ocrLang, setOcrPct);
      setOcrText(text);
      if (!text) toast(t("لم يُعثر على نص واضح في الصورة", "No readable text found in image"), "info");
    } catch {
      toast(t("تعذر استخراج النص", "OCR failed"), "err");
    } finally {
      setOcrBusy(false);
    }
  };

  return (
    <Modal open={!!attId} onClose={onClose} title={att?.name ?? t("صورة", "Image")} wide
      footer={<><Button onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}><ZoomOut size={16} />{t("تصغير", "Zoom out")}</Button><Button onClick={() => setZoom((z) => Math.min(4, z + 0.25))}><ZoomIn size={16} />{t("تكبير", "Zoom in")}</Button><Button onClick={() => setRot((r) => (r + 90) % 360)}><RotateCw size={16} />{t("تدوير", "Rotate")}</Button></>}>
      <div className="max-h-[50vh] overflow-auto rounded-xl bg-surface2 p-2 text-center">
        {url ? <img src={url} alt={att?.description || att?.name || ""} style={{ transform: `scale(${zoom}) rotate(${rot}deg)`, transformOrigin: "center", transition: "transform .2s" }} className="inline-block max-w-full" /> : <p className="p-8 text-muted">{t("الصورة غير متاحة", "Image unavailable")}</p>}
      </div>
      {att && (
        <>
          <Field label={t("وصف الصورة", "Image description")} className="mt-3">
            {(id) => <div className="flex gap-2"><Input id={id} value={desc} onChange={(e) => setDesc(e.target.value)} dir="auto" /><Button onClick={async () => { await updateAttachment(att.id, { description: desc }); toast(t("تم حفظ الوصف", "Description saved")); }}>{t("حفظ", "Save")}</Button></div>}
          </Field>
          <div className="mt-3 rounded-xl border border-line bg-surface2/50 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Select aria-label={t("لغة OCR", "OCR language")} value={ocrLang} onChange={(e) => setOcrLang(e.target.value as OcrLang)} className="!w-auto">
                <option value="ara+eng">{t("العربية + الإنجليزية", "Arabic + English")}</option>
                <option value="eng">English</option>
                <option value="ara">{t("العربية", "Arabic")}</option>
              </Select>
              <Button disabled={ocrBusy} onClick={() => void extractOcr()}>
                <ScanText size={16} />
                {ocrBusy ? `${t("جارٍ الاستخراج…", "Extracting…")} ${ocrPct}%` : t("استخراج النص (OCR)", "Extract text (OCR)")}
              </Button>
            </div>
            {ocrText && (
              <div className="mt-2 space-y-2">
                <Textarea rows={4} value={ocrText} onChange={(e) => setOcrText(e.target.value)} dir="auto" />
                <div className="flex flex-wrap gap-2">
                  <Button onClick={async () => { await navigator.clipboard?.writeText(ocrText); toast(t("تم النسخ", "Copied")); }}><Copy size={14} />{t("نسخ", "Copy")}</Button>
                  {onInsertText && <Button variant="primary" onClick={() => { onInsertText(ocrText); onClose(); toast(t("أُدرج النص في الملاحظة", "Inserted into note")); }}><FileText size={14} />{t("إدراج في الملاحظة", "Insert into note")}</Button>}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

interface SlashCmd { id: string; ar: string; en: string; keys: string; icon: ReactNode; run: (e: Editor) => void }
const SLASH: SlashCmd[] = [
  { id: "p", ar: "نص عادي", en: "Text", keys: "text paragraph نص", icon: <Pilcrow size={16} />, run: (e) => e.chain().focus().setParagraph().run() },
  { id: "h1", ar: "عنوان 1", en: "Heading 1", keys: "h1 heading عنوان", icon: <Heading1 size={16} />, run: (e) => e.chain().focus().setHeading({ level: 1 }).run() },
  { id: "h2", ar: "عنوان 2", en: "Heading 2", keys: "h2 heading عنوان", icon: <Heading2 size={16} />, run: (e) => e.chain().focus().setHeading({ level: 2 }).run() },
  { id: "h3", ar: "عنوان 3", en: "Heading 3", keys: "h3 heading عنوان", icon: <Heading3 size={16} />, run: (e) => e.chain().focus().setHeading({ level: 3 }).run() },
  { id: "ul", ar: "قائمة نقطية", en: "Bullet list", keys: "bullet list قائمة", icon: <List size={16} />, run: (e) => e.chain().focus().toggleBulletList().run() },
  { id: "ol", ar: "قائمة رقمية", en: "Numbered list", keys: "number ordered قائمة", icon: <ListOrdered size={16} />, run: (e) => e.chain().focus().toggleOrderedList().run() },
  { id: "todo", ar: "قائمة مهام", en: "To-do list", keys: "todo task مهام", icon: <ListChecks size={16} />, run: (e) => e.chain().focus().toggleTaskList().run() },
  { id: "quote", ar: "اقتباس", en: "Quote", keys: "quote اقتباس", icon: <Quote size={16} />, run: (e) => e.chain().focus().toggleBlockquote().run() },
  { id: "callout", ar: "ملاحظة جانبية", en: "Side note", keys: "callout note ملاحظة", icon: <StickyNote size={16} />, run: (e) => e.chain().focus().toggleWrap("callout").run() },
  { id: "code", ar: "كود برمجي", en: "Code block", keys: "code كود", icon: <Code2 size={16} />, run: (e) => e.chain().focus().toggleCodeBlock().run() },
  { id: "formula", ar: "معادلة رياضية (LaTeX)", en: "Math formula (LaTeX)", keys: "formula math latex معادلة رياضيات", icon: <Sigma size={16} />, run: () => window.dispatchEvent(new CustomEvent("nv-open-formula")) },
  { id: "table", ar: "جدول", en: "Table", keys: "table جدول", icon: <Table2 size={16} />, run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { id: "hr", ar: "فاصل", en: "Divider", keys: "divider hr فاصل", icon: <Minus size={16} />, run: (e) => e.chain().focus().setHorizontalRule().run() },
];

export interface RichEditorProps {
  content: JSONContent | null;
  noteId: string;
  onUpdate: (doc: JSONContent) => void;
  onCreateCard?: (text: string) => void;
  searchTerm?: string;
  editorRef?: (e: Editor | null) => void;
}

export function RichEditor({ content, noteId, onUpdate, onCreateCard, searchTerm, editorRef }: RichEditorProps) {
  const { t, lang } = useI18n();
  const { toast } = useApp();
  const failText = useFailureText();
  const fileInput = useRef<HTMLInputElement>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [formulaOpen, setFormulaOpen] = useState(false);
  const [formulaTex, setFormulaTex] = useState("\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}");
  const [palette, setPalette] = useState<"color" | "hl" | null>(null);
  const [imgView, setImgView] = useState<string | null>(null);
  const [slash, setSlash] = useState<{ q: string; x: number; y: number } | null>(null);
  const [slashIdx, setSlashIdx] = useState(0);
  const slashRef = useRef<{ items: SlashCmd[]; open: boolean; idx: number }>({ items: [], open: false, idx: 0 });
  const slashItems = useMemo(() => {
    if (!slash) return [];
    const q = normalize(slash.q);
    return SLASH.filter((c) => !q || normalize(c.ar + " " + c.en + " " + c.keys).includes(q));
  }, [slash]);
  slashRef.current = { items: slashItems, open: !!slash && slashItems.length > 0, idx: slashIdx };
  const extensions = useMemo(() => buildExtensions(t("اكتب هنا… أو اضغط / للأوامر", "Start writing… or press / for commands")), [t]);

  const runSlash = useCallback((e: Editor, cmd: SlashCmd) => {
    const { from } = e.state.selection;
    const before = e.state.selection.$from.parent.textBetween(0, e.state.selection.$from.parentOffset, undefined, "\ufffc");
    const m = /\/([^\s/]{0,20})$/.exec(before);
    if (m) e.chain().focus().deleteRange({ from: from - m[0].length, to: from }).run();
    cmd.run(e);
    setSlash(null);
  }, []);

  const detectSlash = useCallback((e: Editor) => {
    const { selection } = e.state;
    if (!selection.empty) return setSlash(null);
    const before = selection.$from.parent.textBetween(0, selection.$from.parentOffset, undefined, "\ufffc");
    const m = /(?:^|\s)\/([^\s/]{0,20})$/.exec(before);
    if (!m) return setSlash(null);
    const c = e.view.coordsAtPos(selection.from);
    setSlash((cur) => { if (!cur || cur.q !== m[1]) setSlashIdx(0); return { q: m[1], x: c.left, y: c.bottom }; });
  }, []);

  const editor = useEditor({
    extensions,
    content: content ?? undefined,
    editorProps: {
      attributes: { class: "ProseMirror", dir: "auto", "aria-label": t("محرر الملاحظة", "Note editor"), spellcheck: "true" },
      handleKeyDown: (view, ev) => {
        const s = slashRef.current;
        if (!s.open) return false;
        if (ev.key === "ArrowDown") { setSlashIdx((i) => (i + 1) % s.items.length); return true; }
        if (ev.key === "ArrowUp") { setSlashIdx((i) => (i - 1 + s.items.length) % s.items.length); return true; }
        if (ev.key === "Escape") { setSlash(null); return true; }
        if (ev.key === "Enter" || ev.key === "Tab") {
          const cmd = s.items[s.idx];
          const ed = editorInstance.current;
          if (cmd && ed) { runSlash(ed, cmd); return true; }
        }
        void view;
        return false;
      },
    },
    onUpdate: ({ editor: e }) => { onUpdate(e.getJSON()); detectSlash(e); },
    onSelectionUpdate: ({ editor: e }) => detectSlash(e),
  });
  const editorInstance = useRef<Editor | null>(null);
  editorInstance.current = editor;
  useEffect(() => { editorRef?.(editor); return () => editorRef?.(null); }, [editor, editorRef]);
  useEffect(() => { const h = (e: Event) => setImgView((e as CustomEvent).detail?.attId ?? null); window.addEventListener("nv-open-image", h); return () => window.removeEventListener("nv-open-image", h); }, []);
  useEffect(() => {
    const h = () => {
      const ed = editorInstance.current;
      if (ed && !ed.state.selection.empty) {
        setFormulaTex(ed.state.doc.textBetween(ed.state.selection.from, ed.state.selection.to, " "));
      }
      setFormulaOpen(true);
    };
    window.addEventListener("nv-open-formula", h);
    return () => window.removeEventListener("nv-open-formula", h);
  }, []);

  // jump to the first match when opened from search
  useEffect(() => {
    if (!editor || !searchTerm) return;
    const term = normalize(searchTerm).split(/\s+/)[0];
    if (!term) return;
    const box: { hit: [number, number] | null } = { hit: null };
    editor.state.doc.descendants((node, pos) => {
      if (box.hit || !node.isText || !node.text) return;
      const { norm, map } = normalizeWithMap(node.text);
      const i = norm.indexOf(term);
      if (i >= 0) box.hit = [pos + map[i], pos + map[Math.min(i + term.length, map.length - 1)]];
    });
    if (box.hit) {
      const [from, to] = box.hit;
      setTimeout(() => { editor.chain().setTextSelection({ from, to }).scrollIntoView().run(); }, 150);
    }
  }, [editor, searchTerm]);

  const st = useEditorState({
    editor,
    selector: (ctx) => {
      const e = ctx.editor;
      if (!e) return null;
      const isFormula = e.isActive("formula");
      let formulaText = "";
      if (isFormula) {
        const { from, to, empty, $from } = e.state.selection;
        if (!empty) {
          formulaText = e.state.doc.textBetween(from, to, " ");
        } else {
          $from.parent.forEach((child, offset) => {
            const pos = $from.parentOffset;
            if (child.isText && child.marks.some((m) => m.type.name === "formula") && pos >= offset && pos <= offset + child.nodeSize) {
              formulaText = child.text ?? "";
            }
          });
        }
      }
      return {
        bold: e.isActive("bold"), italic: e.isActive("italic"), underline: e.isActive("underline"), strike: e.isActive("strike"), h1: e.isActive("heading", { level: 1 }),
        h2: e.isActive("heading", { level: 2 }), h3: e.isActive("heading", { level: 3 }), ul: e.isActive("bulletList"), ol: e.isActive("orderedList"), todo: e.isActive("taskList"),
        quote: e.isActive("blockquote"), code: e.isActive("codeBlock"), callout: e.isActive("callout"), link: e.isActive("link"), table: e.isActive("table"), formula: isFormula, formulaText,
        hl: e.isActive("highlight"), canUndo: e.can().undo(), canRedo: e.can().redo(), size: (e.getAttributes("textStyle").fontSize as string) ?? "", align: e.isActive({ textAlign: "center" }) ? "center" : e.isActive({ textAlign: "right" }) ? "right" : "left",
      };
    },
  });

  if (!editor || !st) return null;
  const c = () => editor.chain().focus();
  const openLink = () => { setLinkUrl((editor.getAttributes("link").href as string) ?? "https://"); setLinkOpen(true); };
  const applyLink = () => {
    const url = linkUrl.trim();
    if (!url) { c().extendMarkRange("link").unsetLink().run(); setLinkOpen(false); return; }
    const safe = safeUrl(url);
    if (!safe) return toast(t("رابط غير مسموح. استخدم http أو https أو mailto أو tel.", "Link not allowed. Use http, https, mailto or tel."), "err");
    c().extendMarkRange("link").setLink({ href: safe }).run();
    setLinkOpen(false);
  };
  const openFormula = () => {
    if (!editor.state.selection.empty) {
      if (st.formula) {
        c().unsetMark("formula").run();
        return;
      }
      c().setMark("formula").run();
      return;
    }
    if (st.formulaText) setFormulaTex(st.formulaText);
    setFormulaOpen(true);
  };
  const insertFormula = () => {
    const clean = formulaTex.trim();
    if (!clean) return setFormulaOpen(false);
    c().insertContent({ type: "text", text: clean, marks: [{ type: "formula" }] }).run();
    setFormulaOpen(false);
  };
  const insertImages = async (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files)) {
      const r = await addFile(f, { noteId }, { category: "board" });
      if (!r.ok || r.attachment?.kind !== "image") {
        if (r.ok && r.attachment) toast(t("تمت إضافة الملف كمرفق (ليس صورة)", "Added as an attachment (not an image)"));
        else toast(`${f.name}: ${failText(r.reason)}`, "err");
        continue;
      }
      c().insertContent({ type: "image", attrs: { attId: r.attachment.id, alt: r.attachment.name } }).run();
    }
    if (fileInput.current) fileInput.current.value = "";
  };
  const sw = (color: string, on: () => void, label: string) => <button key={color} type="button" aria-label={label} onMouseDown={(e) => e.preventDefault()} onClick={() => { on(); setPalette(null); }} className="h-7 w-7 rounded-full border border-line" style={{ background: color }} />;

  return (
    <div className="editor-surface">
      <div className="sticky top-[57px] z-20 -mx-4 border-b border-line bg-bg/95 px-3 backdrop-blur sm:mx-0 sm:rounded-2xl sm:border" role="toolbar" aria-label={t("أدوات التنسيق", "Formatting tools")}>
        <div className="flex items-center gap-0.5 overflow-x-auto py-1.5">
          <Btn label={t("تراجع (Ctrl+Z)", "Undo (Ctrl+Z)")} onClick={() => c().undo().run()} disabled={!st.canUndo}><Undo2 size={17} className="rtl:-scale-x-100" /></Btn>
          <Btn label={t("إعادة (Ctrl+Y)", "Redo (Ctrl+Y)")} onClick={() => c().redo().run()} disabled={!st.canRedo}><Redo2 size={17} className="rtl:-scale-x-100" /></Btn>
          <Sep />
          <Btn label={t("عنوان 1", "Heading 1")} active={st.h1} onClick={() => c().toggleHeading({ level: 1 }).run()}><Heading1 size={17} /></Btn>
          <Btn label={t("عنوان 2", "Heading 2")} active={st.h2} onClick={() => c().toggleHeading({ level: 2 }).run()}><Heading2 size={17} /></Btn>
          <Btn label={t("عنوان 3", "Heading 3")} active={st.h3} onClick={() => c().toggleHeading({ level: 3 }).run()}><Heading3 size={17} /></Btn>
          <Btn label={t("نص عادي", "Normal text")} onClick={() => c().setParagraph().run()}><Pilcrow size={17} /></Btn>
          <Sep />
          <Btn label={t("عريض (Ctrl+B)", "Bold (Ctrl+B)")} active={st.bold} onClick={() => c().toggleBold().run()}><Bold size={17} /></Btn>
          <Btn label={t("مائل (Ctrl+I)", "Italic (Ctrl+I)")} active={st.italic} onClick={() => c().toggleItalic().run()}><Italic size={17} /></Btn>
          <Btn label={t("تسطير (Ctrl+U)", "Underline (Ctrl+U)")} active={st.underline} onClick={() => c().toggleUnderline().run()}><Underline size={17} /></Btn>
          <Btn label={t("شطب", "Strikethrough")} active={st.strike} onClick={() => c().toggleStrike().run()}><Strikethrough size={17} /></Btn>
          <Btn label={t("لون النص", "Text colour")} active={palette === "color"} onClick={() => setPalette(palette === "color" ? null : "color")}><Palette size={17} /></Btn>
          <Btn label={t("تمييز", "Highlight")} active={palette === "hl" || st.hl} onClick={() => setPalette(palette === "hl" ? null : "hl")}><Highlighter size={17} /></Btn>
          <select aria-label={t("حجم النص", "Text size")} value={st.size} onChange={(e) => (e.target.value ? c().setFontSize(e.target.value).run() : c().unsetFontSize().run())} className="h-9 shrink-0 rounded-lg border border-line bg-surface px-1.5 text-xs font-bold">
            {SIZES.map((s) => <option key={s} value={s}>{s ? s.replace("px", "") : t("الحجم", "Size")}</option>)}
          </select>
          <Sep />
          <Btn label={t("قائمة نقطية", "Bullet list")} active={st.ul} onClick={() => c().toggleBulletList().run()}><List size={17} /></Btn>
          <Btn label={t("قائمة رقمية", "Numbered list")} active={st.ol} onClick={() => c().toggleOrderedList().run()}><ListOrdered size={17} /></Btn>
          <Btn label={t("قائمة مهام", "Task list")} active={st.todo} onClick={() => c().toggleTaskList().run()}><ListChecks size={17} /></Btn>
          <Btn label={t("محاذاة لليسار", "Align left")} active={st.align === "left"} onClick={() => c().setTextAlign("left").run()}><AlignLeft size={17} /></Btn>
          <Btn label={t("توسيط", "Center")} active={st.align === "center"} onClick={() => c().setTextAlign("center").run()}><AlignCenter size={17} /></Btn>
          <Btn label={t("محاذاة لليمين", "Align right")} active={st.align === "right"} onClick={() => c().setTextAlign("right").run()}><AlignRight size={17} /></Btn>
          <Sep />
          <Btn label={t("اقتباس", "Quote")} active={st.quote} onClick={() => c().toggleBlockquote().run()}><Quote size={17} /></Btn>
          <Btn label={t("ملاحظة جانبية", "Side note")} active={st.callout} onClick={() => c().toggleWrap("callout").run()}><StickyNote size={17} /></Btn>
          <Btn label={t("كود برمجي", "Code block")} active={st.code} onClick={() => c().toggleCodeBlock().run()}><Code2 size={17} /></Btn>
          <Btn label={t("معادلة رياضية (LaTeX)", "Math formula (LaTeX)")} active={st.formula} onClick={openFormula}><Sigma size={17} /></Btn>
          <Btn label={t("فاصل", "Divider")} onClick={() => c().setHorizontalRule().run()}><Minus size={17} /></Btn>
          <Btn label={t("رابط", "Link")} active={st.link} onClick={openLink}><Link2 size={17} /></Btn>
          <Btn label={t("جدول", "Table")} active={st.table} onClick={() => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}><Table2 size={17} /></Btn>
          <Btn label={t("إدراج صورة", "Insert image")} onClick={() => fileInput.current?.click()}><ImagePlus size={17} /></Btn>
          <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple className="sr-only" aria-label={t("اختيار صور", "Choose images")} onChange={(e) => void insertImages(e.target.files)} />
        </div>
        {palette && (
          <div className="flex flex-wrap items-center gap-2 border-t border-line py-2">
            {palette === "color" ? <>{COLORS.map((col) => sw(col, () => c().setColor(col).run(), col))}<Button className="!min-h-7 !py-0.5 text-xs" onClick={() => { c().unsetColor().run(); setPalette(null); }}>{t("افتراضي", "Default")}</Button></>
              : <>{HL.map((col) => sw(col, () => c().setHighlight({ color: col }).run(), col))}<Button className="!min-h-7 !py-0.5 text-xs" onClick={() => { c().unsetHighlight().run(); setPalette(null); }}>{t("إزالة", "Remove")}</Button></>}
          </div>
        )}
        {st.table && (
          <div className="flex flex-wrap gap-1 border-t border-line py-1.5 text-xs">
            {([[t("عمود +", "Col +"), () => c().addColumnAfter().run()], [t("صف +", "Row +"), () => c().addRowAfter().run()], [t("حذف عمود", "Del col"), () => c().deleteColumn().run()], [t("حذف صف", "Del row"), () => c().deleteRow().run()], [t("دمج/فصل", "Merge/split"), () => c().mergeOrSplit().run()], [t("حذف الجدول", "Delete table"), () => c().deleteTable().run()]] as [string, () => void][]).map(([l, f]) => <button key={l} type="button" onMouseDown={(e) => e.preventDefault()} onClick={f} className="rounded-lg bg-surface2 px-2.5 py-1.5 font-bold hover:bg-line/60">{l}</button>)}
          </div>
        )}
        {st.formula && st.formulaText && (
          <div className="flex items-center justify-between gap-2 border-t border-line py-1.5 text-sm">
            <span className="text-xs font-bold text-muted">{t("معاينة المعادلة:", "Formula preview:")}</span>
            <FormulaView tex={st.formulaText} className="px-2 py-0.5 text-base" />
          </div>
        )}
      </div>

      <BubbleMenu editor={editor} options={{ placement: "top" }} shouldShow={({ editor: e, state }) => e.isEditable && !state.selection.empty && !e.isActive("image")}>
        <div className="flex items-center gap-0.5 rounded-xl border border-line bg-surface p-1 shadow-2xl">
          <Btn label={t("عريض", "Bold")} active={st.bold} onClick={() => c().toggleBold().run()}><Bold size={16} /></Btn>
          <Btn label={t("مائل", "Italic")} active={st.italic} onClick={() => c().toggleItalic().run()}><Italic size={16} /></Btn>
          <Btn label={t("تسطير", "Underline")} active={st.underline} onClick={() => c().toggleUnderline().run()}><Underline size={16} /></Btn>
          <Btn label={t("تمييز", "Highlight")} active={st.hl} onClick={() => c().toggleHighlight({ color: HL[0] }).run()}><Highlighter size={16} /></Btn>
          <Btn label={t("رابط", "Link")} active={st.link} onClick={openLink}>{st.link ? <Unlink size={16} /> : <Link2 size={16} />}</Btn>
          {onCreateCard && <Btn label={t("إنشاء بطاقة مراجعة", "Create flashcard")} onClick={() => { const { from, to } = editor.state.selection; onCreateCard(editor.state.doc.textBetween(from, to, " ")); }}><Layers size={16} /></Btn>}
        </div>
      </BubbleMenu>

      <EditorContent editor={editor} />

      {slash && slashItems.length > 0 && (
        <div role="listbox" aria-label={t("أوامر سريعة", "Quick commands")} className="fixed z-[90] max-h-72 w-60 overflow-y-auto rounded-2xl border border-line bg-surface p-1 shadow-2xl" style={{ top: Math.min(slash.y + 6, window.innerHeight - 300), left: Math.max(8, Math.min(slash.x, window.innerWidth - 250)) }}>
          {slashItems.map((cmd, i) => (
            <button key={cmd.id} role="option" aria-selected={i === slashIdx} onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setSlashIdx(i)} onClick={() => runSlash(editor, cmd)}
              className={cn("flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-start text-sm font-semibold", i === slashIdx && "bg-surface2")}>
              <span className="text-accent">{cmd.icon}</span>{lang === "ar" ? cmd.ar : cmd.en}
            </button>
          ))}
        </div>
      )}

      <Modal open={linkOpen} onClose={() => setLinkOpen(false)} title={t("إدراج رابط", "Insert link")} footer={<><Button onClick={() => setLinkOpen(false)}>{t("إلغاء", "Cancel")}</Button><Button variant="primary" onClick={applyLink}>{t("تطبيق", "Apply")}</Button></>}>
        <Field label={t("العنوان (URL)", "URL")} hint={t("اتركه فارغاً لإزالة الرابط", "Leave empty to remove the link")}>{(id) => <Input id={id} dir="ltr" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && applyLink()} />}</Field>
      </Modal>
      <Modal open={formulaOpen} onClose={() => setFormulaOpen(false)} title={t("إدراج معادلة رياضية (LaTeX)", "Insert math formula (LaTeX)")} wide footer={<><Button onClick={() => setFormulaOpen(false)}>{t("إلغاء", "Cancel")}</Button><Button variant="primary" onClick={insertFormula}>{t("إدراج", "Insert")}</Button></>}>
        <div className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {[
              ["a/b", "\\frac{a}{b}"],
              ["√x", "\\sqrt{x}"],
              ["xⁿ", "x^{n}"],
              ["∑", "\\sum_{i=1}^{n} x_i"],
              ["∫", "\\int_{a}^{b} f(x)\\,dx"],
              ["lim", "\\lim_{x \\to \\infty} f(x)"],
              ["α,β,θ", "\\alpha + \\beta = \\theta"],
            ].map(([label, snip]) => (
              <Button key={label} className="!min-h-8 !px-2.5 !py-1 text-xs" onClick={() => setFormulaTex((prev) => (prev ? `${prev} ${snip}` : snip))}>
                {label}
              </Button>
            ))}
          </div>
          <Field label={t("صيغة LaTeX", "LaTeX expression")}>
            {(id) => <Input id={id} dir="ltr" value={formulaTex} onChange={(e) => setFormulaTex(e.target.value)} onKeyDown={(e) => e.key === "Enter" && insertFormula()} />}
          </Field>
          <div className="rounded-xl border border-line bg-surface2/60 p-4">
            <div className="mb-1 text-xs font-bold text-muted">{t("المعاينة الحية", "Live preview")}</div>
            <FormulaView tex={formulaTex} displayMode className="text-lg" />
          </div>
        </div>
      </Modal>
      <ImageViewer
        attId={imgView}
        onClose={() => setImgView(null)}
        onInsertText={(ocrTxt) => {
          c().insertContent({ type: "paragraph", content: [{ type: "text", text: ocrTxt }] }).run();
        }}
      />
    </div>
  );
}
