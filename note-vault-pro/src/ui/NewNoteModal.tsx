import { FilePlus2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { TEMPLATES } from "@/domain/templates";
import { createNote } from "@/services/notes";
import { useApp } from "./app-context";
import { useI18n } from "./i18n";
import { Modal } from "./kit";

export function NewNoteModal({ open, onClose, subjectId, lectureId }: { open: boolean; onClose: () => void; subjectId?: string; lectureId?: string }) {
  const { t, lang } = useI18n();
  const nav = useNavigate();
  const { toast } = useApp();
  const create = async (templateId?: string) => {
    try {
      const n = await createNote({ subjectId, lectureId, templateId, lang });
      onClose();
      nav(`/notes/${n.id}`);
    } catch {
      toast(t("تعذر إنشاء الملاحظة", "Could not create the note"), "err");
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={t("ملاحظة جديدة", "New note")} wide>
      <div className="grid gap-3 sm:grid-cols-2">
        <button onClick={() => void create()} className="flex items-center gap-3 rounded-2xl border-2 border-dashed border-accent/50 p-4 text-start hover:bg-accent/10">
          <FilePlus2 className="text-accent" /><span><b className="block text-sm">{t("ملاحظة فارغة", "Blank note")}</b><span className="text-xs text-muted">{t("ابدأ من الصفر", "Start from scratch")}</span></span>
        </button>
        {TEMPLATES.map((tpl) => (
          <button key={tpl.id} onClick={() => void create(tpl.id)} className="rounded-2xl border border-line p-4 text-start transition hover:border-accent hover:bg-surface2">
            <b className="block text-sm">{tpl.name[lang]}</b><span className="text-xs text-muted">{tpl.description[lang]}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
