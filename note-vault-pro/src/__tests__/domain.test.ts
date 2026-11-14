import { describe, expect, it } from "vitest";
import { formatCitation, citationToPlain } from "@/domain/citations";
import { clozeBlanks, gradeQuestion, summarize, sentenceToCloze } from "@/domain/quiz";
import { sanitizeDoc, safeUrl } from "@/domain/sanitize";
import { applyReview, newSrsState, previewIntervals } from "@/domain/srs";
import { makeSnippet, normalize, plainFromDoc, queryTerms } from "@/domain/text";
import type { QuizQuestion, Reference } from "@/data/types";

describe("text normalisation", () => {
  it("ignores Arabic diacritics and letter variants", () => {
    expect(normalize("الْأُسْتَاذَةُ")).toBe(normalize("الاستاذه"));
    expect(normalize("إسلام")).toBe(normalize("اسلام"));
    expect(normalize("مدرسة")).toBe(normalize("مدرسه"));
    expect(normalize("HeLLo")).toBe("hello");
  });
  it("maps snippet highlights back to original text", () => {
    const { parts, index } = makeSnippet("الخَلِيَّةُ هي وحدة الحياة الأساسية", queryTerms("الحياه"));
    expect(index).toBeGreaterThanOrEqual(0);
    expect(parts.filter((p) => p.hit).map((p) => p.text).join("")).toContain("الحياة");
  });
});

describe("sanitizeDoc", () => {
  it("removes javascript: links, unknown nodes and bad styles", () => {
    const doc = sanitizeDoc({
      type: "doc",
      content: [
        { type: "script", content: [{ type: "text", text: "alert(1)" }] },
        { type: "paragraph", content: [
          { type: "text", text: "x", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] },
          { type: "text", text: "y", marks: [{ type: "textStyle", attrs: { color: "red;background:url(x)" } }] },
          { type: "text", text: "z", marks: [{ type: "link", attrs: { href: "https://example.com" } }] },
        ] },
        { type: "image", attrs: { src: "http://evil/x.png" } },
      ],
    })!;
    const s = JSON.stringify(doc);
    expect(s).not.toContain("javascript");
    expect(s).not.toContain("script");
    expect(s).not.toContain("url(");
    expect(s).not.toContain("evil");
    expect(s).toContain("https://example.com");
    expect(plainFromDoc(doc)).toBe("xyz");
  });
  it("validates urls", () => {
    expect(safeUrl("https://a.b")).toBeTruthy();
    expect(safeUrl("data:text/html,<script>")).toBeNull();
    expect(safeUrl("JaVaScRiPt:alert(1)")).toBeNull();
    expect(safeUrl("/relative")).toBeNull();
  });
});

describe("spaced repetition (FSRS)", () => {
  const t0 = new Date("2025-01-01T10:00:00Z").getTime();
  it("schedules later reviews further out for better grades", () => {
    const s = newSrsState(t0);
    const p = previewIntervals(s, t0);
    expect(p[1]).toBeLessThanOrEqual(p[2]);
    expect(p[2]).toBeLessThanOrEqual(p[3]);
    expect(p[3]).toBeLessThan(p[4]);
  });
  it("tracks reps/lapses and grows the interval on success", () => {
    let s = newSrsState(t0);
    let now = t0;
    const good = applyReview(s, 3, now);
    expect(good.success).toBe(true);
    s = good.fields;
    expect(s.reps).toBe(1);
    now = s.due;
    const second = applyReview(s, 3, now);
    expect(second.fields.scheduledDays).toBeGreaterThan(0);
    const fail = applyReview(second.fields, 1, second.fields.due);
    expect(fail.success).toBe(false);
    expect(fail.fields.lapses).toBe(1);
    expect(fail.fields.due).toBeGreaterThan(second.fields.due);
    expect(fail.log.rating).toBe(1);
  });
});

const ref = (o: Partial<Reference>): Reference => ({
  id: "1", createdAt: 0, updatedAt: 0, type: "article", title: "Deep learning", authors: "Yann LeCun\nBengio, Yoshua", publisher: "", year: "2015", url: "", accessed: "",
  doi: "10.1038/nature14539", pages: "436-444", notes: "", container: "Nature", volume: "521", issue: "7553", ...o,
});
describe("citations", () => {
  it("formats APA / MLA / IEEE / Chicago from supplied data only", () => {
    const apa = citationToPlain(formatCitation(ref({}), "apa"));
    expect(apa).toBe("LeCun, Y., & Bengio, Y. (2015). Deep learning. Nature, 521(7553), 436-444. https://doi.org/10.1038/nature14539");
    expect(citationToPlain(formatCitation(ref({}), "mla"))).toContain("LeCun, Yann, and Yoshua Bengio.");
    expect(citationToPlain(formatCitation(ref({}), "ieee"))).toContain("Y. LeCun and Y. Bengio, “Deep learning,” Nature, vol. 521, no. 7553, pp. 436-444, 2015, doi: 10.1038/nature14539.");
    expect(citationToPlain(formatCitation(ref({}), "chicago"))).toContain("LeCun, Yann, and Yoshua Bengio. 2015.");
    expect(citationToPlain(formatCitation(ref({ type: "book", authors: "", year: "" }), "apa"))).toContain("(n.d.)");
  });
});

const q = (o: Partial<QuizQuestion>): QuizQuestion => ({
  id: "q", quizId: "z", order: 0, type: "mcq", prompt: "p", options: [], correct: 0, bool: true, accepted: [], pairs: [], explanation: "", points: 2, ...o,
});
describe("quiz grading", () => {
  it("grades all question types", () => {
    expect(gradeQuestion(q({ options: ["a", "b"], correct: 1 }), 1).earned).toBe(2);
    expect(gradeQuestion(q({ options: ["a", "b"], correct: 1 }), 0).earned).toBe(0);
    expect(gradeQuestion(q({ type: "tf", bool: false }), false).correct).toBe(true);
    expect(gradeQuestion(q({ type: "short", accepted: ["الميتوكوندريا|mitochondria"] }), "الْمِيتُوكُونْدْرِيَا").correct).toBe(true);
    const cz = q({ type: "cloze", prompt: "The {{cell}} has a {{nucleus}}", points: 2 });
    expect(clozeBlanks(cz.prompt)).toEqual(["cell", "nucleus"]);
    expect(gradeQuestion(cz, ["cell", "wrong"]).earned).toBe(1);
    const m = q({ type: "match", pairs: [["a", "1"], ["b", "2"]] });
    expect(gradeQuestion(m, ["1", "2"]).correct).toBe(true);
    expect(gradeQuestion(m, ["2", "2"]).earned).toBe(1);
    const o = q({ type: "order", options: ["x", "y", "z"] });
    expect(gradeQuestion(o, ["x", "y", "z"]).correct).toBe(true);
    expect(gradeQuestion(o, ["y", "x", "z"]).correct).toBe(false);
    const s = summarize([gradeQuestion(cz, ["cell", "wrong"]), gradeQuestion(m, ["1", "2"])], 60);
    expect(s.percent).toBe(75);
    expect(s.passed).toBe(true);
    expect(sentenceToCloze("Mitochondria produce energy for the cell")).toContain("{{Mitochondria}}");
  });
});
