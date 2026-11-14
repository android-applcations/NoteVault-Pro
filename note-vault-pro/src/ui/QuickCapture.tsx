// Presentation layer – Quick Capture modal (available from every page).
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { createQuickNote } from "@/services/notes";
import { errMsg } from "@/services/core";
import { useApp } from "./app-context";
import { useI18n } from "./i18n";
import { Button, Field, Input, Modal, Select, Textarea } from "./kit";
import { useSubjects } from "./shared";

export function QuickCapture() {
  const { t } = useI18n();
  const { quickOpen, setQuickOpen, toast } = useApp();
  const nav = useNavigate();
  const subjects = useSubjects();
  const [text, setText] = useState("");
  const [subjectId, setSubjectId] = useState("");
  const [tags, setTags] = useState("");
  const [task, setTask] = useState(false);
  const [pin, setPin] = useState(false);
  const [busy, setBusy] = useState(false);

  const reset = () => { setText(""); setTags(""); setTask(false); setPin(false); };
  const save = async (open: boolean) => {
    setBusy(true);
    try {
      const n = await createQuickNote(text, { subjectId: subjectId || undefined, asTask: task, pinned: pin, tags: tags.split(/[,،\s]+/).filter(Boolean) });
      toast(t("تم حفظ الملاحظة السريعة", "Quick note saved"));
      reset();
      setQuickOpen(false);
      if (open) nav(`/notes/${n.id}`);
    } catch (e) {
      toast(errMsg(e) === "EMPTY" ? t("اكتب شيئاً أولاً", "Write something first") : t("تعذر الحفظ", "Could not save"), "err");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={quickOpen} onClose={() => setQuickOpen(false)} title={t("التقاط سريع", "Quick capture")}
      footer={<>
        <Button onClick={() => void save(true)} disabled={busy || !text.trim()}>{t("حفظ وفتح في المحرر", "Save & open in editor")}</Button>
        <Button variant="primary" onClick={() => void save(false)} disabled={busy || !text.trim()}>{t("حفظ", "Save")}</Button>
      </>}
    >
      <div className="flex flex-col gap-3">
        <Field label={t("فكرتك", "Your idea")}>
          {(id) => <Textarea id={id} rows={5} autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={t("اكتب فكرة أو ملاحظة... (كل سطر = مهمة عند تفعيل خيار المهمة)", "Type an idea... (each line becomes a task when enabled)")} onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") void save(false); }} />}
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("المادة (اختياري)", "Subject (optional)")}>
            {(id) => (
              <Select id={id} value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
                <option value="">{t("بدون مادة", "No subject")}</option>
                {subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            )}
          </Field>
          <Field label={t("وسوم (مفصولة بفاصلة)", "Tags (comma separated)")}>{(id) => <Input id={id} value={tags} onChange={(e) => setTags(e.target.value)} />}</Field>
        </div>
        <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={task} onChange={(e) => setTask(e.target.checked)} />{t("تحويل النص إلى مهمة", "Turn text into a task")}</label>
        <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={pin} onChange={(e) => setPin(e.target.checked)} />{t("تثبيت الملاحظة", "Pin this note")}</label>
      </div>
    </Modal>
  );
}
