// Presentation layer – flashcard create/edit modal (also opened from the editor, PDF viewer, etc.).
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { db } from "@/data/db";
import type { CardType, Flashcard } from "@/data/types";
import { createCard, createDeck, getOrCreateDeck, updateCard } from "@/services/cards";
import { errMsg } from "@/services/core";
import { useApp, type CardPrefill } from "./app-context";
import { useI18n } from "./i18n";
import { Button, Field, Input, Modal, Select, Textarea } from "./kit";

export function CardEditor({ open, onClose, card, prefill, onSaved }: { open: boolean; onClose: () => void; card?: Flashcard; prefill?: CardPrefill; onSaved?: () => void }) {
  const { t } = useI18n();
  const { toast } = useApp();
  const decks = useLiveQuery(() => db.flashcardDecks.toArray(), []) ?? [];
  const images = useLiveQuery(() => db.attachments.where("kind").equals("image").filter((a) => !a.deletedAt).toArray(), []) ?? [];
  const [type, setType] = useState<CardType>("qa");
  const [front, setFront] = useState("");
  const [back, setBack] = useState("");
  const [faces, setFaces] = useState("");
  const [deckId, setDeckId] = useState("");
  const [newDeck, setNewDeck] = useState("");
  const [imageId, setImageId] = useState("");

  useEffect(() => {
    if (!open) return;
    setType(card?.type ?? prefill?.type ?? "qa");
    setFront(card?.front ?? prefill?.front ?? "");
    setBack(card?.back ?? prefill?.back ?? "");
    setFaces((card?.faces ?? []).join("\n"));
    setDeckId(card?.deckId ?? "");
    setImageId(card?.imageId ?? prefill?.imageId ?? "");
    setNewDeck("");
  }, [open, card, prefill]);

  const types: { id: CardType; label: string }[] = [
    { id: "qa", label: t("سؤال وجواب", "Question & answer") },
    { id: "term", label: t("مصطلح وتعريف", "Term & definition") },
    { id: "cloze", label: t("أكمل الفراغ", "Cloze (fill in the blank)") },
    { id: "compare", label: t("مقارنة", "Comparison") },
    { id: "imageq", label: t("سؤال بصورة", "Image question") },
    { id: "imagelabel", label: t("صورة مع تسمية الأجزاء", "Image labelling") },
    { id: "formula", label: t("معادلة", "Formula") },
    { id: "multiface", label: t("متعددة الأوجه", "Multi-face") },
  ];
  const needsImage = type === "imageq" || type === "imagelabel";
  const hint: Record<CardType, string> = {
    qa: t("السؤال", "Question"), term: t("المصطلح", "Term"), cloze: t("النص مع {{الكلمة المخفية}}", "Text with {{hidden word}}"),
    compare: t("عنوان المقارنة (مثلاً: أ مقابل ب)", "Comparison title (e.g. A vs B)"), imageq: t("السؤال عن الصورة", "Question about the image"),
    imagelabel: t("تعليمات (مثلاً: سمِّ الأجزاء)", "Instruction (e.g. label the parts)"), formula: t("اسم المعادلة / السؤال", "Formula name / question"),
    multiface: t("الوجه الأول", "First face"),
  };

  const save = async () => {
    try {
      let id = deckId;
      if (!id) {
        if (newDeck.trim()) id = (await createDeck({ name: newDeck, subjectId: prefill?.subjectId })).id;
        else id = (await getOrCreateDeck(prefill?.subjectId, t("عام", "General"))).id;
      }
      const data = { front, back: type === "cloze" && !back ? "" : back, faces: faces.split("\n"), imageId: imageId || undefined };
      if (type === "cloze" && !/\{\{[^{}]+\}\}/.test(front)) return toast(t("ضع الكلمة المخفية بين {{ }}", "Wrap the hidden word in {{ }}"), "err");
      if (type !== "cloze" && type !== "multiface" && type !== "imagelabel" && !back.trim()) return toast(t("أضف الإجابة", "Add the answer"), "err");
      if (needsImage && !imageId) return toast(t("اختر صورة", "Choose an image"), "err");
      if (card) await updateCard(card.id, { ...data, type, deckId: id });
      else await createCard({ ...data, deckId: id, type, source: prefill?.source });
      toast(t("تم حفظ البطاقة", "Card saved"));
      onSaved?.();
      onClose();
    } catch (e) {
      toast(errMsg(e) === "EMPTY" ? t("أكمل الحقول المطلوبة", "Fill in the required fields") : t("تعذر الحفظ", "Could not save"), "err");
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={card ? t("تعديل بطاقة", "Edit card") : t("بطاقة جديدة", "New flashcard")} wide
      footer={<><Button onClick={onClose}>{t("إلغاء", "Cancel")}</Button><Button variant="primary" onClick={() => void save()}>{t("حفظ", "Save")}</Button></>}>
      <div className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("نوع البطاقة", "Card type")}>{(id) => <Select id={id} value={type} onChange={(e) => setType(e.target.value as CardType)}>{types.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</Select>}</Field>
          <Field label={t("المجموعة", "Deck")}>
            {(id) => (
              <Select id={id} value={deckId} onChange={(e) => setDeckId(e.target.value)}>
                <option value="">{t("تلقائي (حسب المادة)", "Automatic (by subject)")}</option>
                {decks.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </Select>
            )}
          </Field>
        </div>
        {!deckId && !card && <Field label={t("أو أنشئ مجموعة جديدة", "Or create a new deck")}>{(id) => <Input id={id} value={newDeck} onChange={(e) => setNewDeck(e.target.value)} />}</Field>}
        <Field label={hint[type]}>{(id) => <Textarea id={id} rows={3} value={front} onChange={(e) => setFront(e.target.value)} dir="auto" />}</Field>
        {needsImage && (
          <Field label={t("الصورة (من مكتبة الملفات)", "Image (from the file vault)")} hint={images.length ? undefined : t("أضف صورة إلى المكتبة أولاً", "Add an image to the vault first")}>
            {(id) => <Select id={id} value={imageId} onChange={(e) => setImageId(e.target.value)}><option value="">—</option>{images.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>}
          </Field>
        )}
        {(type === "multiface" || type === "imagelabel") && (
          <Field label={type === "imagelabel" ? t("التسميات (سطر لكل تسمية)", "Labels (one per line)") : t("الأوجه التالية (سطر لكل وجه)", "Next faces (one per line)")}>{(id) => <Textarea id={id} rows={4} value={faces} onChange={(e) => setFaces(e.target.value)} dir="auto" />}</Field>
        )}
        {type !== "cloze" && type !== "multiface" && <Field label={type === "compare" ? t("المقارنة (سطر لكل نقطة: أ | ب)", "Comparison (one row per line: A | B)") : t("الإجابة", "Answer")}>{(id) => <Textarea id={id} rows={3} value={back} onChange={(e) => setBack(e.target.value)} dir={type === "formula" ? "ltr" : "auto"} />}</Field>}
        {type === "cloze" && <Field label={t("ملاحظة إضافية (اختياري)", "Extra note (optional)")}>{(id) => <Textarea id={id} rows={2} value={back} onChange={(e) => setBack(e.target.value)} dir="auto" />}</Field>}
      </div>
    </Modal>
  );
}
