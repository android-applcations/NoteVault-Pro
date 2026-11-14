// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TABLE_SCHEMAS } from "@/services/backupSchemas";
import { FormulaText, FormulaView } from "@/ui/FormulaView";

describe("KaTeX FormulaView / FormulaText & HighlightRect schema", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("renders valid LaTeX safely via katex.render without raw HTML or javascript: links", () => {
    const { container } = render(
      <FormulaView tex={String.raw`\frac{-b \pm \sqrt{b^2 - 4ac}}{2a} + \href{javascript:alert(1)}{xss}`} displayMode />
    );
    expect(container.querySelector(".katex")).toBeTruthy();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("a[href^='javascript:']")).toBeNull();
  });

  it("splits mixed Arabic/English text with inline $...$ and display $$...$$ math cleanly", () => {
    const { container } = render(
      <FormulaText text={"قانون الطاقة $E = mc^2$ وحل المعادلة $$x = \\frac{a}{b}$$ بنجاح"} />
    );
    expect(container.textContent).toContain("قانون الطاقة");
    expect(container.textContent).toContain("بنجاح");
    expect(container.querySelectorAll(".katex").length).toBe(2);
  });

  it("enforces normalized [0..1] bounds and rect count cap on Highlight records", () => {
    const schema = TABLE_SCHEMAS.highlights;
    expect(schema).toBeDefined();
    if (!schema) return;
    const base = {
      id: "hl-1",
      attachmentId: "att-1",
      page: 1,
      text: "Sample",
      color: "#86efac",
      createdAt: 1000,
    };

    expect(
      schema.safeParse({
        ...base,
        rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.04 }],
      }).success
    ).toBe(true);

    expect(
      schema.safeParse({
        ...base,
        rects: [{ x: -0.1, y: 0.2, w: 0.3, h: 0.04 }],
      }).success
    ).toBe(false);

    expect(
      schema.safeParse({
        ...base,
        rects: [{ x: 0.5, y: 0.5, w: 1.2, h: 0.1 }],
      }).success
    ).toBe(false);

    expect(
      schema.safeParse({
        ...base,
        rects: Array.from({ length: 501 }, () => ({ x: 0.1, y: 0.1, w: 0.1, h: 0.02 })),
      }).success
    ).toBe(false);
  });

  it("runImageOcr uses local same-origin /ocr/ paths with workerBlobURL=false and always terminates worker", async () => {
    const terminate = vi.fn().mockResolvedValue(undefined);
    const recognize = vi.fn().mockRejectedValue(new Error("OCR_BOOM"));
    const createWorker = vi.fn().mockResolvedValue({ recognize, terminate });
    vi.doMock("tesseract.js", () => ({ createWorker }));

    const { runImageOcr } = await import("@/files/ocr");
    await expect(runImageOcr(new Blob(["png"]), "eng")).rejects.toThrow("OCR_BOOM");

    expect(createWorker).toHaveBeenCalledTimes(1);
    const opts = createWorker.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(String(opts.workerPath)).toMatch(/\/ocr\/worker\.min\.js$/);
    expect(String(opts.corePath)).toMatch(/\/ocr$/);
    expect(String(opts.langPath)).toMatch(/\/ocr$/);
    expect(opts.workerBlobURL).toBe(false);
    expect(opts.gzip).toBe(true);
    expect(terminate).toHaveBeenCalledTimes(1);
  });
});
