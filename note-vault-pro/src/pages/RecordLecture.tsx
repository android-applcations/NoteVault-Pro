import { useLiveQuery } from "dexie-react-hooks";
import { ArrowUpRight, FileAudio, Mic, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { db } from "@/data/db";
import type { Lecture } from "@/data/types";
import { formatDuration } from "@/domain/text";
import { useI18n } from "@/ui/i18n";
import { LectureForm } from "@/ui/LectureForm";
import { LectureRecorderPanel } from "@/ui/LectureRecorderPanel";
import { Badge, Button, Field, PageHeader, Select } from "@/ui/kit";
import { useSubjects } from "@/ui/shared";

export default function RecordLecture() {
  const { t, fmtDate } = useI18n();
  const [params] = useSearchParams();
  const initialSubject = params.get("subjectId") ?? "";
  const initialLecture = params.get("lectureId") ?? "";

  const subjects = useSubjects();
  const [subjectId, setSubjectId] = useState(initialSubject);
  const [lectureId, setLectureId] = useState(initialLecture);
  const [newLectureOpen, setNewLectureOpen] = useState(false);

  const paramLecture = useLiveQuery(
    () => (initialLecture ? db.lectures.get(initialLecture) : undefined),
    [initialLecture]
  );

  useEffect(() => {
    if (paramLecture && !paramLecture.deletedAt) {
      setSubjectId(paramLecture.subjectId);
      setLectureId(paramLecture.id);
    }
  }, [paramLecture]);

  const lectures =
    useLiveQuery(
      () =>
        subjectId
          ? db.lectures
              .where("subjectId")
              .equals(subjectId)
              .filter((l) => !l.deletedAt && !l.archived)
              .toArray()
          : Promise.resolve([] as Lecture[]),
      [subjectId],
      []
    ) ?? [];

  const allLectures =
    useLiveQuery(() => db.lectures.filter((l) => !l.deletedAt).toArray(), [], []) ?? [];

  const allRecordings =
    useLiveQuery(async () => {
      const rows = await db.recordings.toArray();
      return rows
        .filter((r) => !r.deletedAt && r.status === "ready")
        .sort((a, b) => b.createdAt - a.createdAt);
    }, [], []) ?? [];

  const selectedSubject = subjects.find((s) => s.id === subjectId);
  const selectedLecture = lectures.find((l) => l.id === lectureId);
  const lectureMap = new Map(allLectures.map((l) => [l.id, l]));
  const subjectMap = new Map(subjects.map((s) => [s.id, s]));

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("تسجيل محاضرة صوتياً", "Record Lecture Audio")}
        subtitle={t(
          "ابدأ التسجيل مباشرة أو اربطه بإحدى المواد والمحاضرات مع التفريغ النصي والعلامات الزمنية",
          "Record immediately or link to a subject and lecture with bookmarks and text transcripts"
        )}
        actions={
          selectedLecture ? (
            <Link to={`/lectures/${selectedLecture.id}`}>
              <Button>
                <ArrowUpRight size={15} />
                {t("صفحة المحاضرة", "Open lecture")}
              </Button>
            </Link>
          ) : null
        }
      />

      {/* Optional subject / lecture linking bar */}
      <section className="card-surface p-4 sm:p-5">
        <div className="grid gap-3 md:grid-cols-2">
          <Field label={t("المادة (اختياري)", "Subject (optional)")}>
            {(id) => (
              <Select
                id={id}
                value={subjectId}
                onChange={(e) => {
                  setSubjectId(e.target.value);
                  setLectureId("");
                }}
              >
                <option value="">{t("بدون مادة (تسجيل سريع)", "No subject (quick recording)")}</option>
                {subjects.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <Field label={t("المحاضرة (اختياري)", "Lecture (optional)")}>
                {(id) => (
                  <Select
                    id={id}
                    value={lectureId}
                    disabled={!subjectId}
                    onChange={(e) => setLectureId(e.target.value)}
                  >
                    <option value="">
                      {subjectId
                        ? t("تسجيل عام للمادة", "General subject recording")
                        : t("اختر مادة أولاً أو سجّل مباشرة", "Pick a subject first or record directly")}
                    </option>
                    {lectures
                      .slice()
                      .sort((a, b) => b.date.localeCompare(a.date))
                      .map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.title} ({l.date})
                        </option>
                      ))}
                  </Select>
                )}
              </Field>
            </div>
            {subjectId && (
              <Button
                className="shrink-0"
                onClick={() => setNewLectureOpen(true)}
                aria-label={t("محاضرة جديدة", "New lecture")}
              >
                <Plus size={15} />
                {t("محاضرة", "Lecture")}
              </Button>
            )}
          </div>
        </div>
      </section>

      {/* Main recorder studio */}
      <LectureRecorderPanel
        lectureId={selectedLecture?.id}
        subjectId={subjectId || undefined}
        lectureTitle={selectedLecture?.title || selectedSubject?.name || t("محاضرة", "Lecture")}
      />

      {/* Quick overview of all saved audio recordings */}
      {allRecordings.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-base font-extrabold">
              <Mic size={16} className="text-accent" />
              {t("كل التسجيلات المحفوظة", "All Saved Recordings")}
              <Badge>{allRecordings.length}</Badge>
            </h2>
            <Link to="/library" className="text-xs font-bold text-accent hover:underline">
              {t("عرض في المكتبة", "View in library")}
            </Link>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {allRecordings.slice(0, 12).map((rec) => {
              const subj = rec.subjectId ? subjectMap.get(rec.subjectId) : undefined;
              const lec = rec.lectureId ? lectureMap.get(rec.lectureId) : undefined;
              const target = rec.attachmentId
                ? `/files/${rec.attachmentId}`
                : lec
                  ? `/lectures/${lec.id}`
                  : "/library";
              return (
                <Link
                  key={rec.id}
                  to={target}
                  className="card-surface flex min-w-0 items-center justify-between gap-3 p-3.5 transition hover:border-accent"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
                      <FileAudio size={18} />
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-extrabold" dir="auto">
                        {rec.title}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                        <span className="font-mono tabular-nums">{formatDuration(rec.durationMs)}</span>
                        {subj && (
                          <>
                            <span>·</span>
                            <span className="truncate">{subj.name}</span>
                          </>
                        )}
                        {lec && (
                          <>
                            <span>·</span>
                            <span className="truncate">{lec.title}</span>
                          </>
                        )}
                        <span>·</span>
                        <span>{fmtDate(rec.createdAt)}</span>
                      </div>
                    </div>
                  </div>
                  {rec.transcriptionStatus === "done" && (
                    <Badge color="#0b8579">{t("مفرّغ", "Transcribed")}</Badge>
                  )}
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {subjectId && (
        <LectureForm
          open={newLectureOpen}
          onClose={() => setNewLectureOpen(false)}
          subjectId={subjectId}
          onSaved={(l) => setLectureId(l.id)}
        />
      )}
    </div>
  );
}
