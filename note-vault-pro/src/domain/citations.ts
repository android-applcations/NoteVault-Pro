// Domain logic – citation formatting (APA 7, MLA 9, IEEE, Chicago author-date).
// Only the data supplied by the user is formatted; nothing is invented or verified online.
import type { Reference } from "@/data/types";

export type CitationStyle = "apa" | "mla" | "ieee" | "chicago";
export interface Part {
  text: string;
  italic?: boolean;
}

interface Person {
  last: string;
  first: string;
}

export function parseAuthors(raw: string): Person[] {
  return raw
    .split(/\n|;/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      if (l.includes(",")) {
        const [last, ...rest] = l.split(",");
        return { last: last.trim(), first: rest.join(",").trim() };
      }
      const bits = l.split(/\s+/);
      if (bits.length === 1) return { last: bits[0], first: "" };
      return { last: bits[bits.length - 1], first: bits.slice(0, -1).join(" ") };
    });
}

const initials = (first: string, withSpace = true) =>
  first
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + ".")
    .join(withSpace ? " " : "");

function listAnd(items: string[], amp: boolean): string {
  if (items.length <= 1) return items[0] ?? "";
  const conj = amp ? "&" : "and";
  return `${items.slice(0, -1).join(", ")}, ${conj} ${items[items.length - 1]}`;
}

const end = (s: string) => (!s ? s : /[.!?]$/.test(s) ? s : s + ".");
const isArticle = (r: Reference) => r.type === "article";
const isWeb = (r: Reference) => r.type === "website";

function link(r: Reference): string {
  if (r.doi) return /^https?:/i.test(r.doi) ? r.doi : `https://doi.org/${r.doi}`;
  return r.url;
}

export function formatCitation(r: Reference, style: CitationStyle): Part[] {
  const people = parseAuthors(r.authors);
  const year = r.year.trim();
  const parts: Part[] = [];
  const push = (text: string, italic = false) => {
    if (text) parts.push({ text, italic });
  };
  const title = r.title.trim();
  const container = r.container.trim();
  const pages = r.pages.trim();
  const vol = r.volume.trim();
  const issue = r.issue.trim();
  const pub = r.publisher.trim();
  const url = link(r);

  switch (style) {
    case "apa": {
      const names = people.map((p) => (p.first ? `${p.last}, ${initials(p.first)}` : p.last));
      const a = people.length > 20 ? names.slice(0, 19).join(", ") + ", ... " + names[names.length - 1] : listAnd(names, true);
      if (a) push(end(a) + " ");
      push(`(${year || "n.d."}). `);
      if (isArticle(r)) {
        push(end(title) + " ");
        if (container) push(container, true);
        if (vol) push(`, ${vol}`, false);
        if (issue) push(`(${issue})`);
        if (pages) push(`, ${pages}`);
        push(". ");
      } else {
        push(title, !isArticle(r));
        push(". ");
        if (isWeb(r) && container) push(end(container) + " ");
        else if (pub) push(end(pub) + " ");
      }
      push(url);
      break;
    }
    case "mla": {
      const names = people.map((p, i) => (i === 0 ? (p.first ? `${p.last}, ${p.first}` : p.last) : `${p.first} ${p.last}`.trim()));
      let a = "";
      if (people.length > 2) a = `${names[0]}, et al`;
      else if (people.length === 2) a = `${names[0]}, and ${names[1]}`;
      else a = names[0] ?? "";
      if (a) push(end(a) + " ");
      if (isArticle(r)) {
        push(`“${end(title)}” `);
        const bits = [container && "", vol && `vol. ${vol}`, issue && `no. ${issue}`, year, pages && `pp. ${pages}`].filter((x) => x !== "" && x !== undefined) as string[];
        if (container) push(container, true);
        if (bits.length) push((container ? ", " : "") + bits.join(", "));
        push(". ");
      } else {
        push(title, true);
        push(". ");
        const b = [isWeb(r) ? container : pub, year].filter(Boolean).join(", ");
        if (b) push(end(b) + " ");
      }
      push(url);
      break;
    }
    case "ieee": {
      const names = people.map((p) => (p.first ? `${initials(p.first)} ${p.last}` : p.last));
      let a = names.length > 6 ? `${names[0]} et al.` : names.length > 2 ? `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}` : names.join(" and ");
      if (a) push(a + ", ");
      if (isArticle(r)) {
        push(`“${title},” `);
        if (container) push(container, true);
        const bits = [vol && `vol. ${vol}`, issue && `no. ${issue}`, pages && `pp. ${pages}`, year].filter(Boolean).join(", ");
        push((container ? ", " : "") + bits);
        if (r.doi) push(`, doi: ${r.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")}`);
        push(".");
        if (!r.doi && url) push(` [Online]. Available: ${url}`);
      } else {
        push(title, true);
        push(". ");
        const b = [isWeb(r) ? container : pub, year].filter(Boolean).join(", ");
        if (b) push(end(b));
        if (url) push(` [Online]. Available: ${url}`);
      }
      break;
    }
    case "chicago": {
      const names = people.map((p, i) => (i === 0 ? (p.first ? `${p.last}, ${p.first}` : p.last) : `${p.first} ${p.last}`.trim()));
      const a = names.length > 3 ? `${names[0]}, et al.` : listAnd(names, false);
      if (a) push(end(a) + " ");
      push(end(year || "n.d.") + " ");
      if (isArticle(r)) {
        push(`“${end(title)}” `);
        if (container) push(container, true);
        if (vol) push(` ${vol}`);
        if (issue) push(` (${issue})`);
        if (pages) push(`: ${pages}`);
        push(". ");
      } else {
        push(title, true);
        push(". ");
        const b = isWeb(r) ? container : pub;
        if (b) push(end(b) + " ");
      }
      push(url);
      break;
    }
  }
  // trim trailing whitespace
  const last = parts[parts.length - 1];
  if (last) last.text = last.text.replace(/\s+$/, "");
  return parts.filter((p) => p.text);
}

export const citationToPlain = (parts: Part[]): string => parts.map((p) => p.text).join("").replace(/\s+/g, " ").trim();

export function toBibtex(r: Reference): string {
  const key = (parseAuthors(r.authors)[0]?.last || "ref").replace(/\W/g, "") + (r.year || "") + r.id.slice(0, 4);
  const type = r.type === "article" ? "article" : r.type === "book" ? "book" : r.type === "thesis" ? "phdthesis" : "misc";
  const esc = (s: string) => s.replace(/[{}\\]/g, "");
  const f = (k: string, v: string) => (v ? `  ${k} = {${esc(v)}},\n` : "");
  const authors = parseAuthors(r.authors).map((p) => (p.first ? `${p.last}, ${p.first}` : p.last)).join(" and ");
  return `@${type}{${key},\n${f("author", authors)}${f("title", r.title)}${f(r.type === "article" ? "journal" : "howpublished", r.container)}${f("publisher", r.publisher)}${f("year", r.year)}${f("volume", r.volume)}${f("number", r.issue)}${f("pages", r.pages)}${f("doi", r.doi)}${f("url", r.url)}}\n`;
}
