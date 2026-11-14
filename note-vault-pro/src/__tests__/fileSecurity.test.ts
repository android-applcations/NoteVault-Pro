import { describe, expect, it } from "vitest";
import { validateFile } from "@/files/validate";

function makeFile(data: Uint8Array | string, name: string, type: string): File {
  const part: BlobPart =
    typeof data === "string"
      ? data
      : (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
  return new File([part], name, { type });
}

function craftPngHeader(width: number, height: number, bitDepth = 8, colorType = 6): Uint8Array {
  const buf = new Uint8Array(33);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(buf.buffer);
  view.setUint32(8, 13, false); // IHDR length
  buf.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  buf[24] = bitDepth;
  buf[25] = colorType;
  buf[26] = 0;
  buf[27] = 0;
  buf[28] = 0;
  return buf;
}

function craftJpegHeader(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(31);
  const view = new DataView(buf.buffer);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[2] = 0xff;
  buf[3] = 0xe0;
  view.setUint16(4, 14, false); // APP0 length = 14 -> next marker at 4 + 14 = 18
  buf.set([0x4a, 0x46, 0x49, 0x46, 0x00], 6); // JFIF\0
  buf[18] = 0xff;
  buf[19] = 0xc0; // SOF0
  view.setUint16(20, 9, false); // SOF0 length = 9 -> EOI at 20 + 9 = 29
  buf[22] = 8;
  view.setUint16(23, height, false);
  view.setUint16(25, width, false);
  buf[27] = 3;
  buf[29] = 0xff;
  buf[30] = 0xd9;
  return buf;
}

function craftWebpVp8x(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(30);
  const view = new DataView(buf.buffer);
  buf.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  view.setUint32(4, 22, true);
  buf.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  buf.set([0x56, 0x50, 0x38, 0x58], 12); // VP8X
  view.setUint32(16, 10, true);
  const w1 = width - 1;
  const h1 = height - 1;
  buf[24] = w1 & 0xff;
  buf[25] = (w1 >> 8) & 0xff;
  buf[26] = (w1 >> 16) & 0xff;
  buf[27] = h1 & 0xff;
  buf[28] = (h1 >> 8) & 0xff;
  buf[29] = (h1 >> 16) & 0xff;
  return buf;
}

describe("Adversarial file validation & anti-bomb guards", () => {
  it("rejects PNG pixel bomb (65535x65535) before decoding", async () => {
    const bomb = makeFile(craftPngHeader(65535, 65535), "bomb.png", "image/png");
    const res = await validateFile(bomb);
    expect(res).toEqual({ ok: false, reason: "dimensions" });
  });

  it("rejects PNG exceeding megapixel cap (7000x7000 = 49 MP)", async () => {
    const big = makeFile(craftPngHeader(7000, 7000), "huge.png", "image/png");
    const res = await validateFile(big);
    expect(res).toEqual({ ok: false, reason: "dimensions" });
  });

  it("rejects corrupt PNG with zero width or invalid bit depth", async () => {
    const zero = makeFile(craftPngHeader(0, 100), "zero.png", "image/png");
    expect(await validateFile(zero)).toEqual({ ok: false, reason: "corrupt" });
    const badDepth = makeFile(craftPngHeader(100, 100, 99), "bad.png", "image/png");
    expect(await validateFile(badDepth)).toEqual({ ok: false, reason: "corrupt" });
  });

  it("rejects JPEG pixel bomb and malformed truncated JPEG segments", async () => {
    const jpegBomb = makeFile(craftJpegHeader(20000, 20000), "bomb.jpg", "image/jpeg");
    expect(await validateFile(jpegBomb)).toEqual({ ok: false, reason: "dimensions" });

    const badSeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 0x00, 0x00]);
    expect(await validateFile(makeFile(badSeg, "corrupt.jpg", "image/jpeg"))).toEqual({
      ok: false,
      reason: "corrupt",
    });
  });

  it("rejects WebP VP8X dimension bomb", async () => {
    const webpBomb = makeFile(craftWebpVp8x(15000, 15000), "bomb.webp", "image/webp");
    expect(await validateFile(webpBomb)).toEqual({ ok: false, reason: "dimensions" });
  });

  it("rejects SVG/HTML XSS payloads masquerading as PNG or PDF", async () => {
    const xssPng = makeFile('<svg onload="alert(1)"></svg>', "evil.png", "image/png");
    expect(await validateFile(xssPng)).toEqual({ ok: false, reason: "mismatch" });

    const xssPdf = makeFile("<script>alert(1)</script>", "evil.pdf", "application/pdf");
    expect(await validateFile(xssPdf)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects truncated PDF missing %%EOF trailer", async () => {
    const truncPdf = makeFile("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n", "trunc.pdf", "application/pdf");
    expect(await validateFile(truncPdf)).toEqual({ ok: false, reason: "corrupt" });
  });

  it("detects binary bytes or invalid UTF-8 anywhere in text/markdown files (even past 64 KB)", async () => {
    const prefix = new Uint8Array(70_000).fill(0x41);
    prefix[69_500] = 0xff;
    const badUtf8 = makeFile(prefix, "late-corrupt.md", "text/markdown");
    expect(await validateFile(badUtf8)).toEqual({ ok: false, reason: "bad_encoding" });

    const nulBytes = new Uint8Array(70_000).fill(0x41);
    nulBytes[68_000] = 0x00;
    expect(await validateFile(makeFile(nulBytes, "bin.txt", "text/plain"))).toEqual({
      ok: false,
      reason: "binary_text",
    });
  });

  it("rejects spoofed audio files and accepts valid audio signatures", async () => {
    const fakeMp3 = makeFile("not real audio data here", "fake.mp3", "audio/mpeg");
    expect(await validateFile(fakeMp3)).toEqual({ ok: false, reason: "mismatch" });

    const id3 = new Uint8Array(32);
    id3.set([0x49, 0x44, 0x33, 0x03, 0x00], 0);
    expect(await validateFile(makeFile(id3, "lecture.mp3", "audio/mpeg"))).toMatchObject({
      ok: true,
      kind: "audio",
      mime: "audio/mpeg",
    });
  });

  it("accepts valid PNG, JPEG, WebP, and UTF-8 Markdown with parsed dimensions", async () => {
    expect(await validateFile(makeFile(craftPngHeader(800, 600), "ok.png", "image/png"))).toEqual({
      ok: true,
      kind: "image",
      mime: "image/png",
      name: "ok.png",
      width: 800,
      height: 600,
    });
    expect(await validateFile(makeFile(craftJpegHeader(1280, 720), "ok.jpg", "image/jpeg"))).toEqual({
      ok: true,
      kind: "image",
      mime: "image/jpeg",
      name: "ok.jpg",
      width: 1280,
      height: 720,
    });
    expect(await validateFile(makeFile(craftWebpVp8x(640, 480), "ok.webp", "image/webp"))).toEqual({
      ok: true,
      kind: "image",
      mime: "image/webp",
      name: "ok.webp",
      width: 640,
      height: 480,
    });
    expect(await validateFile(makeFile("# ملاحظة\n\nValid UTF-8", "note.md", "text/markdown"))).toEqual({
      ok: true,
      kind: "markdown",
      mime: "text/markdown",
      name: "note.md",
    });
  });
});
