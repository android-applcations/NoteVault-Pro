import { useLiveQuery } from "dexie-react-hooks";
import { RotateCcw, Trash2 } from "lucide-react";
import { db } from "@/data/db";
import { emptyTrash, purgeTrash, restoreTrash } from "@/services/core";
import { useApp } from "@/ui/app-context";
import { useI18n } from "@/ui/i18n";
import { Badge, Button, EmptyState, PageHeader } from "@/ui/kit";

export default function Trash() {
  const { t, fmtDate } = useI18n();
  const { toast, confirm } = useApp();
  const items = useLiveQuery(() => db.trashItems.orderBy("deletedAt").reverse().toArray(), []);
  const kinds = { subject: t("مادة", "Subject"), lecture: t("محاضرة", "Lecture"), note: t("ملاحظة", "Note"), attachment: t("ملف", "File") };
  const restore = async (id: string) => {
    try { await restoreTrash(id); toast(t("تمت الاستعادة", "Restored")); }
    catch (e) { toast(e instanceof Error && e.message === "PARENT_TRASHED" ? t("استعد المادة الأم أولاً", "Restore the parent subject first") : t("تعذرت الاستعادة", "Could not restore"), "err"); }
  };
  return (
    <div>
      <PageHeader title={t("سلة المحذوفات", "Trash")} subtitle={t("العناصر هنا يمكن استعادتها مع كل ما يرتبط بها. لا يتم حذف أي شيء نهائياً تلقائياً.", "Items here can be restored with everything attached to them. Nothing is deleted permanently by itself.")}
        actions={<Button variant="danger" disabled={!items?.length} onClick={async () => { if (await confirm({ title: t("إفراغ السلة نهائياً؟", "Empty the trash permanently?"), message: t("لا يمكن التراجع عن هذا الإجراء.", "This cannot be undone."), danger: true, confirmLabel: t("إفراغ", "Empty") })) { await emptyTrash(); toast(t("تم إفراغ السلة", "Trash emptied")); } }}><Trash2 size={16} />{t("إفراغ السلة", "Empty trash")}</Button>} />
      {items && items.length === 0 ? <EmptyState icon={<Trash2 />} title={t("السلة فارغة", "Trash is empty")} /> : (
        <ul className="space-y-2">
          {(items ?? []).map((i) => (
            <li key={i.id} className="card-surface flex flex-wrap items-center gap-3 p-3">
              <Badge>{kinds[i.kind]}</Badge><span className="min-w-0 flex-1 truncate font-bold" dir="auto">{i.label}</span><span className="text-xs text-muted">{fmtDate(i.deletedAt, { dateStyle: "medium", timeStyle: "short" })}</span>
              <Button onClick={() => void restore(i.id)}><RotateCcw size={15} />{t("استعادة", "Restore")}</Button>
              <Button variant="ghost" aria-label={t("حذف نهائي", "Delete permanently")} onClick={async () => { if (await confirm({ title: t("حذف نهائي؟", "Delete permanently?"), message: t("سيُحذف العنصر وكل ما يرتبط به.", "The item and everything attached to it will be removed."), danger: true })) await purgeTrash(i.id); }}><Trash2 size={15} className="text-danger" /></Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
