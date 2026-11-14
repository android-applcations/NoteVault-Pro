// Domain logic – text utilities: Arabic normalisation, snippets, plain-text extraction.
import type { JSONContent } from "@tiptap/core";

const DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/;

function normChar(ch: string): string {
  if (DIACRITICS.test(ch)) return "";
  switch (ch) {
    case "أ": case "إ": case "آ": case "ٱ": return "ا";
    case "ى": return "ي";
    case "ئ": return "ي";
    case "ؤ": return "و";
    case "ة": return "ه";
    case "گ": return "ك";
    case "ک": return "ك";
    case "ی": return "ي";
    case "ە": return "ه";
  }
  // Arabic-Indic digits → ASCII digits
  const code = ch.charCodeAt(0);
  if (code >= 0x0660 && code <= 0x0669) return String(code - 0x0660);
  if (code >= 0x06f0 && code <= 0x06f9) return String(code - 0x06f0);
  const lower = ch.toLowerCase();
  return lower.length === 1 ? lower : ch;
}

/** Normalises text for matching (diacritics, letter variants, case). */
export function normalize(text: string): string {
  let out = "";
  for (const ch of text) out += normChar(ch);
  return out;
}

/** Normalises and returns a map from normalised index → original index. */
export function normalizeWithMap(text: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  let i = 0;
  for (const ch of text) {
    const n = normChar(ch);
    for (let k = 0; k < n.length; k++) map.push(i);
    norm += n;
    i += ch.length;
  }
  map.push(i);
  return { norm, map };
}

export function queryTerms(q: string): string[] {
  return normalize(q)
    .split(/[\s\p{P}\p{S}]+/u)
    .map((t) => t.trim())
    .filter(Boolean);
}

export interface SnippetPart {
  text: string;
  hit: boolean;
}

/** Builds a snippet around the first match; highlighted ranges are returned as plain parts (never HTML). */
export function makeSnippet(text: string, terms: string[], radius = 70): { parts: SnippetPart[]; index: number } {
  if (!text) return { parts: [], index: -1 };
  const { norm, map } = normalizeWithMap(text);
  const ranges: [number, number][] = [];
  for (const t of terms) {
    if (!t) continue;
    let from = 0;
    let guard = 0;
    while (guard++ < 200) {
      const idx = norm.indexOf(t, from);
      if (idx < 0) break;
      // extend to the end of the word so prefix matches highlight the whole word
      let end = idx + t.length;
      while (end < norm.length && /[\p{L}\p{N}]/u.test(norm[end])) end++;
      ranges.push([map[idx], map[Math.min(end, map.length - 1)]]);
      from = idx + t.length;
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const first = ranges[0]?.[0] ?? 0;
  const start = Math.max(0, first - radius);
  const end = Math.min(text.length, first + radius * 2);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    if (r[0] >= end) break;
    if (r[1] <= start) continue;
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([Math.max(r[0], start), Math.min(r[1], end)]);
  }
  const parts: SnippetPart[] = [];
  let cur = start;
  if (start > 0) parts.push({ text: "…", hit: false });
  for (const [a, b] of merged) {
    if (a > cur) parts.push({ text: text.slice(cur, a), hit: false });
    parts.push({ text: text.slice(a, b), hit: true });
    cur = b;
  }
  if (cur < end) parts.push({ text: text.slice(cur, end), hit: false });
  if (end < text.length) parts.push({ text: "…", hit: false });
  return { parts, index: ranges.length ? first : -1 };
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "00:00";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${String(h).padStart(2, "0")}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function parseDuration(str: string): number | null {
  const s = str.trim();
  const parts = s.split(":").map((x) => x.trim());
  if (parts.length < 2 || parts.length > 3) return null;
  const nums = parts.map((x) => Number(x));
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  if (parts.length === 2) {
    const [m, sec] = nums;
    if (sec >= 60) return null;
    return Math.round((m * 60 + sec) * 1000);
  }
  const [h, m, sec] = nums;
  if (m >= 60 || sec >= 60) return null;
  return Math.round((h * 3600 + m * 60 + sec) * 1000);
}

/** Extracts plain text from a Tiptap JSON document. */
export function plainFromDoc(doc: JSONContent | null | undefined): string {
  if (!doc) return "";
  const out: string[] = [];
  const BLOCKS = new Set(["paragraph", "heading", "listItem", "taskItem", "blockquote", "codeBlock", "tableRow", "callout"]);
  const walk = (n: JSONContent) => {
    if (n.type === "text" && n.text) out.push(n.text);
    else if (n.type === "audioTimestamp") {
      const ms = Number(n.attrs?.timeMs) || 0;
      const lbl = typeof n.attrs?.label === "string" && n.attrs.label ? ` ${n.attrs.label}` : "";
      out.push(` [${formatDuration(ms)}${lbl}] `);
    }
    else if (n.type === "hardBreak") out.push("\n");
    if (n.content) {
      for (const c of n.content) walk(c);
    }
    if (n.type && BLOCKS.has(n.type)) out.push("\n");
    else if (n.type === "tableCell" || n.type === "tableHeader") out.push(" ");
  };
  walk(doc);
  return out.join("").replace(/\n{3,}/g, "\n\n").trim();
}

export function wordCount(text: string): number {
  const m = text.match(/[\p{L}\p{N}]+/gu);
  return m ? m.length : 0;
}

/** Fast non-cryptographic string hash (cyrb53). */
export function hashString(str: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function formatBytes(n: number): string {
  if (!isFinite(n) || n <= 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*\u202a-\u202e\u2066-\u2069]/g, "").replace(/^\.+/, "").trim();
  const out = cleaned.slice(0, 140);
  return out || "file";
}

export function todayISO(d = new Date()): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}
