import { MotionConfig } from "motion/react";
import { lazy, Suspense, useEffect, useState } from "react";
import { HashRouter, Route, Routes } from "react-router-dom";
import { db } from "@/data/db";
import { initSearch } from "@/services/search";
import { AppProvider } from "@/ui/app-context";
import { I18nProvider, useI18n } from "@/ui/i18n";
import { Skeleton } from "@/ui/kit";
import { Shell } from "@/ui/Shell";

const Dashboard = lazy(() => import("@/pages/Dashboard"));
const Subjects = lazy(() => import("@/pages/Subjects"));
const SubjectPage = lazy(() => import("@/pages/SubjectPage"));
const Semesters = lazy(() => import("@/pages/Semesters"));
const LecturePage = lazy(() => import("@/pages/LecturePage"));
const Notes = lazy(() => import("@/pages/Notes"));
const NoteEditor = lazy(() => import("@/pages/NoteEditor"));
const Library = lazy(() => import("@/pages/Library"));
const FileViewer = lazy(() => import("@/pages/FileViewer"));
const SearchPage = lazy(() => import("@/pages/SearchPage"));
const Flashcards = lazy(() => import("@/pages/Flashcards"));
const Review = lazy(() => import("@/pages/Review"));
const Quizzes = lazy(() => import("@/pages/Quizzes"));
const QuizBuilder = lazy(() => import("@/pages/QuizBuilder"));
const QuizTake = lazy(() => import("@/pages/QuizTake"));
const References = lazy(() => import("@/pages/References"));
const CalendarPage = lazy(() => import("@/pages/CalendarPage"));
const Trash = lazy(() => import("@/pages/Trash"));
const Settings = lazy(() => import("@/pages/Settings"));
const More = lazy(() => import("@/pages/More"));

function Loading() {
  return (
    <div className="space-y-4 p-2" aria-busy="true">
      <Skeleton className="h-10 w-1/3" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}

function Boot() {
  const { t, prefs } = useI18n();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  useEffect(() => {
    db.open()
      .then(async () => {
        try {
          await navigator.storage?.persist?.();
        } catch {
          /* optional */
        }
        void initSearch();
        setState("ready");
      })
      .catch(() => setState("error"));
  }, []);
  if (state === "error")
    return (
      <div className="grid min-h-dvh place-items-center p-6 text-center">
        <div className="card-surface max-w-md p-8">
          <h1 className="mb-2 text-xl font-extrabold">{t("تعذر فتح قاعدة البيانات المحلية", "Could not open the local database")}</h1>
          <p className="text-sm text-muted">{t("قد يكون التخزين معطلاً (الوضع الخاص) أو أن بياناتك أحدث من هذه النسخة من التطبيق. حدّث الصفحة أو حدّث التطبيق.", "Storage may be disabled (private mode) or your data is newer than this app version. Reload or update the app.")}</p>
          <button className="mt-4 rounded-xl bg-primary px-4 py-2 font-bold text-primary-fg" onClick={() => location.reload()}>{t("إعادة المحاولة", "Retry")}</button>
        </div>
      </div>
    );
  if (state === "loading") return <div className="p-8"><Loading /></div>;
  return (
    <MotionConfig reducedMotion={prefs.reduceMotion ? "always" : "user"}>
      <AppProvider>
        <HashRouter>
          <Shell>
            <Suspense fallback={<Loading />}>
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/subjects" element={<Subjects />} />
                <Route path="/subjects/:id" element={<SubjectPage />} />
                <Route path="/semesters" element={<Semesters />} />
                <Route path="/lectures/:id" element={<LecturePage />} />
                <Route path="/notes" element={<Notes />} />
                <Route path="/notes/:id" element={<NoteEditor />} />
                <Route path="/library" element={<Library />} />
                <Route path="/files/:id" element={<FileViewer />} />
                <Route path="/search" element={<SearchPage />} />
                <Route path="/flashcards" element={<Flashcards />} />
                <Route path="/flashcards/review" element={<Review />} />
                <Route path="/quizzes" element={<Quizzes />} />
                <Route path="/quizzes/:id/edit" element={<QuizBuilder />} />
                <Route path="/quizzes/:id/take" element={<QuizTake />} />
                <Route path="/references" element={<References />} />
                <Route path="/calendar" element={<CalendarPage />} />
                <Route path="/trash" element={<Trash />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/more" element={<More />} />
                <Route path="*" element={<Dashboard />} />
              </Routes>
            </Suspense>
          </Shell>
        </HashRouter>
      </AppProvider>
    </MotionConfig>
  );
}

export default function App() {
  return (
    <I18nProvider>
      <Boot />
    </I18nProvider>
  );
}
