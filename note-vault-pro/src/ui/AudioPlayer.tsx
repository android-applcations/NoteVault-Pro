// Rich offline audio player with speed control, ±10s skip, interactive markers & timestamp sync (all times in ms).
import { useLiveQuery } from "dexie-react-hooks";
import { BookmarkPlus, Pause, Play, RotateCcw, RotateCw, Trash2, Volume2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { db } from "@/data/db";
import type { RecordingMarker } from "@/data/types";
import { formatDuration } from "@/domain/text";
import { addRecordingMarker, deleteRecordingMarker } from "@/services/recordings";
import { useApp } from "./app-context";
import { useI18n } from "./i18n";
import { Button, Input } from "./kit";

interface AudioPlayerProps {
  blobId: string;
  title?: string;
  recordingId?: string;
  knownDurationMs?: number;
  seekRequest?: { ms: number; nonce: number } | null;
  onTimeUpdateMs?: (ms: number) => void;
}

const SPEEDS = [0.75, 1, 1.25, 1.5, 2] as const;

export function AudioPlayer({
  blobId,
  title,
  recordingId,
  knownDurationMs = 0,
  seekRequest,
  onTimeUpdateMs,
}: AudioPlayerProps) {
  const { t } = useI18n();
  const { toast } = useApp();
  const audioRef = useRef<HTMLAudioElement>(null);
  const pendingSeekMsRef = useRef<number | null>(null);
  const onTimeUpdateRef = useRef(onTimeUpdateMs);
  onTimeUpdateRef.current = onTimeUpdateMs;

  const [url, setUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [durationMs, setDurationMs] = useState(knownDurationMs);
  const [speed, setSpeed] = useState<number>(1);
  const [markerLabel, setMarkerLabel] = useState("");
  const [addingMarker, setAddingMarker] = useState(false);

  useEffect(() => {
    let alive = true;
    let objUrl: string | null = null;
    void db.blobs.get(blobId).then((rec) => {
      if (!alive || !rec?.blob) return;
      objUrl = URL.createObjectURL(rec.blob);
      setUrl(objUrl);
    });
    return () => {
      alive = false;
      if (objUrl) URL.revokeObjectURL(objUrl);
      setUrl(null);
    };
  }, [blobId]);

  const markers: RecordingMarker[] =
    useLiveQuery(async (): Promise<RecordingMarker[]> => {
      if (!recordingId) return [];
      return db.recordingMarkers.where("recordingId").equals(recordingId).sortBy("timeMs");
    }, [recordingId], []) ?? [];

  useEffect(() => {
    if (knownDurationMs > 0 && (!durationMs || !Number.isFinite(durationMs))) {
      setDurationMs(knownDurationMs);
    }
  }, [knownDurationMs, durationMs]);

  useEffect(() => {
    if (!seekRequest) return;
    const clampedMs = Math.max(0, seekRequest.ms);
    pendingSeekMsRef.current = clampedMs;
    setCurrentMs(clampedMs);
    onTimeUpdateRef.current?.(clampedMs);
    const el = audioRef.current;
    if (!el || !url || el.readyState < 1) return;
    el.currentTime = clampedMs / 1000;
    pendingSeekMsRef.current = null;
    void el.play().catch(() => undefined);
  }, [seekRequest, url]);

  useEffect(() => {
    const onJump = (ev: Event) => {
      const detail = (ev as CustomEvent<{ recordingId?: string; timeMs?: number }>).detail;
      if (!detail || !recordingId || detail.recordingId !== recordingId) return;
      const el = audioRef.current;
      if (!el) return;
      const targetMs = Math.max(0, detail.timeMs ?? 0);
      el.currentTime = targetMs / 1000;
      setCurrentMs(targetMs);
      void el.play().catch(() => undefined);
    };
    window.addEventListener("nv-jump-audio", onJump);
    return () => window.removeEventListener("nv-jump-audio", onJump);
  }, [recordingId]);

  const togglePlay = () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => undefined);
    else el.pause();
  };

  const seekToMs = (ms: number) => {
    const el = audioRef.current;
    if (!el) return;
    const maxMs = Number.isFinite(el.duration) && el.duration > 0 ? el.duration * 1000 : durationMs;
    const clamped = Math.max(0, maxMs > 0 ? Math.min(maxMs, ms) : ms);
    el.currentTime = clamped / 1000;
    setCurrentMs(clamped);
    onTimeUpdateMs?.(clamped);
  };

  const cycleSpeed = () => {
    const idx = SPEEDS.indexOf(speed as (typeof SPEEDS)[number]);
    const next = SPEEDS[(idx + 1) % SPEEDS.length];
    setSpeed(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  };

  const handleAddMarker = async () => {
    if (!recordingId) return;
    setAddingMarker(true);
    try {
      await addRecordingMarker({
        recordingId,
        timeMs: currentMs,
        label: markerLabel.trim() || `${t("علامة", "Marker")} @ ${formatDuration(currentMs)}`,
      });
      setMarkerLabel("");
      toast(t("تمت إضافة العلامة المرجعية", "Marker added"));
    } finally {
      setAddingMarker(false);
    }
  };

  const effectiveDurationMs =
    Number.isFinite(durationMs) && durationMs > 0 ? durationMs : Math.max(knownDurationMs, currentMs, 1000);

  return (
    <div className="space-y-3 rounded-2xl border border-line bg-surface p-4">
      {url && (
        <audio
          ref={audioRef}
          src={url}
          preload="metadata"
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (Number.isFinite(d) && d > 0) setDurationMs(Math.round(d * 1000));
            e.currentTarget.playbackRate = speed;
            if (pendingSeekMsRef.current !== null) {
              const targetMs = pendingSeekMsRef.current;
              pendingSeekMsRef.current = null;
              e.currentTarget.currentTime = targetMs / 1000;
              setCurrentMs(targetMs);
              onTimeUpdateRef.current?.(targetMs);
              void e.currentTarget.play().catch(() => undefined);
            }
          }}
          onDurationChange={(e) => {
            const d = e.currentTarget.duration;
            if (Number.isFinite(d) && d > 0) setDurationMs(Math.round(d * 1000));
          }}
          onTimeUpdate={(e) => {
            const ms = Math.round(e.currentTarget.currentTime * 1000);
            setCurrentMs(ms);
            onTimeUpdateMs?.(ms);
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
        />
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={togglePlay}
          disabled={!url}
          aria-label={playing ? t("إيقاف مؤقت", "Pause") : t("تشغيل", "Play")}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary text-primary-fg shadow hover:opacity-90 disabled:opacity-40"
        >
          {playing ? <Pause size={20} /> : <Play size={20} />}
        </button>

        <div className="min-w-0 flex-1">
          {title && (
            <div className="mb-1 flex items-center gap-1.5 text-sm font-extrabold">
              <Volume2 size={14} className="shrink-0 text-accent" />
              <span className="truncate">{title}</span>
            </div>
          )}

          {/* Timeline scrubber with visual marker pins */}
          <div className="relative flex items-center py-1" dir="ltr">
            <input
              type="range"
              min={0}
              max={effectiveDurationMs}
              step={100}
              value={Math.min(currentMs, effectiveDurationMs)}
              onChange={(e) => seekToMs(Number(e.target.value))}
              aria-label={t("شريط التقدم الصوتي", "Audio timeline")}
              className="h-2 w-full cursor-pointer accent-primary"
            />
            {effectiveDurationMs > 0 &&
              markers.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => seekToMs(m.timeMs)}
                  title={`${m.label} (${formatDuration(m.timeMs)})`}
                  style={{ left: `${Math.min(100, Math.max(0, (m.timeMs / effectiveDurationMs) * 100))}%` }}
                  className="pointer-events-auto absolute top-0 h-2.5 w-2.5 -translate-x-1/2 rounded-full border border-white bg-accent shadow"
                />
              ))}
          </div>

          <div className="flex items-center justify-between text-xs font-mono tabular-nums text-muted" dir="ltr">
            <span>{formatDuration(currentMs)}</span>
            <span>{formatDuration(Number.isFinite(durationMs) ? durationMs : knownDurationMs)}</span>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            className="h-9 px-2 text-xs"
            onClick={() => seekToMs(currentMs - 10_000)}
            title={t("رجوع 10 ثوانٍ", "Back 10s")}
          >
            <RotateCcw size={14} /> 10s
          </Button>
          <Button
            variant="ghost"
            className="h-9 px-2 text-xs"
            onClick={() => seekToMs(currentMs + 10_000)}
            title={t("تقديم 10 ثوانٍ", "Forward 10s")}
          >
            10s <RotateCw size={14} />
          </Button>
          <Button
            variant="ghost"
            className="h-9 min-w-[46px] px-2 font-mono text-xs font-extrabold"
            onClick={cycleSpeed}
            title={t("سرعة التشغيل", "Playback speed")}
          >
            {speed}x
          </Button>
        </div>
      </div>

      {recordingId && (
        <div className="border-t border-line pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={markerLabel}
              onChange={(e) => setMarkerLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleAddMarker();
                }
              }}
              placeholder={t("علامة مرجعية عند الموضع الحالي…", "Bookmark note at current time…")}
              className="h-9 flex-1 text-xs"
            />
            <Button
              className="h-9 px-3 text-xs"
              disabled={addingMarker}
              onClick={() => void handleAddMarker()}
            >
              <BookmarkPlus size={14} />
              {t("إضافة علامة", "Add marker")} ({formatDuration(currentMs)})
            </Button>
          </div>

          {markers.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {markers.map((m) => (
                <div
                  key={m.id}
                  className="inline-flex items-center gap-1 rounded-xl border border-line bg-surface2 px-2.5 py-1 text-xs font-bold"
                >
                  <button
                    type="button"
                    onClick={() => seekToMs(m.timeMs)}
                    className="flex items-center gap-1 hover:text-primary"
                  >
                    <span className="font-mono text-accent">{formatDuration(m.timeMs)}</span>
                    <span>{m.label}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={t("حذف العلامة", "Delete marker")}
                    onClick={() => void deleteRecordingMarker(m.id)}
                    className="ms-1 text-muted hover:text-danger"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
