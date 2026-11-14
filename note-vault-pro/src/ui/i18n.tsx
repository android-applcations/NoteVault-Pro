// Presentation layer – language, theme and accessibility preferences.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { db } from "@/data/db";

export type Lang = "ar" | "en";
export interface Prefs {
  lang: Lang;
  theme: "light" | "dark" | "system";
  reduceMotion: boolean;
  textSize: "sm" | "md" | "lg" | "xl";
}
const DEFAULTS: Prefs = { lang: "ar", theme: "system", reduceMotion: false, textSize: "md" };
const SIZES = { sm: "14px", md: "16px", lg: "18px", xl: "20px" } as const;

function readLocal(): Prefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("nv-prefs") || "{}") };
  } catch {
    return DEFAULTS;
  }
}

export function applyPrefs(p: Prefs) {
  const d = document.documentElement;
  d.lang = p.lang;
  d.dir = p.lang === "ar" ? "rtl" : "ltr";
  const dark = p.theme === "dark" || (p.theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  d.classList.toggle("dark", dark);
  d.classList.toggle("reduce-motion", p.reduceMotion);
  d.style.fontSize = SIZES[p.textSize];
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0d0e1d" : "#f6f4ef");
}

interface Ctx {
  prefs: Prefs;
  lang: Lang;
  dir: "rtl" | "ltr";
  setPrefs: (patch: Partial<Prefs>) => void;
  /** Inline bilingual helper: t(arabic, english) */
  t: (ar: string, en: string) => string;
  fmtDate: (ms: number | string, opts?: Intl.DateTimeFormatOptions) => string;
  fmtNum: (n: number) => string;
}
const I18nCtx = createContext<Ctx | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefsState] = useState<Prefs>(readLocal);

  useEffect(() => {
    applyPrefs(prefs);
    if (prefs.theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => applyPrefs(prefs);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [prefs]);

  // Load persisted prefs from IndexedDB (source of truth; localStorage only avoids a flash on boot)
  useEffect(() => {
    db.appSettings.get("prefs").then((r) => {
      if (r?.value) {
        const merged = { ...DEFAULTS, ...(r.value as Partial<Prefs>) };
        localStorage.setItem("nv-prefs", JSON.stringify(merged));
        setPrefsState(merged);
      }
    }).catch(() => undefined);
  }, []);

  const setPrefs = useCallback((patch: Partial<Prefs>) => {
    setPrefsState((cur) => {
      const next = { ...cur, ...patch };
      try {
        localStorage.setItem("nv-prefs", JSON.stringify(next));
      } catch {
        /* storage may be unavailable */
      }
      db.appSettings.put({ key: "prefs", value: next }).catch(() => undefined);
      return next;
    });
  }, []);

  const value = useMemo<Ctx>(() => {
    const lang = prefs.lang;
    const locale = lang === "ar" ? "ar-u-nu-latn" : "en-US";
    return {
      prefs, lang, dir: lang === "ar" ? "rtl" : "ltr", setPrefs,
      t: (ar, en) => (lang === "ar" ? ar : en),
      fmtDate: (ms, opts) => {
        const d = typeof ms === "string" ? new Date(ms + (ms.length === 10 ? "T00:00:00" : "")) : new Date(ms);
        return new Intl.DateTimeFormat(locale, opts ?? { year: "numeric", month: "short", day: "numeric" }).format(d);
      },
      fmtNum: (n) => new Intl.NumberFormat(locale).format(n),
    };
  }, [prefs, setPrefs]);

  return <I18nCtx.Provider value={value}>{children}</I18nCtx.Provider>;
}

export function useI18n(): Ctx {
  const c = useContext(I18nCtx);
  if (!c) throw new Error("I18nProvider missing");
  return c;
}
