// Offline ASR transcript panel: model guard, progress/pause/resume, timestamped segments, inline edit, note insert & export.
import { useLiveQuery } from "dexie-react-hooks";
import {
  AlertTriangle, Check, Copy, Download, FilePlus2, Languages, Layers, Loader2,
  Merge, NotebookPen, Pause, Play, RefreshCw, Scissors, Search, Sparkles, Square, Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { asrClient, type AsrJobProgress } from "@/asr/asrClient";
import { ASR_CATALOG, modelSupportsLanguage } from "@/asr/models";
import { db } from "@/data/db";
import type { AsrModelRecord, LectureRecording, Note, TranscriptSegment } from "@/data/types";
import { formatDuration } from "@/domain/text";
import { createNote } from "@/services/notes";
import {
  deleteTranscriptSegment,
  formatTranscriptExport,
  insertTranscriptIntoNote,
  mergeTranscriptWithNext,
  splitTranscriptSegment,
  updateTranscriptSegment,
} from "@/services/recordings";
import { cn } from "@/utils/cn";
import { useApp } from "./app-context";
import { useI18n } from "./i18n";
import { Badge, Button, Input, Select } from "./kit";

interface TranscriptPanelProps {
  recording: LectureRecording;
  currentTimeMs: number;
  onSeekMs: (ms: number) => void;
}

function downloadTextFile(filename: string, content: string, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function TranscriptPanel({ recording, currentTimeMs, onSeekMs }: TranscriptPanelProps) {
  const { t, lang } = useI18n();
  const { toast, openCard } = useApp();
  const nav = useNavigate();

  const models: AsrModelRecord[] = useLiveQuery(() => db.asrModels.toArray(), [], []) ?? [];
  const readyModels = useMemo(() => models.filter((m) => m.status === "ready"), [models]);

  const segments: TranscriptSegment[] =
    useLiveQuery(
      () => db.transcriptSegments.where("recordingId").equals(recording.id).sortBy("order"),
      [recording.id],
      []
    ) ?? [];

  const lectureNotes: Note[] =
    useLiveQuery(async (): Promise<Note[]> => {
      if (!recording.lectureId) return [];
      return db.notes
        .where("lectureId")
        .equals(recording.lectureId)
        .filter((n) => !n.deletedAt)
        .toArray();
    }, [recording.lectureId], []) ?? [];

  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [asrLang, setAsrLang] = useState<"auto" | "ar" | "en">(
    recording.transcriptionLang ?? (lang === "ar" ? "ar" : "en")
  );
  const [jobProgress, setJobProgress] = useState<AsrJobProgress | null>(null);
  const [filterText, setFilterText] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [targetNoteId, setTargetNoteId] = useState<string>("");
  const [busySegId, setBusySegId] = useState<string | null>(null);

  useEffect(() => {
    if (readyModels.length > 0 && !readyModels.some((m) => m.id === selectedModelId)) {
      setSelectedModelId(readyModels[0].id);
    }
  }, [readyModels, selectedModelId]);

  useEffect(() => {
    if (lectureNotes.length > 0 && !lectureNotes.some((n) => n.id === targetNoteId)) {
      setTargetNoteId(lectureNotes[0].id);
    }
  }, [lectureNotes, targetNoteId]);

  useEffect(() => {
    return asrClient.subscribe((p) => {
      if (p.recordingId === recording.id) setJobProgress(p);
    });
  }, [recording.id]);

  const selectedModel = readyModels.find((m) => m.id === selectedModelId) ?? null;
  const langSupported = modelSupportsLanguage(selectedModel, asrLang);
  const isRunning =
    recording.transcriptionStatus === "transcribing" ||
    jobProgress?.phase === "transcribing" ||
    jobProgress?.phase === "decoding" ||
    jobProgress?.phase === "loading_model";

  const filteredSegments = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    if (!q) return segments;
    return segments.filter((s) => s.text.toLowerCase().includes(q));
  }, [segments, filterText]);

  const handleStart = async (resume = false) => {
    if (!selectedModel) return;
    if (!langSupported) {
      toast(t("النموذج المختار لا يدعم هذه اللغة", "Selected model does not support this language"), "err");
      return;
    }
    try {
      await asrClient.runTranscription({
        recordingId: recording.id,
        modelId: selectedModel.id,
        language: asrLang,
        resume,
      });
      toast(t("تم التفريغ النصي بنجاح", "Transcription completed"));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "TRANSCRIPTION_CANCELLED") {
        toast(t("تم إلغاء التفريغ", "Transcription cancelled"), "info");
      } else if (msg === "MODEL_INTEGRITY_FAILED") {
        toast(t("فشل التحقق من سلامة ملفات النموذج، أعد تنزيله من الإعدادات", "Model integrity verification failed. Re-download it in Settings."), "err");
      } else {
        toast(msg, "err");
      }
    }
  };

  const ensureNoteForInsert = async (): Promise<string> => {
    if (targetNoteId) return targetNoteId;
    const note = await createNote({
      subjectId: recording.subjectId,
      lectureId: recording.lectureId || undefined,
      title: `${t("تفريغ", "Transcript")}: ${recording.title}`,
    });
    setTargetNoteId(note.id);
    return note.id;
  };

  const handleInsertFullTranscript = async () => {
    if (segments.length === 0) return;
    const noteId = await ensureNoteForInsert();
    await insertTranscriptIntoNote(noteId, {
      recordingId: recording.id,
      attachmentId: recording.attachmentId,
      title: recording.title,
      segments,
      includeTimestamps: true,
    });
    toast(t("تم إدراج التفريغ الكامل في الملاحظة", "Transcript inserted into note"), "ok", {
      label: t("فتح الملاحظة", "Open note"),
      run: () => nav(`/notes/${noteId}`),
    });
  };

  const handleInsertSegment = async (seg: TranscriptSegment) => {
    const noteId = await ensureNoteForInsert();
    await insertTranscriptIntoNote(noteId, {
      recordingId: recording.id,
      attachmentId: recording.attachmentId,
      title: recording.title,
      segments: [seg],
      includeTimestamps: true,
    });
    toast(t("تم إدراج المقطع في الملاحظة", "Segment inserted into note"));
  };

  const handleSaveEdit = async (segId: string) => {
    await updateTranscriptSegment(segId, { text: editValue });
    setEditingId(null);
    toast(t("تم تحديث المقطع", "Segment updated"));
  };

  const handleSplit = async (seg: TranscriptSegment) => {
    await splitTranscriptSegment(seg.id, Math.floor(seg.text.length / 2));
    toast(t("تم تقسيم المقطع", "Segment split"));
  };

  const handleMerge = async (seg: TranscriptSegment) => {
    await mergeTranscriptWithNext(seg.id);
    toast(t("تم دمج المقطعين", "Segments merged"));
  };

  const handleRetranscribeSegment = async (seg: TranscriptSegment) => {
    if (!selectedModel || !langSupported) {
      toast(t("اختر نموذجًا داعمًا للغة أولاً", "Select a compatible model first"), "err");
      return;
    }
    setBusySegId(seg.id);
    try {
      await asrClient.retranscribeSingleSegment({
        segmentId: seg.id,
        modelId: selectedModel.id,
        language: asrLang,
      });
      toast(t("تمت إعادة تفريغ المقطع", "Segment re-transcribed"));
    } catch (e) {
      toast(e instanceof Error ? e.message : t("تعذر إعادة التفريغ", "Re-transcription failed"), "err");
    } finally {
      setBusySegId(null);
    }
  };

  const baseName = (recording.title || "transcript").replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 60);

  return (
    <div className="space-y-4 rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sparkles size={18} className="text-accent" />
          <h3 className="text-base font-extrabold">{t("التفريغ النصي المحلي (بدون إنترنت)", "Offline Transcription")}</h3>
          {segments.length > 0 && (
            <Badge color="#0b8579">{segments.length} {t("مقطع", "segments")}</Badge>
          )}
        </div>

        {segments.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              variant="ghost"
              className="h-8 px-2.5 text-xs"
              onClick={() => {
                void navigator.clipboard?.writeText(formatTranscriptExport(recording.title, segments, "txt"));
                toast(t("تم نسخ النص", "Copied transcript"));
              }}
            >
              <Copy size={13} /> {t("نسخ", "Copy")}
            </Button>
            <Button
              variant="ghost"
              className="h-8 px-2 text-xs"
              onClick={() => downloadTextFile(`${baseName}.txt`, formatTranscriptExport(recording.title, segments, "txt"))}
            >
              <Download size={13} /> TXT
            </Button>
            <Button
              variant="ghost"
              className="h-8 px-2 text-xs"
              onClick={() => downloadTextFile(`${baseName}.srt`, formatTranscriptExport(recording.title, segments, "srt"))}
            >
              SRT
            </Button>
            <Button
              variant="ghost"
              className="h-8 px-2 text-xs"
              onClick={() => downloadTextFile(`${baseName}.vtt`, formatTranscriptExport(recording.title, segments, "vtt"), "text/vtt;charset=utf-8")}
            >
              VTT
            </Button>
            <Button
              variant="ghost"
              className="h-8 px-2 text-xs"
              onClick={() => downloadTextFile(`${baseName}.md`, formatTranscriptExport(recording.title, segments, "md"), "text/markdown;charset=utf-8")}
            >
              MD
            </Button>
          </div>
        )}
      </div>

      {/* Model availability / controls */}
      {readyModels.length === 0 ? (
        <div className="rounded-xl border border-warn/40 bg-warn/10 p-3.5 text-sm">
          <div className="flex items-start gap-2.5">
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-warn" />
            <div className="space-y-2">
              <div className="font-bold">
                {t(
                  "لا يوجد نموذج تفريغ صوتي مثبت محليًا بعد",
                  "No offline speech model installed yet"
                )}
              </div>
              <p className="text-xs text-muted">
                {t(
                  "يعمل التفريغ النصي داخل متصفحك بالكامل دون إرسال الصوت لأي خادم. نزّل نموذج Whisper مرة واحدة من الإعدادات (~41–78 MB) أو استورد حزمة نموذج محلية.",
                  "Transcription runs 100% locally in your browser without uploading audio anywhere. Download a Whisper model once from Settings (~41–78 MB) or import a local model pack."
                )}
              </p>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button variant="primary" className="h-9 text-xs" onClick={() => nav("/settings")}>
                  {t("إدارة نماذج التفريغ في الإعدادات", "Open Speech Models in Settings")}
                </Button>
                <span className="text-xs text-muted">
                  ({ASR_CATALOG.map((c) => c.id).join(" · ")})
                </span>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[200px] flex-1">
              <label className="mb-1 block text-xs font-bold text-muted">{t("النموذج المحلي", "Local model")}</label>
              <Select value={selectedModelId} onChange={(e) => setSelectedModelId(e.target.value)} disabled={isRunning}>
                {readyModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.languages.join("/")})
                  </option>
                ))}
              </Select>
            </div>

            <div className="w-44">
              <label className="mb-1 flex items-center gap-1 text-xs font-bold text-muted">
                <Languages size={12} /> {t("اللغة", "Language")}
              </label>
              <Select value={asrLang} onChange={(e) => setAsrLang(e.target.value as "auto" | "ar" | "en")} disabled={isRunning}>
                <option value="auto">{t("كشف تلقائي (عربي/إنجليزي)", "Auto-detect (AR/EN)")}</option>
                <option value="ar">{t("العربية", "Arabic (AR)")}</option>
                <option value="en">{t("الإنجليزية", "English (EN)")}</option>
              </Select>
            </div>

            {!isRunning ? (
              <div className="flex items-center gap-2">
                {recording.transcriptionStatus === "paused" && (
                  <Button variant="primary" disabled={!langSupported} onClick={() => void handleStart(true)}>
                    <Play size={15} /> {t("استئناف التفريغ", "Resume")}
                  </Button>
                )}
                <Button
                  variant={recording.transcriptionStatus === "paused" ? "ghost" : "primary"}
                  disabled={!langSupported}
                  onClick={() => void handleStart(false)}
                >
                  <Sparkles size={15} />{" "}
                  {segments.length > 0 ? t("إعادة التفريغ", "Re-transcribe") : t("بدء التفريغ النصي", "Transcribe offline")}
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Button variant="ghost" onClick={() => asrClient.pauseJob(recording.id)}>
                  <Pause size={15} /> {t("إيقاف مؤقت", "Pause")}
                </Button>
                <Button variant="danger" onClick={() => asrClient.cancelJob(recording.id)}>
                  <Square size={15} /> {t("إلغاء", "Cancel")}
                </Button>
              </div>
            )}
          </div>

          {!langSupported && selectedModel && (
            <div className="flex items-center gap-2 rounded-xl border border-danger/35 bg-danger/10 px-3 py-2 text-xs font-bold text-danger">
              <AlertTriangle size={14} />
              {t(
                `النموذج "${selectedModel.name}" يدعم (${selectedModel.languages.join(", ")}) فقط ولا يدعم العربية أو الكشف التلقائي. ثبّت نموذج whisper-tiny أو whisper-base متعدد اللغات.`,
                `Model "${selectedModel.name}" only supports (${selectedModel.languages.join(", ")}) and does not support Arabic or auto-detect. Install whisper-tiny or whisper-base.`
              )}
            </div>
          )}

          {isRunning && (
            <div className="space-y-1 rounded-xl border border-line bg-surface2 p-3">
              <div className="flex items-center justify-between text-xs font-bold">
                <span className="flex items-center gap-1.5">
                  <Loader2 size={14} className="animate-spin text-accent" />
                  {jobProgress?.phase === "loading_model"
                    ? t("جاري تحميل النموذج والتحقق من SHA-256…", "Loading & SHA-256 verifying model…")
                    : jobProgress?.phase === "decoding"
                      ? t("جاري تجهيز الصوت (16kHz PCM)…", "Decoding audio (16kHz PCM)…")
                      : t("جاري التفريغ النصي محليًا…", "Transcribing locally…")}
                </span>
                <span className="font-mono tabular-nums">
                  {Math.round((jobProgress?.progress ?? recording.transcriptionProgress ?? 0) * 100)}%
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-surface">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-primary to-accent transition-all"
                  style={{ width: `${Math.round((jobProgress?.progress ?? recording.transcriptionProgress ?? 0) * 100)}%` }}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Target note + transcript search + insert all */}
      {segments.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <div className="relative min-w-[180px] flex-1">
            <Search size={14} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted" />
            <Input
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              placeholder={t("ابحث داخل التفريغ…", "Search transcript…")}
              className="h-9 ps-8 text-xs"
            />
          </div>

          {lectureNotes.length > 0 && (
            <Select
              value={targetNoteId}
              onChange={(e) => setTargetNoteId(e.target.value)}
              className="h-9 w-48 text-xs"
              aria-label={t("الملاحظة المستهدفة", "Target note")}
            >
              {lectureNotes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.title || t("ملاحظة بلا عنوان", "Untitled note")}
                </option>
              ))}
            </Select>
          )}

          <Button className="h-9 text-xs" onClick={() => void handleInsertFullTranscript()}>
            <FilePlus2 size={14} /> {t("إدراج التفريغ في ملاحظة", "Insert transcript into note")}
          </Button>
        </div>
      )}

      {/* Segments list */}
      {filteredSegments.length > 0 ? (
        <div className="max-h-[420px] space-y-2 overflow-y-auto pe-1">
          {filteredSegments.map((seg, idx) => {
            const active = currentTimeMs >= seg.startMs && currentTimeMs <= seg.endMs;
            const isEditing = editingId === seg.id;
            const isLast = idx === filteredSegments.length - 1;
            return (
              <div
                key={seg.id}
                className={cn(
                  "rounded-xl border p-3 transition",
                  active ? "border-accent bg-accent/10" : "border-line bg-surface2/60 hover:border-line"
                )}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => onSeekMs(seg.startMs)}
                    className="inline-flex items-center gap-1 rounded-lg bg-surface px-2 py-0.5 font-mono text-xs font-extrabold text-primary hover:bg-primary hover:text-primary-fg"
                  >
                    {formatDuration(seg.startMs)} → {formatDuration(seg.endMs)}
                  </button>

                  <div className="flex items-center gap-1">
                    {seg.editedManually && <Badge>{t("معدل", "Edited")}</Badge>}
                    <button
                      type="button"
                      onClick={() => void handleInsertSegment(seg)}
                      title={t("إدراج في الملاحظة", "Insert into note")}
                      className="rounded-lg p-1 text-muted hover:bg-surface hover:text-primary"
                    >
                      <NotebookPen size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        openCard({
                          front: seg.text,
                          subjectId: recording.subjectId,
                          source: { attachmentId: recording.attachmentId, lectureId: recording.lectureId || undefined },
                        })
                      }
                      title={t("إنشاء بطاقة مراجعة", "Create flashcard")}
                      className="rounded-lg p-1 text-muted hover:bg-surface hover:text-accent"
                    >
                      <Layers size={14} />
                    </button>
                    {readyModels.length > 0 && (
                      <button
                        type="button"
                        disabled={busySegId === seg.id}
                        onClick={() => void handleRetranscribeSegment(seg)}
                        title={t("إعادة تفريغ هذا المقطع", "Re-transcribe segment")}
                        className="rounded-lg p-1 text-muted hover:bg-surface hover:text-primary disabled:opacity-40"
                      >
                        <RefreshCw size={14} className={busySegId === seg.id ? "animate-spin" : ""} />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void handleSplit(seg)}
                      title={t("تقسيم المقطع", "Split segment")}
                      className="rounded-lg p-1 text-muted hover:bg-surface hover:text-fg"
                    >
                      <Scissors size={14} />
                    </button>
                    {!isLast && (
                      <button
                        type="button"
                        onClick={() => void handleMerge(seg)}
                        title={t("دمج مع المقطع التالي", "Merge with next")}
                        className="rounded-lg p-1 text-muted hover:bg-surface hover:text-fg"
                      >
                        <Merge size={14} />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void deleteTranscriptSegment(seg.id)}
                      title={t("حذف المقطع", "Delete segment")}
                      className="rounded-lg p-1 text-muted hover:bg-surface hover:text-danger"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                {isEditing ? (
                  <div className="mt-2 flex items-start gap-2">
                    <textarea
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      rows={2}
                      dir="auto"
                      className="w-full rounded-xl border border-accent bg-surface p-2 text-sm"
                    />
                    <Button className="h-9 px-3 text-xs" onClick={() => void handleSaveEdit(seg.id)}>
                      <Check size={14} />
                    </Button>
                  </div>
                ) : (
                  <p
                    dir="auto"
                    onClick={() => {
                      setEditingId(seg.id);
                      setEditValue(seg.text);
                    }}
                    title={t("انقر لتعديل النص", "Click to edit text")}
                    className="mt-2 cursor-text whitespace-pre-wrap text-sm leading-relaxed"
                  >
                    {seg.text}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        segments.length > 0 && (
          <div className="py-4 text-center text-xs text-muted">{t("لا توجد مقاطع مطابقة للبحث", "No matching segments")}</div>
        )
      )}
    </div>
  );
}
