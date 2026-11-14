import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/data/db";
import { BlobRangeTransport, extractPdfIncremental } from "@/files/pdf";
import { addFile, processPdf } from "@/services/files";
import { _resetSearchForTests } from "@/services/search";

function buildMultiPagePdf(pagesText: string[]): ArrayBuffer {
  // Objects: 1=Catalog, 2=Pages, 3=Font, then 2 objects per page (Page + Content stream)
  const objs: string[] = [];
  const pageIds: number[] = [];
  for (let i = 0; i < pagesText.length; i++) {
    const pageObjId = 4 + i * 2;
    const contentObjId = 5 + i * 2;
    pageIds.push(pageObjId);
    const stream = `BT /F1 18 Tf 20 120 Td (${pagesText[i]}) Tj ET`;
    objs[pageObjId] = `${pageObjId} 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents ${contentObjId} 0 R/Resources<</Font<</F1 3 0 R>>>>>>endobj\n`;
    objs[contentObjId] = `${contentObjId} 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream endobj\n`;
  }
  objs[1] = `1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n`;
  objs[2] = `2 0 obj<</Type/Pages/Kids[${pageIds.map((id) => `${id} 0 R`).join(" ")}]/Count ${pagesText.length}>>endobj\n`;
  objs[3] = `3 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n`;

  let body = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let id = 1; id < objs.length; id++) {
    offsets[id] = body.length;
    body += objs[id];
  }
  const xrefPos = body.length;
  body += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objs.length; id++) {
    body += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer<</Root 1 0 R/Size ${objs.length}>>\nstartxref\n${xrefPos}\n%%EOF`;
  const u8 = new TextEncoder().encode(body);
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

describe("PDF incremental indexing & memory-safe range transport", () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    _resetSearchForTests();
  });

  it("extracts incrementally without padding unindexed pages with empty strings", async () => {
    const bytes = buildMultiPagePdf([
      "Page One Alpha",
      "Page Two Beta",
      "Page Three Gamma",
      "Page Four Delta",
      "Page Five Epsilon",
      "Page Six Zeta",
      "Page Seven Eta",
    ]);
    const blob = new Blob([bytes], { type: "application/pdf" });

    // First pass: max 3 pages out of 7
    const pass1 = await extractPdfIncremental(blob, { maxPages: 3, batchSize: 2, generateThumb: false });
    expect(pass1.pages).toBe(7);
    expect(pass1.indexedPages).toBe(3);
    expect(pass1.pageTexts).toHaveLength(3);
    expect(pass1.pageTexts[0]).toContain("Page One Alpha");
    expect(pass1.pageTexts[2]).toContain("Page Three Gamma");

    // Resume pass: pages 4..7
    const pass2 = await extractPdfIncremental(blob, {
      startPage: 4,
      maxPages: 7,
      existingTexts: pass1.pageTexts,
      batchSize: 2,
      generateThumb: false,
    });
    expect(pass2.pages).toBe(7);
    expect(pass2.indexedPages).toBe(7);
    expect(pass2.pageTexts).toHaveLength(7);
    expect(pass2.pageTexts[6]).toContain("Page Seven Eta");
  });

  it("aborts gracefully mid-indexing and preserves progress", async () => {
    const bytes = buildMultiPagePdf(["P1", "P2", "P3", "P4", "P5", "P6"]);
    const blob = new Blob([bytes], { type: "application/pdf" });
    const ac = new AbortController();

    const res = await extractPdfIncremental(blob, {
      maxPages: 6,
      batchSize: 2,
      generateThumb: false,
      signal: ac.signal,
      onBatch: (s) => {
        if (s.indexedPages >= 2) ac.abort();
      },
    });

    expect(res.aborted).toBe(true);
    expect(res.pages).toBe(6);
    expect(res.indexedPages).toBe(2);
    expect(res.pageTexts).toHaveLength(2);
  });

  it("stores partial PDF progress via processPdf with configurable limit and resumes cleanly", async () => {
    // 60-page PDF with batch limit 50 -> partial (50/60), then continue -> done (60/60)
    const texts = Array.from({ length: 60 }, (_, i) => `Lecture page marker ${i + 1}`);
    const bytes = buildMultiPagePdf(texts);
    const file = new File([bytes], "large-deck.pdf", { type: "application/pdf" });
    const added = await addFile(file);
    expect(added.ok).toBe(true);
    const id = added.attachment!.id;

    // Wait for background processPdf or call with explicit limit 50
    await new Promise((r) => setTimeout(r, 100));
    // Reset pdfDocuments to simulate configurable limit = 50
    await db.pdfDocuments.delete(id);
    await db.appSettings.put({ key: "pdfIndexLimit", value: 50 });

    await processPdf(id);
    let doc = await db.pdfDocuments.get(id);
    expect(doc?.pages).toBe(60);
    expect(doc?.indexedPages).toBe(50);
    expect(doc?.pageTexts).toHaveLength(50); // never padded to 60!
    expect(doc?.indexStatus).toBe("partial");
    expect(doc?.indexed).toBe(false);

    await processPdf(id, { continueFrom: true });
    doc = await db.pdfDocuments.get(id);
    expect(doc?.pages).toBe(60);
    expect(doc?.indexedPages).toBe(60);
    expect(doc?.pageTexts).toHaveLength(60);
    expect(doc?.pageTexts[59]).toContain("Lecture page marker 60");
    expect(doc?.indexStatus).toBe("done");
    expect(doc?.indexed).toBe(true);
  });

  it("BlobRangeTransport serves byte slices without reading the entire blob", async () => {
    const data = new TextEncoder().encode("0123456789ABCDEF");
    const blob = new Blob([data]);
    const transport = new BlobRangeTransport(blob);
    const got = await new Promise<{ offset: number; chunk: Uint8Array }>((resolve) => {
      transport.onDataRange = (offset: number, chunk: Uint8Array) => resolve({ offset, chunk });
      transport.requestDataRange(4, 10);
    });
    expect(got.offset).toBe(4);
    expect(new TextDecoder().decode(got.chunk)).toBe("456789");
  });
});
