// Generates PNG icons (no dependencies) for the PWA manifest.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, maskable) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const cx = size / 2, cy = size / 2;
  const radius = maskable ? 0 : size * 0.22;
  const inner = maskable ? 0.62 : 0.78; // glyph scale
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const o = y * (size * 4 + 1) + 1 + x * 4;
      // rounded square mask
      let a = 255;
      if (radius > 0) {
        const dx = Math.max(radius - x, 0, x - (size - 1 - radius));
        const dy = Math.max(radius - y, 0, y - (size - 1 - radius));
        const d = Math.hypot(dx, dy);
        a = d <= radius - 1 ? 255 : d >= radius ? 0 : Math.round((radius - d) * 255);
      }
      const t = (x + y) / (2 * size);
      let r = 43 + (15 - 43) * t * 1.1, g = 42 + (155 - 42) * t * 1.1, b = 111 + (142 - 111) * t * 1.1;
      // vault glyph
      const u = (x - cx) / (size * inner / 2), v = (y - cy) / (size * inner / 2);
      const box = Math.max(Math.abs(u) , Math.abs(v)) ; // square distance
      const ring = Math.hypot(u, v);
      let white = 0;
      if (box < 0.78 && box > 0.64) white = 1;               // vault frame
      if (ring < 0.34 && ring > 0.26) white = 1;               // dial ring
      if (ring < 0.1) white = 1;                               // dial center
      if (Math.abs(v) < 0.025 && u > 0.1 && u < 0.3) white = 1; // handle
      if (Math.abs(u) < 0.025 && v > 0.1 && v < 0.3) white = 1;
      if (white) { r = 255; g = 255; b = 255; }
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
writeFileSync("public/icon-192.png", png(192, false));
writeFileSync("public/icon-512.png", png(512, false));
writeFileSync("public/icon-maskable-512.png", png(512, true));
writeFileSync("public/apple-touch-icon.png", png(180, true));
console.log("icons generated");
