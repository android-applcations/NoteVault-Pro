import { useLiveQuery } from "dexie-react-hooks";
import { motion } from "motion/react";
import { BookOpen, ClipboardCheck, Clock, FileText, FolderOpen, Layers, NotebookText, Play, Plus, Sparkles, Zap, Activity as ActIcon } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { db } from "@/data/db";
import { safeCssColor, safeDataImageUrl } from "@/domain/sanitize";
import { formatBytes } from "@/domain/text";
import { getDashboard } from "@/services/stats";
import { getStorageReport } from "@/services/storage";
import { createNote } from "@/services/notes";
import { useApp } from "@/ui/app-context";
import { useI18n } from "@/ui/i18n";
import { Badge, Button, EmptyState, ProgressBar, Skeleton } from "@/ui/kit";
import { AttachmentThumb, relTime } from "@/ui/shared";

const ACT_LABEL: Record<string, [string, string]> = {
  create: ["إنشاء", "Created"], upload: ["رفع ملف", "Uploaded"], delete: ["حذف", "Deleted"], restore: ["استعادة", "Restored"], quiz: ["اختبار", "Quiz"],
  backup: ["نسخ احتياطي", "Backup"], purge: ["حذف نهائي", "Purged"],
};

export default function Dashboard() {
  const { t, lang, fmtNum, fmtDate } = useI18n();
  const { setQuickOpen } = useApp();
  const nav = useNavigate();
  const d = useLiveQuery(getDashboard, []);
  const subjects = useLiveQuery(() => db.subjects.filter((s) => !s.deletedAt && !s.archived).toArray(), []) ?? [];
  const storage = useLiveQuery(getStorageReport, []);
  const hour = new Date().getHours();
  const greet = hour < 12 ? t("صباح الخير", "Good morning") : hour < 18 ? t("مساء الخير", "Good afternoon") : t("مساء النور", "Good evening");

  if (!d) return <div className="grid gap-4"><Skeleton className="h-40" /><Skeleton className="h-28" /></div>;
  const stats = [
    { icon: BookOpen, label: t("المواد", "Subjects"), v: d.subjects, to: "/subjects" },
    { icon: Clock, label: t("المحاضرات", "Lectures"), v: d.lectures, to: "/subjects" },
    { icon: NotebookText, label: t("الملاحظات", "Notes"), v: d.notes, to: "/notes" },
    { icon: FolderOpen, label: t("الملفات", "Files"), v: d.files, to: "/library" },
    { icon: Layers, label: t("البطاقات", "Cards"), v: d.cards, to: "/flashcards" },
    { icon: Sparkles, label: t("مستحقة اليوم", "Due today"), v: d.due, to: "/flashcards/review", accent: true },
    { icon: ClipboardCheck, label: t("جلسات المراجعة", "Review sessions"), v: d.sessions, to: "/flashcards" },
  ];
  const actLabel = (k: string) => (ACT_LABEL[k] ? t(ACT_LABEL[k][0], ACT_LABEL[k][1]) : k);
  const empty = d.subjects === 0 && d.notes === 0 && d.files === 0;

  return (
    <div className="space-y-6">
      <motion.section initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-[#2b2a6f] via-[#3b3a97] to-[#0b8579] p-6 text-white shadow-xl sm:p-8">
        <div className="pointer-events-none absolute -top-16 -end-10 h-56 w-56 rounded-full bg-white/10 blur-2xl" />
        <p className="text-sm font-semibold text-white/80">{greet} 👋</p>
        <h1 className="mt-1 text-2xl font-black sm:text-4xl">{t("كل محاضراتك، ملاحظاتك، ملفاتك، وأفكارك في مكان واحد.", "All your lectures, notes, files and ideas in one place.")}</h1>
        <p className="mt-2 text-sm text-white/80">
          {d.due > 0 ? t(`لديك ${fmtNum(d.due)} بطاقة مستحقة للمراجعة اليوم.`, `You have ${fmtNum(d.due)} cards due for review today.`) : t("لا توجد بطاقات مستحقة الآن — أحسنت!", "No cards due right now — well done!")}
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button className="bg-white text-[#2b2a6f] hover:bg-white/90" onClick={() => nav("/flashcards/review")} disabled={d.due === 0}><Play size={16} />{t("ابدأ المراجعة", "Start review")}</Button>
          <Button className="bg-white/15 text-white hover:bg-white/25 border-0" onClick={async () => nav(`/notes/${(await createNote({})).id}`)}><Plus size={16} />{t("ملاحظة جديدة", "New note")}</Button>
          <Button className="bg-white/15 text-white hover:bg-white/25 border-0" onClick={() => setQuickOpen(true)}><Zap size={16} />{t("التقاط سريع", "Quick capture")}</Button>
        </div>
      </motion.section>

      {empty && (
        <EmptyState icon={<Sparkles />} title={t("ابدأ رحلتك الدراسية", "Start your study journey")} hint={t("أنشئ مادتك الأولى، ثم أضف محاضرة وملاحظة. كل بياناتك تبقى على جهازك.", "Create your first subject, then add a lecture and a note. All data stays on your device.")}
          action={<Link to="/subjects"><Button variant="primary"><Plus size={16} />{t("إنشاء مادة", "Create a subject")}</Button></Link>} />
      )}

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7" aria-label={t("إحصائيات", "Statistics")}>
        {stats.map((s, i) => (
          <motion.div key={s.label} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}>
            <Link to={s.to} className="card-surface block p-4 transition hover:-translate-y-0.5 hover:shadow-lg">
              <s.icon size={18} className={s.accent ? "text-accent" : "text-muted"} />
              <div className="mt-2 text-3xl font-black tabular-nums">{fmtNum(s.v)}</div>
              <div className="text-xs font-bold text-muted">{s.label}</div>
            </Link>
          </motion.div>
        ))}
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        <div className="card-surface p-5">
          <div className="mb-2 flex justify-between text-sm font-bold"><span>{t("تغطية المحاضرات بالملاحظات", "Lectures covered by notes")}</span><span>{d.coverage}%</span></div>
          <ProgressBar value={d.coverage} />
        </div>
        <div className="card-surface p-5">
          <div className="mb-2 flex justify-between text-sm font-bold"><span>{t("تقدم المراجعة", "Review progress")}</span><span>{d.reviewProgress}%</span></div>
          <ProgressBar value={d.reviewProgress} color="var(--primary)" />
        </div>
        <div className="card-surface p-5">
          <div className="mb-2 flex justify-between text-sm font-bold"><span>{t("التخزين المستخدم", "Storage used")}</span><span dir="ltr">{formatBytes(storage?.total ?? d.storageBytes)}</span></div>
          <ProgressBar value={storage?.quota && storage.usage ? (storage.usage / storage.quota) * 100 : 3} color="var(--warn)" />
          {storage?.quota && <p className="mt-1 text-xs text-muted" dir="ltr">{formatBytes(storage.usage ?? 0)} / {formatBytes(storage.quota)}</p>}
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between"><h2 className="text-lg font-extrabold">{t("المواد الدراسية", "Subjects")}</h2><Link to="/subjects" className="text-sm font-bold text-accent">{t("عرض الكل", "View all")}</Link></div>
        <div className="flex gap-3 overflow-x-auto pb-2">
          {subjects.slice(0, 10).map((s) => {
            const coverUrl = safeDataImageUrl(s.cover);
            const color = safeCssColor(s.color);
            return (
              <Link key={s.id} to={`/subjects/${s.id}`} className="card-surface w-44 shrink-0 overflow-hidden transition hover:-translate-y-0.5">
                <div className="h-16" style={{ background: coverUrl ? `url(${coverUrl}) center/cover` : `linear-gradient(135deg, ${color}, ${color}88)` }} />
                <div className="p-3"><div className="truncate text-sm font-extrabold">{s.name}</div><div className="truncate text-xs text-muted" dir="auto">{s.code || "—"}</div></div>
              </Link>
            );
          })}
          {subjects.length === 0 && <p className="text-sm text-muted">{t("لا توجد مواد بعد.", "No subjects yet.")}</p>}
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card-surface p-5">
          <h2 className="mb-3 flex items-center gap-2 text-lg font-extrabold"><NotebookText size={18} className="text-accent" />{t("آخر الملاحظات", "Recent notes")}</h2>
          <ul className="space-y-1">
            {d.recentNotes.map((n) => (
              <li key={n.id}><Link to={`/notes/${n.id}`} className="flex items-center justify-between gap-3 rounded-xl px-3 py-2 hover:bg-surface2">
                <span className="min-w-0"><span className="block truncate text-sm font-bold" dir="auto">{n.title || t("بدون عنوان", "Untitled")}</span><span className="block truncate text-xs text-muted" dir="auto">{n.text.slice(0, 70)}</span></span>
                <span className="shrink-0 text-xs text-muted">{relTime(n.updatedAt, lang)}</span>
              </Link></li>
            ))}
            {d.recentNotes.length === 0 && <li className="text-sm text-muted">{t("لا توجد ملاحظات.", "No notes yet.")}</li>}
          </ul>
        </section>
        <section className="card-surface p-5">
          <h2 className="mb-3 flex items-center gap-2 text-lg font-extrabold"><FileText size={18} className="text-accent" />{t("الملفات الحديثة", "Recent files")}</h2>
          <div className="grid grid-cols-3 gap-3">
            {d.recentFiles.map((f) => (
              <Link key={f.id} to={`/files/${f.id}`} className="group">
                <AttachmentThumb att={f} className="aspect-[3/4] rounded-xl border border-line" />
                <div className="mt-1 truncate text-xs font-bold group-hover:text-accent" dir="auto">{f.name}</div>
              </Link>
            ))}
            {d.recentFiles.length === 0 && <p className="col-span-3 text-sm text-muted">{t("لا توجد ملفات.", "No files yet.")}</p>}
          </div>
        </section>
        <section className="card-surface p-5">
          <h2 className="mb-3 text-lg font-extrabold">{t("المواد الأكثر نشاطاً", "Most active subjects")}</h2>
          <ul className="space-y-2">
            {d.topSubjects.map(({ subject, score }) => (
              <li key={subject.id} className="flex items-center gap-3"><span className="h-3 w-3 rounded-full" style={{ background: safeCssColor(subject.color) }} />
                <Link to={`/subjects/${subject.id}`} className="flex-1 truncate text-sm font-bold hover:text-accent">{subject.name}</Link><Badge>{fmtNum(score)}</Badge></li>
            ))}
            {d.topSubjects.length === 0 && <li className="text-sm text-muted">—</li>}
          </ul>
        </section>
        <section className="card-surface p-5">
          <h2 className="mb-3 flex items-center gap-2 text-lg font-extrabold"><ActIcon size={18} className="text-accent" />{t("آخر الأنشطة", "Recent activity")}</h2>
          <ul className="space-y-2 text-sm">
            {d.recentActivities.map((a) => (
              <li key={a.id} className="flex items-center gap-2"><Badge>{actLabel(a.kind)}</Badge><span className="min-w-0 flex-1 truncate" dir="auto">{a.label}</span><span className="shrink-0 text-xs text-muted">{fmtDate(a.createdAt, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span></li>
            ))}
            {d.recentActivities.length === 0 && <li className="text-muted">—</li>}
          </ul>
        </section>
      </div>
    </div>
  );
}
