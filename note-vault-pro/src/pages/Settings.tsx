import { useLiveQuery } from "dexie-react-hooks";
import { Archive, CheckCircle2, Clipboard, Download, FolderUp, HardDrive, Mic, Monitor, Moon, RefreshCw, ShieldAlert, ShieldCheck, Smartphone, Sun, Trash2, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { deleteInstalledModel, downloadCatalogModel, importLocalModelPack, verifyInstalledModel, type DownloadProgress } from "@/asr/modelManager";
import { ASR_CATALOG } from "@/asr/models";
import type { AsrModelRecord } from "@/data/types";
import { formatBytes } from "@/domain/text";
import { applyBackup, BackupError, exportBackup, exportNotesText, parseBackup, previewBackup, type ImportMode, type ParsedBackup } from "@/services/backup";
import { db } from "@/data/db";
import { DEFAULT_MAX_VERSIONS } from "@/services/notes";
import { permissionManager, type LivePermissionState } from "@/services/permissions";
import { rebuildIndex } from "@/services/search";
import { auditDatabaseIntegrity, cleanPreviews, cleanupOrphans, deleteUnlinkedFiles, getStorageReport, requestPersistence, type IntegrityReport } from "@/services/storage";
import { useApp } from "@/ui/app-context";
import { useI18n, type Prefs } from "@/ui/i18n";
import { Badge, Button, Field, Input, Modal, PageHeader, ProgressBar, Select } from "@/ui/kit";
import { Chip } from "@/ui/shared";

function Section({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return <section className="card-surface mb-5 p-4 sm:p-5"><h2 className="mb-4 flex items-center gap-2 text-base font-extrabold sm:text-lg"><span className="text-accent">{icon}</span>{title}</h2>{children}</section>;
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export default function Settings() {
  const { t, prefs, setPrefs } = useI18n();
  const { toast, confirm } = useApp();
  const [reload, setReload] = useState(0);
  const report = useLiveQuery(getStorageReport, [reload]);
  const maxVersions = useLiveQuery(async () => ((await db.appSettings.get("maxVersions"))?.value as number) ?? DEFAULT_MAX_VERSIONS, []);
  const keepOriginal = useLiveQuery(async () => ((await db.appSettings.get("keepOriginalImages"))?.value as boolean) ?? false, []);
  const pdfIndexLimit = useLiveQuery(async () => ((await db.appSettings.get("pdfIndexLimit"))?.value as number) ?? 1500, []);
  const installedAsrModels: AsrModelRecord[] = useLiveQuery(() => db.asrModels.toArray(), [], []) ?? [];
  const fileRef = useRef<HTMLInputElement>(null);
  const asrPackRef = useRef<HTMLInputElement>(null);
  const asrAbortRef = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [asrProgress, setAsrProgress] = useState<Record<string, DownloadProgress>>({});
  const [parsed, setParsed] = useState<ParsedBackup | null>(null);
  const [mode, setMode] = useState<ImportMode>("merge");
  const [integrity, setIntegrity] = useState<IntegrityReport | null>(null);
  const [caps, setCaps] = useState(() => permissionManager.getSnapshot());
  const [permBusy, setPermBusy] = useState(false);

  useEffect(() => {
    const unsub = permissionManager.subscribe(setCaps);
    void permissionManager.refreshAll();
    const sync = () => {
      if (document.visibilityState !== "hidden") {
        void permissionManager.refreshAll();
      }
    };
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      unsub();
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  const permBadge = (state: LivePermissionState) => {
    if (state === "granted") return <Badge color="#15803d">{t("مسموح", "Allowed")}</Badge>;
    if (state === "denied") return <Badge color="#c42a3b">{t("غير مسموح", "Blocked")}</Badge>;
    if (state === "unsupported") return <Badge color="#c42a3b">{t("غير متاح", "Unavailable")}</Badge>;
    return <Badge>{t("لم يُطلب بعد", "Not requested")}</Badge>;
  };

  const errText = (e: unknown) => {
    const c = e instanceof BackupError ? e.code : "";
    const m: Record<string, string> = {
      too_large: t("الملف كبير جداً", "The file is too large"), not_zip: t("الملف ليس نسخة احتياطية صالحة", "Not a valid backup file"), bad_entry: t("تعذّر قبول محتوى هذا الملف", "The file contains invalid items"),
      no_manifest: t("ملف النسخة ناقص", "Backup is incomplete"), bad_manifest: t("بيانات النسخة غير صالحة", "Backup details are invalid"), newer_version: t("النسخة أحدث من هذا الإصدار — حدّث التطبيق أولاً", "Backup is newer than this app — please update first"),
      bad_json: t("بيانات تالفة", "Corrupted data"), bad_record: t("بيانات غير صالحة", "Invalid items"), relation: t("الروابط بين العناصر غير مكتملة", "Item links are incomplete"), bad_blob: t("أحد الملفات لا يطابق نوعه", "An attached file does not match its type"),
      corrupt: t("أحد الملفات تالف", "An attached file is corrupted"), apply_failed: t("تعذر الاستيراد — بقيت بياناتك كما هي", "Import failed — nothing was changed"),
    };
    return m[c] ?? t("تعذرت العملية", "Operation failed");
  };
  const doExport = async () => { setBusy("export"); try { saveBlob(await exportBackup(), `notevault-backup-${new Date().toISOString().slice(0, 10)}.zip`); toast(t("تم تصدير النسخة الاحتياطية", "Backup exported")); } catch { toast(t("تعذر التصدير", "Export failed"), "err"); } finally { setBusy(null); } };
  const pick = async (f?: File) => { if (!f) return; setBusy("parse"); try { setParsed(await parseBackup(f)); setMode("merge"); } catch (e) { toast(errText(e), "err"); } finally { setBusy(null); if (fileRef.current) fileRef.current.value = ""; } };
  const doImport = async () => {
    if (!parsed) return;
    if (mode === "replace" && !(await confirm({ title: t("استبدال كل البيانات الحالية؟", "Replace ALL current data?"), message: t("سيتم حذف بياناتك الحالية واستبدالها بمحتوى النسخة الاحتياطية.", "Your current data will be replaced by the backup."), danger: true, confirmLabel: t("استبدال", "Replace") }))) return;
    setBusy("import");
    try { await applyBackup(parsed, mode); toast(t("تم الاستيراد بنجاح", "Import complete")); setParsed(null); setTimeout(() => location.reload(), 600); } catch (e) { toast(errText(e), "err"); } finally { setBusy(null); }
  };
  const total = report?.quota && report.usage ? (report.usage / report.quota) * 100 : 0;
  const preview = parsed ? previewBackup(parsed) : null;
  const labels: Record<string, string> = { subjects: t("مواد", "Subjects"), lectures: t("محاضرات", "Lectures"), notes: t("ملاحظات", "Notes"), attachments: t("مرفقات", "Attachments"), flashcards: t("بطاقات", "Cards"), quizzes: t("اختبارات", "Quizzes"), references: t("مراجع", "References"), semesters: t("فصول", "Semesters") };

  return (
    <div className="max-w-3xl lg:max-w-4xl">
      <PageHeader title={t("الإعدادات", "Settings")} />
      <Section title={t("المظهر واللغة", "Appearance & language")} icon={<Sun size={18} />}>
        <div className="grid gap-4 md:grid-cols-2">
          <div><span className="text-xs font-semibold text-muted">{t("المظهر", "Theme")}</span><div className="mt-1.5 flex flex-wrap gap-2">{([["light", Sun, t("نهاري", "Light")], ["dark", Moon, t("ليلي", "Dark")], ["system", Monitor, t("النظام", "System")]] as const).map(([k, I, l]) => <button key={k} aria-pressed={prefs.theme === k} onClick={() => setPrefs({ theme: k })} className={`flex min-w-[5.5rem] flex-1 items-center justify-center gap-1.5 rounded-xl border px-3 py-2.5 text-sm font-bold ${prefs.theme === k ? "border-primary bg-primary text-primary-fg" : "border-line bg-surface"}`}><I size={15} />{l}</button>)}</div></div>
          <div><span className="text-xs font-semibold text-muted">{t("اللغة", "Language")}</span><div className="mt-1.5 flex flex-wrap gap-2">{([["ar", "العربية"], ["en", "English"]] as const).map(([k, l]) => <button key={k} aria-pressed={prefs.lang === k} onClick={() => setPrefs({ lang: k })} className={`min-w-[6.5rem] flex-1 rounded-xl border px-3 py-2.5 text-sm font-bold ${prefs.lang === k ? "border-primary bg-primary text-primary-fg" : "border-line bg-surface"}`}>{l}</button>)}</div></div>
          <Field label={t("حجم النص", "Text size")}>{(id) => <Select id={id} value={prefs.textSize} onChange={(e) => setPrefs({ textSize: e.target.value as Prefs["textSize"] })}><option value="sm">{t("صغير", "Small")}</option><option value="md">{t("عادي", "Normal")}</option><option value="lg">{t("كبير", "Large")}</option><option value="xl">{t("كبير جداً", "Extra large")}</option></Select>}</Field>
          <label className="flex items-center gap-2 self-end pb-2 text-sm font-bold"><input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={prefs.reduceMotion} onChange={(e) => setPrefs({ reduceMotion: e.target.checked })} />{t("تقليل الحركة", "Reduce motion")}</label>
        </div>
      </Section>

      <Section title={t("المحرر والملفات", "Editor & files")} icon={<RefreshCw size={18} />}>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label={t("عدد النسخ المحفوظة لكل ملاحظة", "Versions kept per note")}>{(id) => <Input id={id} type="number" min={1} max={200} value={maxVersions ?? DEFAULT_MAX_VERSIONS} onChange={(e) => db.appSettings.put({ key: "maxVersions", value: Math.min(200, Math.max(1, Number(e.target.value) || 1)) })} />}</Field>
          <Field label={t("حد صفحات البحث السريع في PDF", "PDF fast-search page limit")}>{(id) => <Input id={id} type="number" min={50} max={20000} step={50} value={pdfIndexLimit ?? 1500} onChange={(e) => db.appSettings.put({ key: "pdfIndexLimit", value: Math.min(20000, Math.max(50, Math.round(Number(e.target.value) || 1500))) })} />}</Field>
          <label className="flex items-center gap-2 self-end pb-2 text-sm font-bold md:col-span-2"><input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={!!keepOriginal} onChange={(e) => db.appSettings.put({ key: "keepOriginalImages", value: e.target.checked })} />{t("الاحتفاظ بالصور الأصلية (دون ضغط)", "Keep original images (no compression)")}</label>
        </div>
      </Section>

      <Section title={t("أذونات التطبيق", "App permissions")} icon={<ShieldCheck size={18} />}>
        <p className="mb-3 text-xs text-muted">
          {t(
            "تُطلب الأذونات فقط عند استخدام الميزة التي تحتاج إليها، وتُقرأ حالتها مباشرة من جهازك.",
            "Permissions are requested only when you use a feature and reflect live device status."
          )}
        </p>
        <div className="space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface2/60 p-3">
            <div className="flex min-w-0 flex-1 items-start gap-2.5">
              <Mic size={16} className="mt-0.5 shrink-0 text-accent" />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-sm font-bold">
                  <span>{t("الميكروفون (مسجل المحاضرات)", "Microphone (Lecture Recorder)")}</span>
                  {permBadge(caps.microphone)}
                </div>
                <p className="mt-0.5 text-xs text-muted">
                  {caps.microphone === "denied"
                    ? t("لم يتم السماح باستخدام الميكروفون. يمكنك تفعيل الإذن من إعدادات التطبيق في جهازك.", "Microphone access is turned off. Enable it from your device or site settings.")
                    : caps.microphone === "unsupported"
                      ? t("التسجيل المباشر غير متاح على هذا الجهاز حالياً.", "Live recording is unavailable on this device.")
                      : t("يُستخدم عند الضغط على بدء تسجيل المحاضرة فقط.", "Used only when you start recording a lecture.")}
                </p>
              </div>
            </div>
            {caps.microphoneSupported && caps.microphone !== "granted" && caps.isSecureContext && !caps.isEmbedded && (
              <Button
                className="h-8 text-xs"
                disabled={permBusy}
                onClick={async () => {
                  setPermBusy(true);
                  try {
                    await permissionManager.requestMicrophoneAccess();
                    toast(t("تم تفعيل الميكروفون", "Microphone enabled"));
                  } catch {
                    toast(t("لم يتم السماح باستخدام الميكروفون. يمكنك تفعيل الإذن من إعدادات التطبيق في جهازك.", "Microphone access was not granted."), "err");
                  } finally {
                    setPermBusy(false);
                  }
                }}
              >
                {caps.microphone === "denied" ? t("إعادة المحاولة", "Try again") : t("تفعيل الميكروفون", "Allow mic")}
              </Button>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface2/60 p-3">
            <div className="flex min-w-0 flex-1 items-start gap-2.5">
              <Smartphone size={16} className="mt-0.5 shrink-0 text-accent" />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-sm font-bold">
                  <span>{t("إبقاء الشاشة مضاءة أثناء التسجيل", "Keep screen awake while recording")}</span>
                  <Badge color={caps.wakeLockSupported ? "#0b8579" : undefined}>
                    {caps.wakeLockSupported ? t("متاح تلقائياً", "Supported") : t("غير مدعوم", "Unsupported")}
                  </Badge>
                </div>
                <p className="mt-0.5 text-xs text-muted">
                  {t("يُفعّل تلقائياً أثناء تسجيل المحاضرة فقط ويتوقف فور الإيقاف.", "Enabled only while actively recording and released immediately afterward.")}
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface2/60 p-3">
            <div className="flex min-w-0 flex-1 items-start gap-2.5">
              <Clipboard size={16} className="mt-0.5 shrink-0 text-accent" />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-sm font-bold">
                  <span>{t("الحافظة (نسخ النصوص والمراجع)", "Clipboard (Copy notes & references)")}</span>
                  <Badge color={caps.clipboardSupported ? "#0b8579" : undefined}>
                    {caps.clipboardSupported ? t("متاح", "Available") : t("غير مدعوم", "Unsupported")}
                  </Badge>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Section>

      <Section title={t("مساحة التخزين", "Storage")} icon={<HardDrive size={18} />}>
        {report && <>
          {report.quota && <div className="mb-4"><div className="mb-1 flex flex-wrap justify-between gap-1 text-sm font-bold"><span>{t("المساحة المستخدمة", "Used storage")}</span><span dir="ltr">{formatBytes(report.usage ?? 0)} / {formatBytes(report.quota)}</span></div><ProgressBar value={total} color={total > 85 ? "var(--danger)" : "var(--accent)"} />{total > 85 && <p className="mt-1 text-xs font-bold text-danger">{t("المساحة تقترب من الامتلاء — احتفظ بنسخة احتياطية.", "Storage is nearly full — keep a backup.")}</p>}</div>}
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3 md:grid-cols-4">{[[t("الملاحظات", "Notes"), report.notesBytes], [t("ملفات PDF", "PDF files"), report.pdfBytes], [t("الصور", "Images"), report.imageBytes], [t("الصوتيات", "Audio"), report.audioBytes], [t("النصوص", "Text"), report.textBytes], [t("المعاينات", "Previews"), report.previewBytes], [t("إجمالي البيانات", "Total data"), report.total]].map(([l, v]) => <div key={l as string} className="rounded-xl bg-surface2 p-3"><div className="font-black" dir="ltr">{formatBytes(v as number)}</div><div className="text-xs text-muted">{l}</div></div>)}</div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button onClick={async () => { toast((await requestPersistence()) ? t("تم تفعيل حماية البيانات على الجهاز", "Data protection enabled") : t("يتعذر تفعيل الحماية الإضافية حالياً", "Additional protection is unavailable right now"), "info"); setReload((r) => r + 1); }}>{report.persisted ? t("حماية البيانات مفعّلة ✓", "Data protection active ✓") : t("حماية البيانات من الحذف", "Protect stored data")}</Button>
            <Button onClick={async () => { const n = await cleanPreviews(); toast(t(`تم تنظيف ${n} معاينة مؤقتة`, `Cleared ${n} temporary previews`)); setReload((r) => r + 1); }}>{t("تنظيف المعاينات المؤقتة", "Clear temporary previews")}</Button>
            <Button disabled={!report.unlinked.count} onClick={async () => { if (await confirm({ title: t("حذف الملفات غير المرتبطة؟", "Delete unlinked files?"), message: t(`${report.unlinked.count} ملف (${formatBytes(report.unlinked.bytes)}) غير مرتبط بأي مادة أو محاضرة أو ملاحظة سيُحذف نهائياً.`, `${report.unlinked.count} file(s) (${formatBytes(report.unlinked.bytes)}) not linked to any subject, lecture or note will be deleted permanently.`), danger: true })) { const n = await deleteUnlinkedFiles(); toast(t(`حُذف ${n} ملف`, `${n} file(s) deleted`)); setReload((r) => r + 1); } }}>{t("حذف الملفات غير المرتبطة", "Delete unlinked files")} ({report.unlinked.count})</Button>
            <Button disabled={busy === "index"} onClick={async () => { setBusy("index"); await rebuildIndex(); setBusy(null); toast(t("تم تحديث البحث", "Search refreshed")); }}>{t("تحديث البحث", "Refresh search")}</Button>
            <Button disabled={busy === "audit"} onClick={async () => {
              setBusy("audit");
              try {
                const res = await auditDatabaseIntegrity();
                setIntegrity(res);
                if (res.orphanBlobs === 0 && res.orphanRecords === 0 && res.missingBlobAttachments === 0) {
                  toast(t("بياناتك سليمة ومنظمة", "Everything looks healthy"));
                } else {
                  toast(t(`عُثر على ${res.orphanBlobs} ملف غير مستخدم و ${res.orphanRecords} عنصر غير مكتمل`, `Found ${res.orphanBlobs} unused item(s) and ${res.orphanRecords} incomplete entry`), "info");
                }
              } finally { setBusy(null); }
            }}>{t("فحص سلامة البيانات", "Check library health")}</Button>
            {integrity && (integrity.orphanBlobs > 0 || integrity.orphanRecords > 0) && (
              <Button variant="danger" disabled={busy === "cleanup"} onClick={async () => {
                setBusy("cleanup");
                try {
                  const res = await cleanupOrphans();
                  setIntegrity(await auditDatabaseIntegrity());
                  setReload((r) => r + 1);
                  toast(t(`تم تحرير ${formatBytes(res.bytesReclaimed)} وتنظيف البيانات المؤقتة`, `Freed ${formatBytes(res.bytesReclaimed)} of unused data`));
                } finally { setBusy(null); }
              }}>{t("تنظيف البيانات المؤقتة", "Clean unused data")}</Button>
            )}
          </div>
          {integrity && (
            <div className="mt-3 rounded-xl bg-surface2 p-3 text-xs text-muted">
              {t(
                `ملفات غير مرتبطة: ${integrity.orphanBlobs} (${formatBytes(integrity.orphanBlobBytes)}) · عناصر غير مكتملة: ${integrity.orphanRecords} · ملفات مفقودة: ${integrity.missingBlobAttachments}`,
                `Unused files: ${integrity.orphanBlobs} (${formatBytes(integrity.orphanBlobBytes)}) · Incomplete items: ${integrity.orphanRecords} · Missing files: ${integrity.missingBlobAttachments}`
              )}
            </div>
          )}
          <p className="mt-3 text-xs text-muted">{t("لا يحذف التطبيق أي ملف تلقائياً بسبب امتلاء المساحة.", "The app never deletes your files automatically when space runs low.")}</p></>}
      </Section>

      <Section title={t("النسخ الاحتياطي والاستعادة", "Backup & restore")} icon={<Archive size={18} />}>
        <p className="mb-3 text-sm text-muted">{t("احتفظ بنسخة احتياطية دورية لحماية موادك ومحاضراتك وملاحظاتك وملفاتك وبطاقاتك.", "Keep a regular backup to protect your subjects, lectures, notes, files and flashcards.")}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={!!busy} onClick={() => void doExport()}><Download size={16} />{busy === "export" ? t("جارٍ التصدير…", "Exporting…") : t("تصدير نسخة كاملة", "Export full backup")}</Button>
          <Button disabled={!!busy} onClick={async () => { saveBlob(await exportNotesText(), "notevault-notes.zip"); }}><Download size={16} />{t("تصدير الملاحظات (نصوص)", "Export notes (text)")}</Button>
          <Button disabled={!!busy} onClick={() => fileRef.current?.click()}><Upload size={16} />{busy === "parse" ? t("جارٍ الفحص…", "Checking…") : t("استيراد نسخة", "Import backup")}</Button>
          <input ref={fileRef} type="file" accept=".zip,application/zip" className="sr-only" aria-label={t("اختيار ملف نسخة احتياطية", "Choose backup file")} onChange={(e) => void pick(e.target.files?.[0])} />
        </div>
      </Section>

      <Section title={t("التفريغ الصوتي للمحاضرات", "Lecture Transcription")} icon={<Mic size={18} />}>
        <p className="mb-3 text-sm text-muted">
          {t(
            "نزّل حزمة اللغة مرة واحدة لتفريغ تسجيلات المحاضرات تلقائياً في أي وقت، حتى دون اتصال.",
            "Download a language pack once to transcribe lecture recordings automatically anytime, even offline."
          )}
        </p>

        <div className="space-y-3">
          {ASR_CATALOG.map((entry) => {
            const installed = installedAsrModels.find((m) => m.id === entry.id);
            const prog = asrProgress[entry.id];
            const isDownloading = busy === `asr-dl-${entry.id}` || installed?.status === "downloading";
            const pct = prog && prog.totalBytes > 0 ? Math.min(100, Math.round((prog.downloadedBytes / prog.totalBytes) * 100)) : 0;
            return (
              <div key={entry.id} className="rounded-xl border border-line bg-surface2/60 p-3.5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-extrabold">{t(entry.nameAr, entry.nameEn)}</span>
                      <Badge color={entry.supportsArabic ? "#0b8579" : undefined}>
                        {entry.languages.join(" / ").toUpperCase()}
                      </Badge>
                      {installed?.status === "ready" && (
                        <Badge color="#15803d">
                          <CheckCircle2 size={11} /> {t("جاهز للاستخدام", "Ready")}
                        </Badge>
                      )}
                      {installed?.status === "error" && (
                        <Badge color="#c42a3b">
                          <ShieldAlert size={11} /> {t("بحاجة لإعادة تنزيل", "Needs re-download")}
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted">{t(entry.descriptionAr, entry.descriptionEn)}</p>
                    {installed?.status === "ready" && (
                      <div className="mt-1 text-[11px] text-muted" dir="ltr">
                        {formatBytes(installed.sizeBytes)} · {t("جاهز دون اتصال", "Ready offline")}
                      </div>
                    )}
                    {installed?.status === "error" && (
                      <div className="mt-1 text-[11px] font-bold text-danger">
                        {t("تعذر التحقق من الحزمة — أعد التنزيل", "Pack check failed — please download again")}
                      </div>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    {isDownloading ? (
                      <Button
                        variant="danger"
                        className="h-9 text-xs"
                        onClick={() => {
                          asrAbortRef.current?.abort();
                        }}
                      >
                        <X size={14} /> {t("إلغاء", "Cancel")} ({pct}%)
                      </Button>
                    ) : installed?.status === "ready" ? (
                      <>
                        <Button
                          className="h-9 text-xs"
                          disabled={!!busy}
                          onClick={async () => {
                            setBusy(`asr-verify-${entry.id}`);
                            try {
                              await verifyInstalledModel(entry.id);
                              toast(t("تم التحقق من جاهزية الحزمة بنجاح", "Language pack verified"));
                            } catch {
                              toast(t("تعذر التحقق من الحزمة — أعد التنزيل", "Pack check failed — please download again"), "err");
                            } finally {
                              setBusy(null);
                            }
                          }}
                        >
                          <ShieldCheck size={14} /> {t("التحقق", "Verify")}
                        </Button>
                        <Button
                          variant="ghost"
                          className="h-9 text-xs text-danger"
                          disabled={!!busy}
                          onClick={async () => {
                            if (!(await confirm({ title: t("حذف حزمة اللغة؟", "Delete language pack?"), danger: true }))) return;
                            await deleteInstalledModel(entry.id);
                            toast(t("تم حذف الحزمة من الجهاز", "Language pack removed"));
                          }}
                        >
                          <Trash2 size={14} /> {t("حذف", "Delete")}
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="primary"
                        className="h-9 text-xs"
                        disabled={!!busy}
                        onClick={async () => {
                          const ac = new AbortController();
                          asrAbortRef.current = ac;
                          setBusy(`asr-dl-${entry.id}`);
                          try {
                            await downloadCatalogModel(entry.id, {
                              signal: ac.signal,
                              onProgress: (p) => setAsrProgress((cur) => ({ ...cur, [entry.id]: p })),
                            });
                            toast(t("تم تنزيل حزمة اللغة بنجاح", "Language pack ready"));
                          } catch (e) {
                            const aborted = e instanceof DOMException && e.name === "AbortError";
                            toast(
                              aborted
                                ? t("تم إلغاء التنزيل", "Download cancelled")
                                : t("تعذر التنزيل — تحقق من الاتصال وحاول مجدداً", "Download failed — check your connection and try again"),
                              aborted ? "info" : "err"
                            );
                          } finally {
                            asrAbortRef.current = null;
                            setBusy(null);
                          }
                        }}
                      >
                        <Download size={14} /> {t("تنزيل", "Download")}
                      </Button>
                    )}
                  </div>
                </div>

                {isDownloading && prog && (
                  <div className="mt-2.5">
                    <div className="mb-1 flex justify-between text-[11px] font-bold text-muted" dir="ltr">
                      <span>{t("جارٍ التنزيل…", "Downloading…")}</span>
                      <span>{formatBytes(prog.downloadedBytes)} / {formatBytes(prog.totalBytes)}</span>
                    </div>
                    <ProgressBar value={pct} />
                  </div>
                )}
              </div>
            );
          })}

          {installedAsrModels
            .filter((m) => !ASR_CATALOG.some((c) => c.id === m.id))
            .map((m) => (
              <div key={m.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface2/60 p-3.5">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 font-extrabold">
                    <span>{m.name}</span>
                    <Badge color="#0b8579">{m.languages.join(" / ").toUpperCase()}</Badge>
                    <Badge color={m.status === "ready" ? "#15803d" : "#c42a3b"}>{m.status === "ready" ? t("جاهز", "Ready") : t("بحاجة لإعادة تنزيل", "Needs re-download")}</Badge>
                  </div>
                  <div className="text-xs text-muted" dir="ltr">{formatBytes(m.sizeBytes)} · {t("حزمة مخصصة", "Custom pack")}</div>
                </div>
                <div className="flex gap-1.5">
                  <Button
                    className="h-9 text-xs"
                    onClick={async () => {
                      try {
                        await verifyInstalledModel(m.id);
                        toast(t("الحزمة جاهزة للاستخدام", "Language pack verified"));
                      } catch {
                        toast(t("تعذر التحقق من الحزمة", "Language pack check failed"), "err");
                      }
                    }}
                  >
                    <ShieldCheck size={14} /> {t("التحقق", "Verify")}
                  </Button>
                  <Button
                    variant="ghost"
                    className="h-9 text-xs text-danger"
                    onClick={() => void deleteInstalledModel(m.id)}
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              </div>
            ))}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            disabled={!!busy}
            onClick={() => asrPackRef.current?.click()}
          >
            <FolderUp size={16} />
            {busy === "asr-import" ? t("جارٍ الاستيراد…", "Importing…") : t("استيراد حزمة لغة من الجهاز", "Import language pack")}
          </Button>
          <input
            ref={asrPackRef}
            type="file"
            multiple
            accept=".zip,.onnx,.json,application/zip"
            className="sr-only"
            aria-label={t("استيراد حزمة لغة", "Import language pack")}
            onChange={async (e) => {
              const files = Array.from(e.target.files ?? []);
              if (asrPackRef.current) asrPackRef.current.value = "";
              if (!files.length) return;
              setBusy("asr-import");
              try {
                const input = files.length === 1 && files[0].name.toLowerCase().endsWith(".zip") ? files[0] : files;
                const rec = await importLocalModelPack(input);
                toast(t(`تمت إضافة الحزمة "${rec.name}" بنجاح`, `Added "${rec.name}" successfully`));
              } catch {
                toast(t("تعذر استيراد حزمة اللغة — تأكد من اكتمال الملف", "Could not import language pack — check that the file is complete"), "err");
              } finally {
                setBusy(null);
              }
            }}
          />
        </div>
      </Section>

      <Modal open={!!parsed} onClose={() => setParsed(null)} title={t("معاينة النسخة الاحتياطية", "Backup preview")} footer={<><Button onClick={() => setParsed(null)}>{t("إلغاء", "Cancel")}</Button><Button variant={mode === "replace" ? "danger" : "primary"} disabled={busy === "import"} onClick={() => void doImport()}>{busy === "import" ? t("جارٍ الاستيراد…", "Importing…") : mode === "replace" ? t("استبدال", "Replace") : t("دمج", "Merge")}</Button></>}>
        {preview && <div className="space-y-4"><p className="text-sm text-muted">{t("تم فحص النسخة الاحتياطية بنجاح.", "Backup checked successfully.")} · {new Date(preview.createdAt).toLocaleString()}</p>
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">{preview.counts.map((c) => <div key={c.label} className="rounded-xl bg-surface2 p-3 text-center"><div className="text-xl font-black">{c.n}</div><div className="text-xs text-muted">{labels[c.label]}</div></div>)}</div>
          <div className="flex flex-wrap gap-2"><Chip active={mode === "merge"} onClick={() => setMode("merge")}>{t("دمج مع البيانات الحالية", "Merge with current data")}</Chip><Chip active={mode === "replace"} onClick={() => setMode("replace")}>{t("استبدال كل شيء", "Replace everything")}</Chip></div>
          <p className="text-xs text-muted">{mode === "merge" ? t("يبقى الأحدث تعديلاً عند وجود تعارض، ولا تُكرَّر العناصر.", "The most recently edited item wins on conflict; nothing is duplicated.") : t("تُحذف البيانات الحالية بعد تأكيدك، وتبقى آمنة عند أي تعذر.", "Current data is removed after you confirm. On any failure nothing changes.")}</p></div>}
      </Modal>
    </div>
  );
}

