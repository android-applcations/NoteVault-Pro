import { Link } from "react-router-dom";
import { db } from "@/data/db";
import type { Flashcard } from "@/data/types";
import { parseCloze } from "@/domain/quiz";
import { useLiveQuery } from "dexie-react-hooks";
import { FormulaText, FormulaView } from "./FormulaView";
import { useI18n } from "./i18n";
import { useBlobUrl } from "./shared";

function CardImage({ id }: { id: string }) {
  const att = useLiveQuery(() => db.attachments.get(id), [id]);
  const { url } = useBlobUrl(att);
  if (!url) return null;
  return <img src={url} alt={att?.description || att?.name || ""} className="mx-auto mb-4 max-h-64 rounded-xl object-contain" />;
}

export function CardView({ card, revealed }: { card: Flashcard; revealed: boolean }) {
  const { t } = useI18n();
  const back = card.back.trim();
  let front: React.ReactNode;
  let answer: React.ReactNode = null;

  if (card.type === "cloze") {
    const segs = parseCloze(card.front);
    front = (
      <p className="text-xl leading-10" dir="auto">
        {segs.map((s, i) => s.blank === undefined ? <span key={i}>{s.text}</span> : revealed
          ? <mark key={i} className="rounded bg-accent/25 px-1.5 font-extrabold text-fg">{s.blank.split("|")[0]}</mark>
          : <span key={i} className="mx-1 inline-block min-w-16 border-b-2 border-accent text-transparent select-none">{s.blank}</span>)}
      </p>
    );
    if (revealed && back) answer = <p className="text-sm text-muted" dir="auto">{back}</p>;
  } else {
    front = <p className="whitespace-pre-wrap text-xl font-bold leading-9" dir="auto"><FormulaText text={card.front} /></p>;
    if (revealed) {
      if (card.type === "compare") {
        const rows = back.split("\n").map((r) => r.split("|").map((x) => x.trim()));
        answer = <table className="mx-auto w-full max-w-md border-collapse text-sm"><tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="border border-line px-3 py-1.5" dir="auto">{c}</td>)}</tr>)}</tbody></table>;
      } else if (card.type === "imagelabel") {
        answer = <ol className="mx-auto max-w-md list-decimal space-y-1 ps-6 text-start text-base" dir="auto">{card.faces.map((f, i) => <li key={i}>{f}</li>)}</ol>;
      } else if (card.type === "multiface") {
        answer = <div className="space-y-2">{card.faces.map((f, i) => <div key={i} className="rounded-xl bg-surface2 p-3 text-base" dir="auto"><FormulaText text={f} /></div>)}{back && <p className="text-sm text-muted" dir="auto"><FormulaText text={back} /></p>}</div>;
      } else if (card.type === "formula") {
        answer = <div className="ltr-iso rounded-xl bg-primary/10 p-4 text-xl"><FormulaView tex={back} displayMode /></div>;
      } else {
        answer = <p className="whitespace-pre-wrap text-lg" dir="auto"><FormulaText text={back} /></p>;
      }
    }
  }
  const src = card.source;
  return (
    <div className="nv-selectable space-y-4 text-center">
      {card.imageId && <CardImage id={card.imageId} />}
      {front}
      {revealed && <div className="mx-auto h-px w-24 bg-line" />}
      {revealed && answer}
      {revealed && src && (src.attachmentId || src.noteId) && (
        <div className="text-xs font-bold">
          {src.attachmentId && <Link className="text-accent hover:underline" to={`/files/${src.attachmentId}?page=${src.page ?? 1}`}>↗ {t("المصدر: صفحة", "Source: page")} {src.page ?? 1}</Link>}
          {!src.attachmentId && src.noteId && <Link className="text-accent hover:underline" to={`/notes/${src.noteId}`}>↗ {t("المصدر: الملاحظة", "Source: note")}</Link>}
        </div>
      )}
    </div>
  );
}
