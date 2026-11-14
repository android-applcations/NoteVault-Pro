import { Bookmark, CalendarDays, ClipboardCheck, FolderOpen, GraduationCap, Layers, Mic, Search, Settings, Trash2, Zap } from "lucide-react";
import { Link } from "react-router-dom";
import { useApp } from "@/ui/app-context";
import { useI18n } from "@/ui/i18n";
import { PageHeader } from "@/ui/kit";

export default function More() {
  const { t } = useI18n();
  const { setQuickOpen } = useApp();
  const items = [
    { to: "/record", icon: Mic, l: t("تسجيل محاضرة", "Record lecture") },
    { to: "/library", icon: FolderOpen, l: t("مكتبة الملفات", "File vault") }, { to: "/flashcards", icon: Layers, l: t("البطاقات", "Flashcards") },
    { to: "/quizzes", icon: ClipboardCheck, l: t("الاختبارات", "Quizzes") }, { to: "/references", icon: Bookmark, l: t("المراجع", "References") },
    { to: "/calendar", icon: CalendarDays, l: t("التقويم", "Calendar") }, { to: "/semesters", icon: GraduationCap, l: t("الفصول", "Semesters") },
    { to: "/search", icon: Search, l: t("بحث شامل", "Search") }, { to: "/trash", icon: Trash2, l: t("سلة المحذوفات", "Trash") }, { to: "/settings", icon: Settings, l: t("الإعدادات", "Settings") },
  ];
  return (
    <div>
      <PageHeader title={t("المزيد", "More")} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
        {items.map((i) => <Link key={i.to} to={i.to} className="card-surface flex flex-col items-center gap-2 p-5 text-center text-sm font-bold transition active:scale-95"><i.icon className="text-accent" />{i.l}</Link>)}
        <button onClick={() => setQuickOpen(true)} className="card-surface flex flex-col items-center gap-2 p-5 text-center text-sm font-bold transition active:scale-95"><Zap className="text-accent" />{t("التقاط سريع", "Quick capture")}</button>
      </div>
    </div>
  );
}
