// Security layer – structural sanitisation of stored/imported rich-text documents, URLs, and inline CSS values.
import type { JSONContent } from "@tiptap/core";

const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

/** Returns the URL if it is safe to render as a link, otherwise null. */
export function safeUrl(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const s = input.trim();
  if (!s || s.length > 2048) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) return null;
  if (s.startsWith("#")) return s;
  try {
    const u = new URL(s, "https://invalid.example");
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !SAFE_PROTOCOLS.has(u.protocol)) return null;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) return null; // no relative URLs
    return s;
  } catch {
    return null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const COLOR = /^(#[0-9a-f]{3,8}|rgba?\(\s*\d{1,3}(?:\.\d+)?(?:\s*,\s*|\s+)\d{1,3}(?:\.\d+)?(?:\s*,\s*|\s+)\d{1,3}(?:\.\d+)?(?:\s*[,/]\s*(?:0|1|0?\.\d+|\d{1,3}%))?\s*\)|hsla?\(\s*\d{1,3}(?:\.\d+)?(?:deg)?(?:\s*,\s*|\s+)\d{1,3}%(?:\s*,\s*|\s+)\d{1,3}%(?:\s*[,/]\s*(?:0|1|0?\.\d+|\d{1,3}%))?\s*\))$/i;
const SIZE = /^\d{1,3}(\.\d{1,2})?(px|pt|em|rem)$/;
const DATA_IMAGE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

/** Validates a CSS color string, returning a safe fallback when invalid or containing CSS injection characters. */
export function safeCssColor(input: unknown, fallback = "#6366f1"): string {
  if (typeof input !== "string") return fallback;
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 64) return fallback;
  if (/[;{}'"\\<>]|url\s*\(|expression\s*\(|var\s*\(/i.test(trimmed)) return fallback;
  return COLOR.test(trimmed) ? trimmed : fallback;
}

/** Validates a strict 6-digit hex color string (for subject / highlight colors). */
export function safeHexColor(input: unknown, fallback = "#6366f1"): string {
  if (typeof input !== "string") return fallback;
  const trimmed = input.trim();
  return HEX_COLOR.test(trimmed) ? trimmed : fallback;
}

/** Validates a safe raster data-URL image (PNG/JPEG/WebP only — never SVG). */
export function safeDataImageUrl(input: unknown, maxBytes = 3_000_000): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > maxBytes) return null;
  return DATA_IMAGE.test(trimmed) ? trimmed : null;
}

/** Validates a CSS font-size string used in Tiptap marks. */
export function safeCssSize(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  return SIZE.test(trimmed) ? trimmed : null;
}

const NODES = new Set([
  "doc", "paragraph", "text", "heading", "bulletList", "orderedList", "listItem", "taskList", "taskItem",
  "blockquote", "horizontalRule", "codeBlock", "hardBreak", "table", "tableRow", "tableCell", "tableHeader",
  "image", "callout",
]);
const MARKS = new Set(["bold", "italic", "underline", "strike", "link", "highlight", "textStyle", "code", "formula"]);
const MAX_DEPTH = 40;
const MAX_NODES = 300_000;

function cleanAttrs(type: string, attrs: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!attrs) return undefined;
  const out: Record<string, unknown> = {};
  switch (type) {
    case "heading": {
      const l = Number(attrs.level);
      out.level = l >= 1 && l <= 3 ? l : 2;
      break;
    }
    case "orderedList": {
      const s = Number(attrs.start);
      out.start = Number.isInteger(s) && s > 0 && s < 100000 ? s : 1;
      break;
    }
    case "taskItem":
      out.checked = attrs.checked === true;
      break;
    case "image":
      if (typeof attrs.attId === "string" && UUID.test(attrs.attId)) out.attId = attrs.attId;
      if (typeof attrs.alt === "string") out.alt = attrs.alt.slice(0, 500);
      break;
    case "tableCell":
    case "tableHeader": {
      for (const k of ["colspan", "rowspan"] as const) {
        const v = Number(attrs[k]);
        out[k] = Number.isInteger(v) && v >= 1 && v <= 50 ? v : 1;
      }
      break;
    }
    case "link": {
      const h = safeUrl(attrs.href);
      if (!h) return undefined;
      out.href = h;
      out.target = "_blank";
      out.rel = "noopener noreferrer nofollow";
      break;
    }
    case "highlight": {
      const c = safeCssColor(attrs.color, "");
      if (c) out.color = c;
      break;
    }
    case "textStyle": {
      const c = safeCssColor(attrs.color, "");
      if (c) out.color = c;
      const sz = safeCssSize(attrs.fontSize);
      if (sz) out.fontSize = sz;
      break;
    }
    case "codeBlock":
      if (typeof attrs.language === "string" && /^[\w+#-]{1,20}$/.test(attrs.language)) out.language = attrs.language;
      break;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Sanitises an unknown value into a safe Tiptap document. Never throws. */
export function sanitizeDoc(input: unknown): JSONContent | null {
  if (!input || typeof input !== "object") return null;
  let count = 0;
  const walk = (n: unknown, depth: number): JSONContent | null => {
    if (!n || typeof n !== "object" || depth > MAX_DEPTH || ++count > MAX_NODES) return null;
    const node = n as Record<string, unknown>;
    const type = node.type;
    if (typeof type !== "string" || !NODES.has(type)) return null;
    if (type === "image" && !(node.attrs as Record<string, unknown> | undefined)?.attId) return null;
    const out: JSONContent = { type };
    const attrs = cleanAttrs(type, node.attrs as Record<string, unknown> | undefined);
    if (attrs) out.attrs = attrs;
    if (type === "text") {
      if (typeof node.text !== "string" || node.text.length === 0) return null;
      out.text = node.text.slice(0, 200_000);
    }
    if (Array.isArray(node.marks)) {
      const marks: NonNullable<JSONContent["marks"]> = [];
      for (const m of node.marks as Record<string, unknown>[]) {
        if (!m || typeof m.type !== "string" || !MARKS.has(m.type)) continue;
        const a = cleanAttrs(m.type, m.attrs as Record<string, unknown> | undefined);
        if (m.type === "link" && !a) continue;
        marks.push(a ? { type: m.type, attrs: a } : { type: m.type });
      }
      if (marks.length) out.marks = marks;
    }
    if (Array.isArray(node.content)) {
      const kids: JSONContent[] = [];
      for (const c of node.content) {
        const k = walk(c, depth + 1);
        if (k) kids.push(k);
      }
      if (kids.length) out.content = kids;
    }
    return out;
  };
  const doc = walk(input, 0);
  if (!doc || doc.type !== "doc") return null;
  if (!doc.content || doc.content.length === 0) doc.content = [{ type: "paragraph" }];
  return doc;
}

export function isUuid(s: unknown): s is string {
  return typeof s === "string" && UUID.test(s);
}
