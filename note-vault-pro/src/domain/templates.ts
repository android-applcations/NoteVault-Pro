// Domain logic – built-in note templates producing structured, editable Tiptap documents.
import type { JSONContent } from "@tiptap/core";

type L = "ar" | "en";
type Bi = { ar: string; en: string };
type Block =
  | { h: 1 | 2 | 3; t: Bi }
  | { p: Bi }
  | { ul: Bi[] }
  | { ol: Bi[] }
  | { todo: Bi[] }
  | { quote: Bi }
  | { table: Bi[][] }
  | { callout: Bi }
  | { code: string };

export interface NoteTemplate {
  id: string;
  name: Bi;
  description: Bi;
  title: Bi;
  blocks: Block[];
}

const b = (ar: string, en: string): Bi => ({ ar, en });

export const TEMPLATES: NoteTemplate[] = [
  {
    id: "lecture", name: b("محاضرة جامعية", "University lecture"), description: b("عنوان، أهداف، نقاط رئيسية، أسئلة، واجبات", "Objectives, key points, questions, to-dos"),
    title: b("محاضرة جديدة", "New lecture"),
    blocks: [
      { h: 1, t: b("عنوان المحاضرة", "Lecture title") },
      { p: b("التاريخ: …   المحاضر: …", "Date: …   Lecturer: …") },
      { h: 2, t: b("الأهداف التعليمية", "Learning objectives") }, { ul: [b("الهدف الأول", "First objective"), b("الهدف الثاني", "Second objective")] },
      { h: 2, t: b("النقاط الرئيسية", "Key points") }, { ul: [b("…", "…")] },
      { h: 2, t: b("المصطلحات الجديدة", "New terms") }, { table: [[b("المصطلح", "Term"), b("التعريف", "Definition")], [b("", ""), b("", "")]] },
      { callout: b("ملاحظة جانبية: اكتب هنا ما ذكره المحاضر شفهياً.", "Side note: write what the lecturer said verbally.") },
      { h: 2, t: b("أسئلة للمراجعة", "Review questions") }, { ol: [b("…", "…")] },
      { h: 2, t: b("مهام بعد المحاضرة", "After-class tasks") }, { todo: [b("قراءة المراجع", "Read the references"), b("حل التمارين", "Solve exercises")] },
    ],
  },
  {
    id: "summary", name: b("ملخص فصل", "Chapter summary"), description: b("فكرة عامة، مفاهيم، خلاصة", "Overview, concepts, takeaway"),
    title: b("ملخص الفصل", "Chapter summary"),
    blocks: [
      { h: 1, t: b("ملخص الفصل", "Chapter summary") }, { h: 2, t: b("الفكرة العامة", "Big idea") }, { p: b("…", "…") },
      { h: 2, t: b("المفاهيم الأساسية", "Core concepts") }, { ul: [b("المفهوم 1", "Concept 1"), b("المفهوم 2", "Concept 2")] },
      { h: 2, t: b("الأمثلة", "Examples") }, { p: b("…", "…") },
      { h: 2, t: b("الخلاصة", "Takeaway") }, { quote: b("جملة واحدة تلخص الفصل.", "One sentence summarising the chapter.") },
    ],
  },
  {
    id: "research", name: b("بحث علمي", "Research paper"), description: b("مقدمة، منهجية، نتائج، مراجع", "Intro, method, results, references"),
    title: b("بحث علمي", "Research paper"),
    blocks: [
      { h: 1, t: b("عنوان البحث", "Paper title") }, { h: 2, t: b("الملخص", "Abstract") }, { p: b("…", "…") },
      { h: 2, t: b("المقدمة", "Introduction") }, { p: b("…", "…") },
      { h: 2, t: b("المنهجية", "Methodology") }, { p: b("…", "…") },
      { h: 2, t: b("النتائج", "Results") }, { p: b("…", "…") },
      { h: 2, t: b("المناقشة", "Discussion") }, { p: b("…", "…") },
      { h: 2, t: b("المراجع", "References") }, { ol: [b("…", "…")] },
    ],
  },
  {
    id: "exam", name: b("مراجعة امتحان", "Exam revision"), description: b("المواضيع، خطة المراجعة، أسئلة متوقعة", "Topics, plan, expected questions"),
    title: b("مراجعة الامتحان", "Exam revision"),
    blocks: [
      { h: 1, t: b("مراجعة الامتحان", "Exam revision") }, { p: b("موعد الامتحان: …", "Exam date: …") },
      { h: 2, t: b("المواضيع المطلوبة", "Topics to cover") }, { todo: [b("الموضوع 1", "Topic 1"), b("الموضوع 2", "Topic 2"), b("الموضوع 3", "Topic 3")] },
      { h: 2, t: b("القوانين والمعادلات", "Formulas") }, { code: "…" },
      { h: 2, t: b("أسئلة متوقعة", "Expected questions") }, { ol: [b("…", "…")] },
      { callout: b("أخطاء شائعة يجب تجنبها.", "Common mistakes to avoid.") },
    ],
  },
  {
    id: "lab", name: b("تجربة مخبرية", "Lab report"), description: b("الهدف، الأدوات، الخطوات، النتائج", "Aim, materials, steps, results"),
    title: b("تجربة مخبرية", "Lab experiment"),
    blocks: [
      { h: 1, t: b("اسم التجربة", "Experiment name") }, { h: 2, t: b("الهدف", "Aim") }, { p: b("…", "…") },
      { h: 2, t: b("الأدوات والمواد", "Materials") }, { ul: [b("…", "…")] },
      { h: 2, t: b("الخطوات", "Procedure") }, { ol: [b("…", "…"), b("…", "…")] },
      { h: 2, t: b("النتائج", "Results") }, { table: [[b("القياس", "Measurement"), b("القيمة", "Value"), b("الوحدة", "Unit")], [b("", ""), b("", ""), b("", "")]] },
      { h: 2, t: b("الاستنتاج", "Conclusion") }, { p: b("…", "…") },
    ],
  },
  {
    id: "project", name: b("مشروع جماعي", "Group project"), description: b("الفريق، المهام، الاجتماعات", "Team, tasks, meetings"),
    title: b("مشروع جماعي", "Group project"),
    blocks: [
      { h: 1, t: b("اسم المشروع", "Project name") }, { h: 2, t: b("أعضاء الفريق", "Team") }, { table: [[b("الاسم", "Name"), b("الدور", "Role")], [b("", ""), b("", "")]] },
      { h: 2, t: b("المهام", "Tasks") }, { todo: [b("المهمة 1", "Task 1"), b("المهمة 2", "Task 2")] },
      { h: 2, t: b("محاضر الاجتماعات", "Meeting notes") }, { ul: [b("التاريخ: … — القرارات: …", "Date: … — Decisions: …")] },
      { h: 2, t: b("الموعد النهائي", "Deadline") }, { p: b("…", "…") },
    ],
  },
  {
    id: "quick", name: b("ملاحظات سريعة", "Quick notes"), description: b("قائمة خفيفة للأفكار", "Light list for ideas"),
    title: b("ملاحظات سريعة", "Quick notes"),
    blocks: [{ h: 2, t: b("أفكار", "Ideas") }, { ul: [b("…", "…")] }, { h: 2, t: b("مهام", "To-do") }, { todo: [b("…", "…")] }],
  },
  {
    id: "compare", name: b("مقارنة بين موضوعين", "Compare two topics"), description: b("جدول مقارنة وخلاصة", "Comparison table and verdict"),
    title: b("مقارنة", "Comparison"),
    blocks: [
      { h: 1, t: b("المقارنة بين (أ) و(ب)", "Comparing A and B") },
      { table: [[b("المعيار", "Criterion"), b("الموضوع أ", "Topic A"), b("الموضوع ب", "Topic B")], [b("التعريف", "Definition"), b("", ""), b("", "")], [b("المزايا", "Pros"), b("", ""), b("", "")], [b("العيوب", "Cons"), b("", ""), b("", "")]] },
      { h: 2, t: b("أوجه التشابه", "Similarities") }, { ul: [b("…", "…")] },
      { h: 2, t: b("أوجه الاختلاف", "Differences") }, { ul: [b("…", "…")] },
      { h: 2, t: b("الخلاصة", "Verdict") }, { p: b("…", "…") },
    ],
  },
];

