// Lecture audio recording studio + crash recovery + recordings list + player + offline transcription.
import { useLiveQuery } from "dexie-react-hooks";
import {
  AlertTriangle, Check, Edit3, FileAudio, Mic, NotebookPen, Pause, Play,
  RotateCcw, Square, Trash2, Volume2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { db } from "@/data/db";
import type { Attachment, LectureRecording, Note } from "@/data/types";
import { formatBytes, formatDuration } from "@/domain/text";
import { createNote } from "@/services/notes";
import { lectureRecorder } from "@/services/recorder";
import {
  addRecordingMarker,
  deleteRecording,
  discardRecordingSession,
  getRecordingBlob,
  insertTimestampIntoNote,
  listIncompleteRecordings,
  recoverRecordingSession,
  renameRecording,
} from "@/services/recordings";
import { cn } from "@/utils/cn";
import { AudioPlayer } from "./AudioPlayer";
import { useApp } from "./app-context";
import { useI18n } from "./i18n";
import { Badge, Button, Input } from "./kit";
import { TranscriptPanel } from "./TranscriptPanel";

interface LectureRecorderPanelProps {
  lectureId: string;
  subjectId: string;
  lectureTitle: string;
}

export function LectureRecorderPanel({ lectureId, subjectId, lectureTitle }: LectureRecorderPanelProps) {
  const { t } = useI18n();
  const { toast, confirm, recorder, stopAndSaveRecording } = useApp();
  const nav = useNavigate();

  const recordings: LectureRecording[] =
    useLiveQuery(async (): Promise<LectureRecording[]> => {
      const rows = await db.recordings.where("lectureId").equals(lectureId).toArray();
      return rows
        .filter((r) => !r.deletedAt && r.status === "ready")
        .sort((a, b) => b.createdAt - a.createdAt);
    }, [lectureId], []) ?? [];

  const interrupted: LectureRecording[] =
    useLiveQuery(() => listIncompleteRecordings(lectureId), [lectureId], []) ?? [];

  const lectureNotes: Note[] =
    useLiveQuery(
      () => db.notes.where("lectureId").equals(lectureId).filter((n) => !n.deletedAt).toArray(),
      [lectureId],
      []
    ) ?? [];

  const [titleInput, setTitleInput] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [seekReq, setSeekReq] = useState<{ ms: number; nonce: number } | null>(null);
  const [playTimeMs, setPlayTimeMs] = useState(0);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [markerText, setMarkerText] = useState("");

  useEffect(() => {
    if (recordings.length > 0 && (!selectedId || !recordings.some((r) => r.id === selectedId))) {
      setSelectedId(recordings[0].id);
    } else if (recordings.length === 0) {
      setSelectedId(null);
    }
  }, [recordings, selectedId]);

  const selectedRecording = recordings.find((r) => r.id === selectedId) ?? null;
  const selectedAtt: Attachment | undefined = useLiveQuery(
    async () => (selectedRecording?.attachmentId ? db.attachments.get(selectedRecording.attachmentId) : undefined),
    [selectedRecording?.attachmentId]
  );

  const activeHere =
    (recorder.phase === "recording" || recorder.phase === "paused" || recorder.phase === "saving" || recorder.phase === "requesting_mic") &&
    recorder.lectureId === lectureId;
  const activeElsewhere =
    (recorder.phase === "recording" || recorder.phase === "paused" || recorder.phase === "saving") &&
    recorder.lectureId !== lectureId;

  const handleStartRecording = async () => {
    const label = titleInput.trim() || `${lectureTitle} — ${t("تسجيل", "Recording")} ${recordings.length + 1}`;
    try {
      await lectureRecorder.start({ subjectId, lectureId, title: label });
      setTitleInput("");
      toast(t("بدأ تسجيل المحاضرة", "Lecture recording started"));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "MIC_PERMISSION_DENIED") {
        toast(t("تم رفض إذن الميكروفون. فعّله من إعدادات المتصفح.", "Microphone permission denied. Allow mic access in browser settings."), "err");
      } else if (msg === "MIC_UNSUPPORTED") {
        toast(t("المتصفح الحالي لا يدعم تسجيل الصوت أو المتصفح غير آمن (HTTPS).", "Microphone recording is unavailable in this browser context."), "err");
      } else if (msg === "QUOTA_EXCEEDED") {
        toast(t("مساحة التخزين غير كافية لتسجيل الصوت.", "Not enough storage space to record audio."), "err");
      } else {
        toast(msg, "err");
      }
    }
  };

  const handleStopAndSave = async () => {
    const saved = await stopAndSaveRecording();
    if (saved) setSelectedId(saved.recording.id);
  };

  const handleDiscardActive = async () => {
    const ok = await confirm({
      title: t("إلغاء وحذف التسجيل الجاري؟", "Discard active recording?"),
      message: t("سيتم حذف المقاطع المسجلة في هذه الجلسة نهائيًا.", "Chunks recorded in this session will be deleted."),
      danger: true,
    });
    if (!ok) return;
    await lectureRecorder.cancelAndDiscard();
    toast(t("تم تجاهل التسجيل", "Recording discarded"), "info");
  };

  const handleLiveMarker = async () => {
    if (!recorder.recordingId) return;
    const ms = recorder.elapsedMs;
    await addRecordingMarker({
      recordingId: recorder.recordingId,
      timeMs: ms,
      label: markerText.trim() || `${t("علامة", "Marker")} @ ${formatDuration(ms)}`,
    });
    setMarkerText("");
    toast(t("تم حفظ العلامة المرجعية", "Bookmark saved"));
  };

  const handleLiveTimestampNote = async () => {
    if (!recorder.recordingId) return;
    const ms = recorder.elapsedMs;
    let noteId = lectureNotes[0]?.id;
    if (!noteId) {
      const n = await createNote({
        subjectId,
        lectureId,
        title: `${t("ملاحظات", "Notes")}: ${lectureTitle}`,
      });
      noteId = n.id;
    }
    await insertTimestampIntoNote(noteId, {
      recordingId: recorder.recordingId,
      timeMs: ms,
      label: markerText.trim() || undefined,
    });
    toast(t("تم إدراج الطابع الزمني في الملاحظة", "Timestamp inserted into note"), "ok", {
      label: t("فتح الملاحظة", "Open note"),
      run: () => nav(`/notes/${noteId}`),
    });
  };

  const handleRecover = async (rec: LectureRecording) => {
    try {
      const res = await recoverRecordingSession(rec.id);
      setSelectedId(res.recording.id);
      toast(t("تمت استعادة التسجيل بنجاح", "Recording recovered"));
    } catch (e) {
      toast(e instanceof Error ? e.message : t("تعذرت الاستعادة", "Recovery failed"), "err");
    }
  };

  const handleDownloadRecording = async (rec: LectureRecording) => {
    const blob = await getRecordingBlob(rec);
    if (!blob) {
      toast(t("الملف الصوتي غير متوفر", "Audio blob unavailable"), "err");
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const ext = rec.ext || (rec.mime.includes("mp4") ? "m4a" : rec.mime.includes("ogg") ? "ogg" : "webm");
    a.download = `${(rec.title || "lecture").replace(/[^\p{L}\p{N}_-]+/gu, "_")}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="space-y-4">
      {/* Interrupted / crash recovery banner */}
      {interrupted.map((rec) => (
        <div
          key={rec.id}
          className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-warn/40 bg-warn/10 p-4"
        >
          <div className="flex items-start gap-2.5">
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-warn" />
            <div>
              <div className="text-sm font-extrabold">
                {t("تسجيل غير مكتمل يمكن استعادته", "Interrupted recording can be recovered")}: {rec.title}
              </div>
              <div className="text-xs text-muted">
                {rec.chunkCount} {t("مقاطع", "chunks")} · {formatBytes(rec.totalBytes)} · {formatDuration(rec.durationMs)}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {rec.chunkCount > 0 && (
              <Button variant="primary" className="h-9 text-xs" onClick={() => void handleRecover(rec)}>
                <RotateCcw size={14} /> {t("حفظ واستعادة", "Recover & Save")}
              </Button>
            )}
            <Button
              variant="ghost"
              className="h-9 text-xs text-danger"
              onClick={() => void discardRecordingSession(rec.id)}
            >
              <Trash2 size={14} /> {t("تجاهل", "Discard")}
            </Button>
          </div>
        </div>
      ))}

      {/* Recorder control box */}
      <section className="card-surface p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className={cn("flex h-10 w-10 items-center justify-center rounded-2xl", activeHere ? "bg-danger text-white" : "bg-primary/15 text-primary")}>
              <Mic size={20} />
            </div>
            <div>
              <h2 className="text-base font-extrabold">{t("مسجل المحاضرة الصوتي", "Lecture Audio Recorder")}</h2>
              <p className="text-xs text-muted">
                {t("حفظ تدريجي محلي كل 15 ثانية لحماية التسجيلات الطويلة", "Auto-saved in local chunks every 15s for crash safety")}
              </p>
            </div>
          </div>

          {!recorder.micSupported && (
            <Badge color="#c42a3b">{t("الميكروفون غير متاح في هذا المتصفح", "Mic unavailable")}</Badge>
          )}
        </div>

        {activeElsewhere && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-warn/30 bg-warn/10 p-3 text-xs font-bold">
            <span>
              {t("يوجد تسجيل نشط حاليًا لمحاضرة أخرى:", "Another lecture is currently recording:")} {recorder.title}
            </span>
            <Button className="h-8 text-xs" onClick={() => recorder.lectureId && nav(`/lectures/${recorder.lectureId}`)}>
              {t("الانتقال للتسجيل النشط", "Open active recording")}
            </Button>
          </div>
        )}

        {!activeHere && !activeElsewhere && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Input
              value={titleInput}
              onChange={(e) => setTitleInput(e.target.value)}
              placeholder={`${lectureTitle} — ${t("تسجيل", "Recording")} ${recordings.length + 1}`}
              className="flex-1"
            />
            <Button
              variant="primary"
              disabled={!recorder.micSupported}
              onClick={() => void handleStartRecording()}
            >
              <Mic size={16} /> {t("بدء تسجيل المحاضرة", "Record Lecture")}
            </Button>
          </div>
        )}

        {activeHere && (
          <div className="mt-4 space-y-3 rounded-2xl border border-danger/30 bg-danger/5 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <span
                  className={cn(
                    "inline-block h-3 w-3 rounded-full",
                    recorder.phase === "recording" ? "animate-pulse bg-danger" : "bg-warn"
                  )}
                />
                <span className="font-mono text-2xl font-black tabular-nums text-danger" dir="ltr">
                  {formatDuration(recorder.elapsedMs)}
                </span>
                <span className="text-xs font-bold text-muted">
                  {recorder.chunkCount} {t("مقطع محفوظ", "chunks saved")} · {formatBytes(recorder.bytesWritten)}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {recorder.phase === "recording" ? (
                  <Button variant="ghost" onClick={() => lectureRecorder.pause()}>
                    <Pause size={15} /> {t("إيقاف مؤقت", "Pause")}
                  </Button>
                ) : recorder.phase === "paused" ? (
                  <Button variant="accent" onClick={() => lectureRecorder.resume()}>
                    <Play size={15} /> {t("استئناف", "Resume")}
                  </Button>
                ) : null}

                <Button
                  variant="danger"
                  disabled={recorder.phase === "saving"}
                  onClick={() => void handleStopAndSave()}
                >
                  <Square size={15} /> {recorder.phase === "saving" ? t("جاري الحفظ…", "Saving…") : t("إيقاف وحفظ", "Stop & Save")}
                </Button>

                <Button variant="ghost" disabled={recorder.phase === "saving"} onClick={() => void handleDiscardActive()}>
                  <Trash2 size={15} /> {t("تجاهل", "Discard")}
                </Button>
              </div>
            </div>

            {/* Live microphone meter */}
            <div className="h-2 overflow-hidden rounded-full bg-surface" aria-hidden>
              <div
                className="h-full rounded-full bg-gradient-to-r from-accent to-danger transition-[width] duration-75"
                style={{ width: `${Math.max(4, Math.round(recorder.level * 100))}%` }}
              />
            </div>

            {/* Live note timestamp & bookmark */}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Input
                value={markerText}
                onChange={(e) => setMarkerText(e.target.value)}
                placeholder={t("وصف العلامة المرجعية (اختياري)…", "Marker note (optional)…")}
                className="h-9 flex-1 text-xs"
              />
              <Button className="h-9 text-xs" onClick={() => void handleLiveMarker()}>
                {t("إضافة علامة الآن", "Bookmark now")}
              </Button>
              <Button variant="ghost" className="h-9 text-xs" onClick={() => void handleLiveTimestampNote()}>
                <NotebookPen size={14} /> {t("طابع زمني للملاحظة", "Timestamp to note")}
              </Button>
            </div>
          </div>
        )}
      </section>

      {/* Recorded lectures selector */}
      {recordings.length > 0 && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {recordings.map((rec) => {
              const active = rec.id === selectedRecording?.id;
              return (
                <button
                  key={rec.id}
                  type="button"
                  onClick={() => setSelectedId(rec.id)}
                  className={cn(
                    "flex items-center gap-2 rounded-2xl border px-3.5 py-2 text-start text-sm font-bold transition",
                    active ? "border-primary bg-primary/10 text-primary" : "border-line bg-surface hover:border-primary/40"
                  )}
                >
                  <FileAudio size={16} />
                  <span>{rec.title}</span>
                  <span className="font-mono text-xs text-muted">{formatDuration(rec.durationMs)}</span>
                  {rec.transcriptionStatus === "done" && <Badge color="#0b8579">{t("مفرّغ", "Transcribed")}</Badge>}
                </button>
              );
            })}
          </div>

          {selectedRecording && (
            <div className="space-y-4">
              {/* Recording header actions */}
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-line bg-surface px-4 py-3">
                {renamingId === selectedRecording.id ? (
                  <div className="flex flex-1 items-center gap-2">
                    <Input
                      value={renameVal}
                      onChange={(e) => setRenameVal(e.target.value)}
                      className="h-9 max-w-sm"
                    />
                    <Button
                      className="h-9 px-3 text-xs"
                      onClick={async () => {
                        await renameRecording(selectedRecording.id, renameVal);
                        setRenamingId(null);
                        toast(t("تمت إعادة التسمية", "Renamed"));
                      }}
                    >
                      <Check size={14} />
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <Volume2 size={16} className="text-primary" />
                    <span className="font-extrabold">{selectedRecording.title}</span>
                    <span className="text-xs text-muted">
                      {formatBytes(selectedRecording.totalBytes)} · {formatDuration(selectedRecording.durationMs)}
                    </span>
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-1.5">
                  <Button
                    variant="ghost"
                    className="h-8 px-2.5 text-xs"
                    onClick={() => {
                      setRenamingId(selectedRecording.id);
                      setRenameVal(selectedRecording.title);
                    }}
                  >
                    <Edit3 size={13} /> {t("إعادة تسمية", "Rename")}
                  </Button>
                  <Button
                    variant="ghost"
                    className="h-8 px-2.5 text-xs"
                    onClick={() => void handleDownloadRecording(selectedRecording)}
                  >
                    {t("تنزيل الصوت", "Download")}
                  </Button>
                  {selectedRecording.attachmentId && (
                    <Button
                      variant="ghost"
                      className="h-8 px-2.5 text-xs"
                      onClick={() => nav(`/files/${selectedRecording.attachmentId}`)}
                    >
                      {t("عرض كملف", "File view")}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    className="h-8 px-2.5 text-xs text-danger"
                    onClick={async () => {
                      const ok = await confirm({
                        title: t("حذف التسجيل الصوتي؟", "Move recording to trash?"),
                        danger: true,
                      });
                      if (!ok) return;
                      await deleteRecording(selectedRecording.id);
                      toast(t("تم نقل التسجيل إلى سلة المحذوفات", "Moved to trash"), "info");
                    }}
                  >
                    <Trash2 size={13} /> {t("حذف", "Delete")}
                  </Button>
                </div>
              </div>

              {selectedAtt && (
                <AudioPlayer
                  blobId={selectedAtt.blobId}
                  title={selectedRecording.title}
                  recordingId={selectedRecording.id}
                  knownDurationMs={selectedRecording.durationMs}
                  seekRequest={seekReq}
                  onTimeUpdateMs={setPlayTimeMs}
                />
              )}

              <TranscriptPanel
                recording={selectedRecording}
                currentTimeMs={playTimeMs}
                onSeekMs={(ms) => setSeekReq({ ms, nonce: Date.now() })}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
