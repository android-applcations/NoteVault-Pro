// Presentation layer – custom Tiptap extensions and editor assembly.
import { mergeAttributes, Mark, Node } from "@tiptap/core";
import Color from "@tiptap/extension-color";
import Highlight from "@tiptap/extension-highlight";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import TextAlign from "@tiptap/extension-text-align";
import { FontSize, TextStyle } from "@tiptap/extension-text-style";
import StarterKit from "@tiptap/starter-kit";
import { db } from "@/data/db";
import { isUuid, safeCssColor, safeCssSize } from "@/domain/sanitize";
import { formatDuration } from "@/domain/text";

/** Side note / callout block. */
export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,
  parseHTML: () => [{ tag: "div[data-callout]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-callout": "" }), 0],
});

/** Inline formula (rendered LTR, never mirrored in RTL documents). */
export const Formula = Mark.create({
  name: "formula",
  parseHTML: () => [{ tag: "span[data-formula]" }],
  renderHTML: ({ HTMLAttributes }) => ["span", mergeAttributes(HTMLAttributes, { "data-formula": "" }), 0],
});

/** Image that references a stored attachment (no remote URLs, no base64 inside the document). */
export const AttachmentImage = Image.extend({
  addAttributes() {
    return {
      // Explicitly neutralize external/data-URL src from pasted HTML
      src: {
        default: null,
        parseHTML: () => null,
        renderHTML: () => ({}),
      },
      attId: {
        default: null,
        parseHTML: (el) => {
          const v = el.getAttribute("data-att-id");
          return isUuid(v) ? v : null;
        },
        renderHTML: (a) => (isUuid(a.attId) ? { "data-att-id": a.attId } : {}),
      },
      alt: {
        default: "",
        parseHTML: (el) => (el.getAttribute("alt") ?? "").slice(0, 500),
      },
    };
  },
  addNodeView() {
    return ({ node }) => {
      const img = document.createElement("img");
      img.alt = typeof node.attrs.alt === "string" ? node.attrs.alt.slice(0, 500) : "";
      const attId = isUuid(node.attrs.attId) ? node.attrs.attId : null;
      img.setAttribute("data-att-id", attId ?? "");
      img.loading = "lazy";
      let url: string | null = null;
      let alive = true;
      if (attId) {
        db.attachments.get(attId).then(async (a) => {
          const rec = a && (await db.blobs.get(a.blobId));
          if (!alive) return;
          if (rec) {
            url = URL.createObjectURL(rec.blob);
            img.src = url;
          } else {
            img.alt = "⚠";
          }
        });
      }
      img.addEventListener("dblclick", () => window.dispatchEvent(new CustomEvent("nv-open-image", { detail: { attId } })));
      return {
        dom: img,
        destroy: () => {
          alive = false;
          if (url) URL.revokeObjectURL(url);
        },
      };
    };
  },
}).configure({ inline: false, allowBase64: false });

const SafeColor = Color.extend({
  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          color: {
            default: null,
            parseHTML: (el) => safeCssColor(el.style.color, "") || null,
            renderHTML: (attrs) => {
              const c = safeCssColor(attrs.color, "");
              return c ? { style: `color: ${c}` } : {};
            },
          },
        },
      },
    ];
  },
});

const SafeFontSize = FontSize.extend({
  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (el) => safeCssSize(el.style.fontSize),
            renderHTML: (attrs) => {
              const sz = safeCssSize(attrs.fontSize);
              return sz ? { style: `font-size: ${sz}` } : {};
            },
          },
        },
      },
    ];
  },
});

const SafeHighlight = Highlight.extend({
  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (el) => {
          const raw = el.getAttribute("data-color") || el.style.backgroundColor;
          return safeCssColor(raw, "") || null;
        },
        renderHTML: (attrs) => {
          const c = safeCssColor(attrs.color, "");
          return c ? { "data-color": c, style: `background-color: ${c}; color: inherit` } : {};
        },
      },
    };
  },
});

