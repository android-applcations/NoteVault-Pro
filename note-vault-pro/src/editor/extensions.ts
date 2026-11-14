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
      attId: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-att-id"),
        renderHTML: (a) => (a.attId ? { "data-att-id": a.attId } : {}),
      },
      alt: { default: "" },
    };
  },
  addNodeView() {
    return ({ node }) => {
      const img = document.createElement("img");
      img.alt = (node.attrs.alt as string) || "";
      img.setAttribute("data-att-id", node.attrs.attId ?? "");
      img.loading = "lazy";
      let url: string | null = null;
      let alive = true;
      const attId = node.attrs.attId as string | null;
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
    FontSize,
    Color,
    Highlight.configure({ multicolor: true }),
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
  ];
}