const txt = (s: string): JSONContent[] => (s ? [{ type: "text", text: s }] : []);
const para = (s: string): JSONContent => (s ? { type: "paragraph", content: txt(s) } : { type: "paragraph" });

export function buildTemplateDoc(tpl: NoteTemplate, lang: L): JSONContent {
  const content: JSONContent[] = [];
  for (const blk of tpl.blocks) {
    if ("h" in blk) content.push({ type: "heading", attrs: { level: blk.h }, content: txt(blk.t[lang]) });
    else if ("p" in blk) content.push(para(blk.p[lang]));
    else if ("ul" in blk) content.push({ type: "bulletList", content: blk.ul.map((i) => ({ type: "listItem", content: [para(i[lang])] })) });
    else if ("ol" in blk) content.push({ type: "orderedList", content: blk.ol.map((i) => ({ type: "listItem", content: [para(i[lang])] })) });
    else if ("todo" in blk) content.push({ type: "taskList", content: blk.todo.map((i) => ({ type: "taskItem", attrs: { checked: false }, content: [para(i[lang])] })) });
    else if ("quote" in blk) content.push({ type: "blockquote", content: [para(blk.quote[lang])] });
    else if ("callout" in blk) content.push({ type: "callout", content: [para(blk.callout[lang])] });
    else if ("code" in blk) content.push({ type: "codeBlock", content: txt(blk.code) });
    else if ("table" in blk)
      content.push({
        type: "table",
        content: blk.table.map((row, ri) => ({
          type: "tableRow",
          content: row.map((cell) => ({ type: ri === 0 ? "tableHeader" : "tableCell", content: [para(cell[lang])] })),
        })),
      });
  }
  return { type: "doc", content };
}

export const docFromText = (text: string, task = false): JSONContent => {
  const lines = text.split(/\n/);
  if (task) {
    return { type: "doc", content: [{ type: "taskList", content: lines.filter((l) => l.trim()).map((l) => ({ type: "taskItem", attrs: { checked: false }, content: [para(l.trim())] })) }] };
  }
  return { type: "doc", content: lines.map((l) => para(l)) };
};