/** Clickable audio timestamp pill linked to a lecture recording. */
export const AudioTimestamp = Node.create({
  name: "audioTimestamp",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      recordingId: {
        default: null,
        parseHTML: (el) => {
          const v = el.getAttribute("data-recording-id");
          return isUuid(v) ? v : null;
        },
        renderHTML: (a) => (isUuid(a.recordingId) ? { "data-recording-id": a.recordingId } : {}),
      },
      attachmentId: {
        default: null,
        parseHTML: (el) => {
          const v = el.getAttribute("data-attachment-id");
          return isUuid(v) ? v : null;
        },
        renderHTML: (a) => (isUuid(a.attachmentId) ? { "data-attachment-id": a.attachmentId } : {}),
      },
      timeMs: {
        default: 0,
        parseHTML: (el) => {
          const n = Number(el.getAttribute("data-time-ms"));
          return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
        },
        renderHTML: (a) => ({ "data-time-ms": String(Math.max(0, Math.round(Number(a.timeMs) || 0))) }),
      },
      label: {
        default: "",
        parseHTML: (el) => (el.getAttribute("data-label") ?? "").slice(0, 120),
        renderHTML: (a) => (a.label ? { "data-label": String(a.label).slice(0, 120) } : {}),
      },
    };
  },
  parseHTML: () => [{ tag: "button[data-audio-ts]" }, { tag: "span[data-audio-ts]" }],
  renderHTML: ({ HTMLAttributes, node }) => [
    "button",
    mergeAttributes(HTMLAttributes, {
      type: "button",
      "data-audio-ts": "",
      dir: "ltr",
      class: "inline-flex items-center gap-1 rounded-lg bg-accent/15 px-2 py-0.5 text-xs font-extrabold text-accent hover:bg-accent/25 mx-0.5 align-baseline",
    }),
    `⏱ ${formatDuration(Number(node.attrs.timeMs) || 0)}`,
  ],
  addNodeView() {
    return ({ node }) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("data-audio-ts", "");
      if (isUuid(node.attrs.recordingId)) btn.setAttribute("data-recording-id", node.attrs.recordingId);
      if (isUuid(node.attrs.attachmentId)) btn.setAttribute("data-attachment-id", node.attrs.attachmentId);
      const timeMs = Math.max(0, Math.round(Number(node.attrs.timeMs) || 0));
      btn.setAttribute("data-time-ms", String(timeMs));
      btn.dir = "ltr";
      btn.className = "inline-flex items-center gap-1 rounded-lg bg-accent/15 px-2 py-0.5 text-xs font-extrabold text-accent hover:bg-accent/25 cursor-pointer mx-0.5 align-baseline select-none";
      const label = typeof node.attrs.label === "string" && node.attrs.label ? ` · ${node.attrs.label}` : "";
      btn.textContent = `⏱ ${formatDuration(timeMs)}${label}`;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.dispatchEvent(
          new CustomEvent("nv-jump-audio", {
            detail: {
              recordingId: isUuid(node.attrs.recordingId) ? node.attrs.recordingId : undefined,
              attachmentId: isUuid(node.attrs.attachmentId) ? node.attrs.attachmentId : undefined,
              timeMs,
            },
          })
        );
      });
      return { dom: btn };
    };
  },
});

export function buildExtensions(placeholder: string) {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      link: {
        openOnClick: false,
        autolink: true,
        protocols: ["http", "https", "mailto", "tel"],
        HTMLAttributes: { rel: "noopener noreferrer nofollow", target: "_blank" },
      },
    }),
    TextStyle,
    SafeFontSize,
    SafeColor,
    SafeHighlight.configure({ multicolor: true }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    TextAlign.configure({ types: ["heading", "paragraph"] }),
    Placeholder.configure({ placeholder }),
    Callout,
    Formula,
    AttachmentImage,
    AudioTimestamp,
  ];
}
