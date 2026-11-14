// Presentation layer – application shell: sidebar, mobile navigation, top bar, global shortcuts.
import { motion } from "motion/react";
import {
  BookOpen, CalendarDays, ChevronsLeft, ChevronsRight, FolderOpen, GraduationCap, Home, Languages, Layers, MoreHorizontal, Moon,
  NotebookText, Plus, Search, Settings, Sun, Trash2, Zap, ClipboardCheck, Bookmark, type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { registerServiceWorker } from "@/pwa";
import { createNote } from "@/services/notes";
import { cn } from "@/utils/cn";
import { useApp } from "./app-context";
import { CardEditor } from "./CardEditor";
import { useI18n } from "./i18n";
import { IconButton } from "./kit";
import { QuickCapture } from "./QuickCapture";

interface NavItem { to: string; icon: LucideIcon; ar: string; en: string; end?: boolean }
const MAIN: NavItem[] = [
  { to: "/", icon: Home, ar: "الرئيسية", en: "Home", end: true },
  { to: "/subjects", icon: BookOpen, ar: "المواد", en: "Subjects" },
  { to: "/notes", icon: NotebookText, ar: "الملاحظات", en: "Notes" },
  { to: "/library", icon: FolderOpen, ar: "المكتبة", en: "Library" },
  { to: "/flashcards", icon: Layers, ar: "البطاقات", en: "Flashcards" },
  { to: "/quizzes", icon: ClipboardCheck, ar: "الاختبارات", en: "Quizzes" },
  { to: "/references", icon: Bookmark, ar: "المراجع", en: "References" },
  { to: "/calendar", icon: CalendarDays, ar: "التقويم", en: "Calendar" },
  { to: "/semesters", icon: GraduationCap, ar: "الفصول", en: "Semesters" },
];
const SECONDARY: NavItem[] = [
  { to: "/trash", icon: Trash2, ar: "سلة المحذوفات", en: "Trash" },
  { to: "/settings", icon: Settings, ar: "الإعدادات", en: "Settings" },
];

export function Logo({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden>
      <defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#2b2a6f" /><stop offset="1" stopColor="#0f9b8e" /></linearGradient></defs>
      <rect width="512" height="512" rx="112" fill="url(#lg)" />
      <rect x="118" y="118" width="276" height="276" rx="36" fill="none" stroke="#fff" strokeWidth="28" />
      <circle cx="256" cy="256" r="62" fill="none" stroke="#fff" strokeWidth="22" />
      <circle cx="256" cy="256" r="18" fill="#fff" />
    </svg>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const { t, setPrefs, lang } = useI18n();
  const { toast, setQuickOpen, cardPrefill, closeCard } = useApp();
  const nav = useNavigate();
  const loc = useLocation();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("nv-sidebar") === "1");
  const searchRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const isEditor = /^\/notes\/[^/]+$/.test(loc.pathname) || /^\/files\//.test(loc.pathname);

  useEffect(() => {
    registerServiceWorker((apply) => toast(t("يتوفر إصدار جديد من التطبيق", "A new version is available"), "info", { label: t("تحديث", "Update"), run: apply }));
    // storage pressure warning (never deletes anything)
    navigator.storage?.estimate?.().then((e) => {
      if (e?.quota && e.usage && e.usage / e.quota > 0.85) toast(t("مساحة التخزين تقترب من حدها. صدّر نسخة احتياطية واحذف ما لا تحتاجه.", "Storage is almost full. Export a backup and remove what you don't need."), "err");
    }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); searchRef.current?.focus(); }
      if (e.altKey && e.key.toLowerCase() === "n") { e.preventDefault(); setQuickOpen(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setQuickOpen]);

  const toggleSidebar = () => setCollapsed((c) => { localStorage.setItem("nv-sidebar", c ? "0" : "1"); return !c; });
  const dark = document.documentElement.classList.contains("dark");
  const newNote = async () => { const n = await createNote({}); nav(`/notes/${n.id}`); };
  const submitSearch = (e: React.FormEvent) => { e.preventDefault(); if (q.trim()) nav(`/search?q=${encodeURIComponent(q.trim())}`); };

  const linkCls = ({ isActive }: { isActive: boolean }) =>
    cn("flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-bold transition", isActive ? "bg-primary text-primary-fg shadow" : "text-muted hover:bg-surface2 hover:text-fg", collapsed && "justify-center px-0");

  return (
    <div className="min-h-dvh">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:start-3 focus:top-3 focus:z-[200] focus:rounded-lg focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-fg">{t("تخطي إلى المحتوى", "Skip to content")}</a>
      <aside className={cn("fixed inset-y-0 start-0 z-40 hidden flex-col border-e border-line bg-surface p-3 transition-[width] duration-200 lg:flex", collapsed ? "w-[76px]" : "w-64")} aria-label={t("التنقل الرئيسي", "Main navigation")}>
        <div className={cn("mb-4 flex items-center gap-3 px-1", collapsed && "justify-center")}>
          <Logo />
          {!collapsed && <div className="leading-tight"><div className="text-lg font-black tracking-tight">NoteVault</div><div className="text-[11px] font-bold text-accent">PRO</div></div>}
        </div>
        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto">
          {MAIN.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={linkCls} title={collapsed ? t(n.ar, n.en) : undefined} aria-label={t(n.ar, n.en)}>
              <n.icon size={19} />{!collapsed && t(n.ar, n.en)}
            </NavLink>
          ))}
          <div className="my-2 border-t border-line" />
          {SECONDARY.map((n) => (
            <NavLink key={n.to} to={n.to} className={linkCls} title={collapsed ? t(n.ar, n.en) : undefined} aria-label={t(n.ar, n.en)}>
              <n.icon size={19} />{!collapsed && t(n.ar, n.en)}
            </NavLink>
          ))}
        </nav>
        <IconButton label={collapsed ? t("توسيع القائمة", "Expand sidebar") : t("طي القائمة", "Collapse sidebar")} onClick={toggleSidebar} className="self-end rtl:rotate-180">
          {collapsed ? <ChevronsRight size={18} /> : <ChevronsLeft size={18} />}
        </IconButton>
      </aside>

      <div className={cn("transition-[padding] duration-200", collapsed ? "lg:ps-[76px]" : "lg:ps-64")}>
        <header className="safe-top sticky top-0 z-30 flex items-center gap-2 border-b border-line bg-bg/85 px-3 py-2.5 backdrop-blur-lg sm:px-6">
          <div className="flex items-center gap-2 lg:hidden"><Logo size={30} /></div>
          <form onSubmit={submitSearch} className="relative min-w-0 flex-1 sm:max-w-xl" role="search">
            <Search size={16} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted" />
            <input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("بحث شامل", "Universal search")}
              placeholder={t("ابحث في كل شيء… (Ctrl+K)", "Search everything… (Ctrl+K)")} className="h-10 w-full rounded-xl border border-line bg-surface ps-9 pe-3 text-sm placeholder:text-muted/70 focus:border-accent" />
          </form>
          <div className="ms-auto flex items-center gap-1">
            <IconButton label={t("التقاط سريع (Alt+N)", "Quick capture (Alt+N)")} onClick={() => setQuickOpen(true)} className="bg-accent/15 text-accent hover:bg-accent/25"><Zap size={18} /></IconButton>
            <IconButton label={t("تبديل اللغة", "Switch language")} onClick={() => setPrefs({ lang: lang === "ar" ? "en" : "ar" })}><Languages size={18} /></IconButton>
            <IconButton label={t("تبديل المظهر", "Toggle theme")} onClick={() => setPrefs({ theme: dark ? "light" : "dark" })}>{dark ? <Sun size={18} /> : <Moon size={18} />}</IconButton>
          </div>
        </header>
        <main id="main" tabIndex={-1} className={cn("mx-auto w-full px-4 pb-28 pt-5 sm:px-6 lg:pb-10", isEditor ? "max-w-6xl" : "max-w-6xl")}>
          {/* Keyed fade-in only: an exit animation would keep a second live copy of the outgoing page mounted */}
          <motion.div key={loc.pathname} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }}>
            {children}
          </motion.div>
        </main>
      </div>

      {/* Mobile bottom navigation */}
      <nav className="safe-bottom fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 backdrop-blur-lg lg:hidden" aria-label={t("التنقل", "Navigation")}>
        <div className="mx-auto grid max-w-lg grid-cols-5 items-end px-2 pt-1.5 pb-1.5">
          {[MAIN[0], MAIN[1]].map((n) => <MobileLink key={n.to} n={n} />)}
          <div className="relative flex justify-center">
            <motion.button whileTap={{ scale: 0.9 }} onClick={() => void newNote()} aria-label={t("ملاحظة جديدة", "New note")}
              className="-mt-7 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-accent text-white shadow-xl shadow-primary/30"><Plus size={26} /></motion.button>
          </div>
          <MobileLink n={MAIN[2]} />
          <MobileLink n={{ to: "/more", icon: MoreHorizontal, ar: "المزيد", en: "More" }} extra={[MAIN[3].to]} />
        </div>
      </nav>

      <button onClick={() => void newNote()} aria-label={t("ملاحظة جديدة", "New note")} className="fixed bottom-6 end-6 z-30 hidden h-14 items-center gap-2 rounded-2xl bg-gradient-to-br from-primary to-accent px-5 font-bold text-white shadow-xl shadow-primary/30 transition hover:scale-105 active:scale-95 lg:flex">
        <Plus size={20} />{t("ملاحظة جديدة", "New note")}
      </button>

      <QuickCapture />
      <CardEditor open={!!cardPrefill} onClose={closeCard} prefill={cardPrefill ?? undefined} />
    </div>
  );
}

function MobileLink({ n, extra }: { n: NavItem; extra?: string[] }) {
  const { t } = useI18n();
  const loc = useLocation();
  const active = n.end ? loc.pathname === n.to : loc.pathname.startsWith(n.to) || (extra ?? []).some((e) => loc.pathname.startsWith(e)) && n.to === "/more";
  return (
    <NavLink to={n.to} end={n.end} className={cn("flex flex-col items-center gap-0.5 rounded-xl py-1.5 text-[11px] font-bold", active ? "text-primary" : "text-muted")}>
      <n.icon size={21} />
      {t(n.ar, n.en)}
    </NavLink>
  );
}
