import { useLiveQuery } from "dexie-react-hooks";
import { Archive, Download, HardDrive, Monitor, Moon, RefreshCw, ShieldCheck, Smartphone, Sun, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { formatBytes } from "@/domain/text";
import { useInstall } from "@/pwa";
import { applyBackup, BackupError, exportBackup, exportNotesText, parseBackup, previewBackup, type ImportMode, type ParsedBackup } from "@/services/backup";
import { db } from "@/data/db";
import { DEFAULT_MAX_VERSIONS } from "@/services/notes";
import { rebuildIndex } from "@/services/search";
import { auditDatabaseIntegrity, cleanPreviews, cleanupOrphans, deleteUnlinkedFiles, getStorageReport, requestPersistence, type IntegrityReport } from "@/services/storage";
import { useApp } from "@/ui/app-context";
import { useI18n, type Prefs } from "@/ui/i18n";
import { Badge, Button, Field, Input, Modal, PageHeader, ProgressBar, Select } from "@/ui/kit";
import { Chip } from "@/ui/shared";

function Section({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return <section className="card-surface mb-5 p-5"><h2 className="mb-4 flex items-center gap-2 text-lg font-extrabold"><span className="text-accent">{icon}</span>{title}</h2>{children}</section>;
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export default function Settings() {
  const { t, prefs, setPrefs } = useI18n();
  const { toast, confirm } = useApp();
  const inst = useInstall();
  const [reload, setReload] = useState(0);
  const report = useLiveQuery(getStorageReport, [reload]);
  const maxVersions = useLiveQuery(async () => ((await db.appSettings.get("maxVersions"))?.value as number) ?? DEFAULT_MAX_VERSIONS, []);
  const keepOriginal = useLiveQuery(async () => ((await db.appSettings.get("keepOriginalImages"))?.value as boolean) ?? false, []);
  const pdfIndexLimit = useLiveQuery(async () => ((await db.appSettings.get("pdfIndexLimit"))?.value as number) ?? 1500, []);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedBackup | null>(null);
  const [mode, setMode] = useState<ImportMode>("merge");
  const [integrity, setIntegrity] = useState<IntegrityReport | null>(null);

  const errText = (e: unknown) => {
    const c = e instanceof BackupError ? e.code : "";
    const m: Record<string, string> = {
      too_large: t("الملف كبير جداً", "The file is too large"), not_zip: t("الملف ليس نسخة احتياطية صالحة", "Not a valid backup file"), bad_entry: t("الملف يحتوي مسارات غير مسموحة", "The file contains disallowed paths"),
      no_manifest: t("ملف النسخة ناقص", "Backup is incomplete"), bad_manifest: t("بيانات النسخة غير صالحة", "Backup metadata is invalid"), newer_version: t("النسخة أحدث من إصدار التطبيق — حدّث التطبيق", "Backup is newer than this app — update the app"),
      bad_json: t("بيانات تالفة", "Corrupted data"), bad_record: t("سجلات غير صالحة", "Invalid records"), relation: t("العلاقات بين البيانات غير سليمة", "Data relationships are inconsistent"), bad_blob: t("ملف مرفق لا يطابق نوعه", "An attached file does not match its type"),
      corrupt: t("ملف مرفق تالف", "An attached file is corrupted"), apply_failed: t("فشل الاستيراد — لم يتغير أي شيء", "Import failed — nothing was changed"),
    };
    return m[c] ?? t("تعذرت العملية", "Operation failed");
  };
  const doExport = async () => { setBusy("export"); try { saveBlob(await exportBackup(), `notevault-backup-${new Date().toISOString().slice(0, 10)}.zip`); toast(t("تم تصدير النسخة الاحتياطية", "Backup exported")); } catch { toast(t("تعذر التصدير", "Export failed"), "err"); } finally { setBusy(null); } };
  const pick = async (f?: File) => { if (!f) return; setBusy("parse"); try { setParsed(await parseBackup(f)); setMode("merge"); } catch (e) { toast(errText(e), "err"); } finally { setBusy(null); if (fileRef.current) fileRef.current.value = ""; } };
  const doImport = async () => {
    if (!parsed) return;
    if (mode === "replace" && !(await confirm({ title: t("استبدال كل البيانات الحالية؟", "Replace ALL current data?"), message: t("سيتم حذف بياناتك الحالية واستبدالها بمحتوى النسخة. إن فشل الاستيراد لن يتغير شيء.", "Your current data will be replaced by the backup. If the import fails, nothing changes."), danger: true, confirmLabel: t("استبدال", "Replace") }))) return;
    setBusy("import");
    try { await applyBackup(parsed, mode); toast(t("تم الاستيراد بنجاح", "Import complete")); setParsed(null); setTimeout(() => location.reload(), 600); } catch (e) { toast(errText(e), "err"); } finally { setBusy(null); }
  };
  const total = report?.quota && report.usage ? (report.usage / report.quota) * 100 : 0;
  const preview = parsed ? previewBackup(parsed) : null;
  const labels: Record<string, string> = { subjects: t("مواد", "Subjects"), lectures: t("محاضرات", "Lectures"), notes: t("ملاحظات", "Notes"), attachments: t("مرفقات", "Attachments"), flashcards: t("بطاقات", "Cards"), quizzes: t("اختبارات", "Quizzes"), references: t("مراجع", "References"), semesters: t("فصول", "Semesters") };

  return (
    <div className="max-w-3xl">
      <PageHeader title={t("الإعدادات", "Settings")} />
      <Section title={t("المظهر واللغة", "Appearance & language")} icon={<Sun size={18} />}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div><span className="text-xs font-semibold text-muted">{t("المظهر", "Theme")}</span><div className="mt-1.5 flex gap-2">{([["light", Sun, t("نهاري", "Light")], ["dark", Moon, t("ليلي", "Dark")], ["system", Monitor, t("النظام", "System")]] as const).map(([k, I, l]) => <button key={k} aria-pressed={prefs.theme === k} onClick={() => setPrefs({ theme: k })} className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl border px-3 py-2.5 text-sm font-bold ${prefs.theme === k ? "border-primary bg-primary text-primary-fg" : "border-line bg-surface"}`}><I size={15} />{l}</button>)}</div></div>
          <div><span className="text-xs font-semibold text-muted">{t("اللغة", "Language")}</span><div className="mt-1.5 flex gap-2">{([["ar", "العربية"], ["en", "English"]] as const).map(([k, l]) => <button key={k} aria-pressed={prefs.lang === k} onClick={() => setPrefs({ lang: k })} className={`flex-1 rounded-xl border px-3 py-2.5 text-sm font-bold ${prefs.lang === k ? "border-primary bg-primary text-primary-fg" : "border-line bg-surface"}`}>{l}</button>)}</div></div>
          <Field label={t("حجم النص", "Text size")}>{(id) => <Select id={id} value={prefs.textSize} onChange={(e) => setPrefs({ textSize: e.target.value as Prefs["textSize"] })}><option value="sm">{t("صغير", "Small")}</option><option value="md">{t("عادي", "Normal")}</option><option value="lg">{t("كبير", "Large")}</option><option value="xl">{t("كبير جداً", "Extra large")}</option></Select>}</Field>
          <label className="flex items-center gap-2 self-end pb-2 text-sm font-bold"><input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={prefs.reduceMotion} onChange={(e) => setPrefs({ reduceMotion: e.target.checked })} />{t("تقليل الحركة", "Reduce motion")}</label>
        </div>
      </Section>

      <Section title={t("المحرر والملفات", "Editor & files")} icon={<RefreshCw size={18} />}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("عدد النسخ المحفوظة لكل ملاحظة", "Versions kept per note")}>{(id) => <Input id={id} type="number" min={1} max={200} value={maxVersions ?? DEFAULT_MAX_VERSIONS} onChange={(e) => db.appSettings.put({ key: "maxVersions", value: Math.min(200, Math.max(1, Number(e.target.value) || 1)) })} />}</Field>
          <Field label={t("حد صفحات فهرسة PDF لكل دفعة", "PDF pages indexed per batch")}>{(id) => <Input id={id} type="number" min={50} max={20000} step={50} value={pdfIndexLimit ?? 1500} onChange={(e) => db.appSettings.put({ key: "pdfIndexLimit", value: Math.min(20000, Math.max(50, Math.round(Number(e.target.value) || 1500))) })} />}</Field>
          <label className="flex items-center gap-2 self-end pb-2 text-sm font-bold sm:col-span-2"><input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={!!keepOriginal} onChange={(e) => db.appSettings.put({ key: "keepOriginalImages", value: e.target.checked })} />{t("الاحتفاظ بالصور الأصلية (دون ضغط)", "Keep original images (no compression)")}</label>
        </div>
      </Section>

      <Section title={t("مساحة التخزين", "Storage")} icon={<HardDrive size={18} />}>
        {report && <>
          {report.quota && <div className="mb-4"><div className="mb-1 flex justify-between text-sm font-bold"><span>{t("المستخدم من المتاح", "Used of available")}</span><span dir="ltr">{formatBytes(report.usage ?? 0)} / {formatBytes(report.quota)}</span></div><ProgressBar value={total} color={total > 85 ? "var(--danger)" : "var(--accent)"} />{total > 85 && <p className="mt-1 text-xs font-bold text-danger">{t("المساحة تقترب من الحد — صدّر نسخة احتياطية.", "Storage is nearly full — export a backup.")}</p>}</div>}
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">{[[t("الملاحظات", "Notes"), report.notesBytes], [t("ملفات PDF", "PDF files"), report.pdfBytes], [t("الصور", "Images"), report.imageBytes], [t("الصوتيات", "Audio"), report.audioBytes], [t("النصوص", "Text"), report.textBytes], [t("المعاينات", "Previews"), report.previewBytes], [t("إجمالي بيانات التطبيق", "Total app data"), report.total]].map(([l, v]) => <div key={l as string} className="rounded-xl bg-surface2 p-3"><div className="font-black" dir="ltr">{formatBytes(v as number)}</div><div className="text-xs text-muted">{l}</div></div>)}</div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button onClick={async () => { toast((await requestPersistence()) ? t("التخزين الدائم مفعّل", "Persistent storage enabled") : t("لم يمنح المتصفح التخزين الدائم", "The browser did not grant persistent storage"), "info"); setReload((r) => r + 1); }}>{report.persisted ? t("التخزين الدائم ✓", "Persistent ✓") : t("طلب تخزين دائم", "Request persistent storage")}</Button>
            <Button onClick={async () => { const n = await cleanPreviews(); toast(t(`تم تنظيف ${n} معاينة (تُعاد عند الحاجة)`, `Cleared ${n} previews (regenerated on demand)`)); setReload((r) => r + 1); }}>{t("تنظيف المعاينات المؤقتة", "Clear temporary previews")}</Button>
            <Button disabled={!report.unlinked.count} onClick={async () => { if (await confirm({ title: t("حذف الملفات غير المرتبطة؟", "Delete unlinked files?"), message: t(`${report.unlinked.count} ملف (${formatBytes(report.unlinked.bytes)}) غير مرتبط بأي مادة أو محاضرة أو ملاحظة سيُحذف نهائياً.`, `${report.unlinked.count} file(s) (${formatBytes(report.unlinked.bytes)}) not linked to any subject, lecture or note will be deleted permanently.`), danger: true })) { const n = await deleteUnlinkedFiles(); toast(t(`حُذف ${n} ملف`, `${n} file(s) deleted`)); setReload((r) => r + 1); } }}>{t("حذف الملفات غير المرتبطة", "Delete unlinked files")} ({report.unlinked.count})</Button>
            <Button disabled={busy === "index"} onClick={async () => { setBusy("index"); await rebuildIndex(); setBusy(null); toast(t("تمت إعادة بناء فهرس البحث", "Search index rebuilt")); }}>{t("إعادة بناء فهرس البحث", "Rebuild search index")}</Button>
            <Button disabled={busy === "audit"} onClick={async () => {
              setBusy("audit");
              try {
                const res = await auditDatabaseIntegrity();
                setIntegrity(res);
                if (res.orphanBlobs === 0 && res.orphanRecords === 0 && res.missingBlobAttachments === 0) {
                  toast(t("قاعدة البيانات سليمة — لا توجد بقايا تالفة", "Database healthy — 0 orphan records found"));
                } else {
                  toast(t(`عُثر على ${res.orphanBlobs} كتلة يتيمة و ${res.orphanRecords} سجل معلق`, `Found ${res.orphanBlobs} orphan blob(s) and ${res.orphanRecords} dangling record(s)`), "info");
                }
              } finally { setBusy(null); }
            }}>{t("فحص سلامة قاعدة البيانات", "Check database integrity")}</Button>
            {integrity && (integrity.orphanBlobs > 0 || integrity.orphanRecords > 0) && (
              <Button variant="danger" disabled={busy === "cleanup"} onClick={async () => {
                setBusy("cleanup");
                try {
                  const res = await cleanupOrphans();
                  setIntegrity(await auditDatabaseIntegrity());
                  setReload((r) => r + 1);
                  toast(t(`تم تنظيف ${res.blobsRemoved} كتلة (${formatBytes(res.bytesReclaimed)}) و ${res.recordsRemoved} سجل يتيم`, `Cleaned ${res.blobsRemoved} blob(s) (${formatBytes(res.bytesReclaimed)}) and ${res.recordsRemoved} orphan record(s)`));
                } finally { setBusy(null); }
              }}>{t("تنظيف البقايا اليتيمة", "Clean orphan records")}</Button>
            )}
          </div>
          {integrity && (
            <div className="mt-3 rounded-xl bg-surface2 p-3 text-xs text-muted">
              {t(
                `نتيجة الفحص: ${integrity.orphanBlobs} كتلة غير مرتبطة (${formatBytes(integrity.orphanBlobBytes)}) · ${integrity.orphanRecords} سجل يتيم · ${integrity.missingBlobAttachments} مرفق مفقود`,
                `Integrity scan: ${integrity.orphanBlobs} orphan blob(s) (${formatBytes(integrity.orphanBlobBytes)}) · ${integrity.orphanRecords} orphan record(s) · ${integrity.missingBlobAttachments} missing attachment blob(s)`
              )}
            </div>
          )}
          <p className="mt-3 text-xs text-muted">{t("لا يحذف التطبيق أي ملف تلقائياً بسبب امتلاء المساحة.", "The app never deletes your files automatically when space runs low.")}</p></>}
      </Section>

      <Section title={t("النسخ الاحتياطي والاستعادة", "Backup & restore")} icon={<Archive size={18} />}>
        <p className="mb-3 text-sm text-muted">{t("نسخة ZIP تحتوي كل المواد والمحاضرات والملاحظات والملفات والبطاقات والمراجع والإعدادات. احتفظ بها في مكان آمن — بياناتك محفوظة على هذا الجهاز فقط.", "A ZIP with all subjects, lectures, notes, files, cards, references and settings. Keep it somewhere safe — your data lives only on this device.")}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={!!busy} onClick={() => void doExport()}><Download size={16} />{busy === "export" ? t("جارٍ التصدير…", "Exporting…") : t("تصدير نسخة كاملة", "Export full backup")}</Button>
          <Button disabled={!!busy} onClick={async () => { saveBlob(await exportNotesText(), "notevault-notes.zip"); }}><Download size={16} />{t("تصدير الملاحظات (Markdown)", "Export notes (Markdown)")}</Button>
          <Button disabled={!!busy} onClick={() => fileRef.current?.click()}><Upload size={16} />{busy === "parse" ? t("جارٍ الفحص…", "Checking…") : t("استيراد نسخة", "Import backup")}</Button>
          <input ref={fileRef} type="file" accept=".zip,application/zip" className="sr-only" aria-label={t("اختيار ملف نسخة احتياطية", "Choose backup file")} onChange={(e) => void pick(e.target.files?.[0])} />
        </div>
      </Section>

      <Section title={t("التثبيت على الجهاز", "Install on your device")} icon={<Smartphone size={18} />}>
        {inst.installed ? (
          <Badge color="#15803d">{t("التطبيق مثبّت ✓", "App installed ✓")}</Badge>
        ) : inst.canInstall ? (
          <Button variant="primary" onClick={() => void inst.install()}><Download size={16} />{t("تثبيت التطبيق", "Install app")}</Button>
        ) : inst.ios ? (
          <p className="text-sm text-muted">{t("على iPhone/iPad (Safari): اضغط زر المشاركة ⬆ ثم «إضافة إلى الشاشة الرئيسية».", "On iPhone/iPad (Safari): tap Share ⬆, then “Add to Home Screen”.")}</p>
        ) : inst.android ? (
          <p className="text-sm text-muted">{t("على Android (Chrome): افتح قائمة المتصفح (⋮) ثم «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية». بعد التحميل الأول يعمل دون اتصال.", "On Android (Chrome): open the browser menu (⋮) → “Install app” or “Add to Home Screen”. After the first load it works offline.")}</p>
        ) : (
          <p className="text-sm text-muted">{t("على سطح المكتب: اضغط أيقونة التثبيت في شريط العنوان أو قائمة المتصفح ← «تثبيت NoteVault Pro». بعد التحميل الأول يعمل دون اتصال.", "On desktop: click the install icon in the address bar or browser menu → “Install NoteVault Pro”. After the first load it works offline.")}</p>
        )}
      </Section>

      <Section title={t("الخصوصية", "Privacy")} icon={<ShieldCheck size={18} />}>
        <ul className="list-disc space-y-1 ps-5 text-sm text-muted"><li>{t("لا حساب ولا خادم: كل ملاحظاتك وملفاتك تبقى على جهازك.", "No account and no server: all notes and files stay on your device.")}</li><li>{t("لا تحليلات ولا تتبّع، ولا يُرسل أي محتوى إلى الإنترنت.", "No analytics or tracking, and no content is sent anywhere.")}</li><li>{t("تعتمد البيانات على تخزين المتصفح؛ مسح بيانات الموقع يحذفها — لذا صدّر نسخاً احتياطية دورية.", "Data lives in browser storage; clearing site data removes it — export backups regularly.")}</li></ul>
      </Section>

      <Modal open={!!parsed} onClose={() => setParsed(null)} title={t("معاينة الاستيراد", "Import preview")} footer={<><Button onClick={() => setParsed(null)}>{t("إلغاء", "Cancel")}</Button><Button variant={mode === "replace" ? "danger" : "primary"} disabled={busy === "import"} onClick={() => void doImport()}>{busy === "import" ? t("جارٍ الاستيراد…", "Importing…") : mode === "replace" ? t("استبدال", "Replace") : t("دمج", "Merge")}</Button></>}>
        {preview && <div className="space-y-4"><p className="text-sm text-muted">{t("تم التحقق من سلامة الملف وعلاقاته.", "The file and its relationships were verified.")} · {new Date(preview.createdAt).toLocaleString()}</p>
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">{preview.counts.map((c) => <div key={c.label} className="rounded-xl bg-surface2 p-3 text-center"><div className="text-xl font-black">{c.n}</div><div className="text-xs text-muted">{labels[c.label]}</div></div>)}</div>
          <div className="flex gap-2"><Chip active={mode === "merge"} onClick={() => setMode("merge")}>{t("دمج مع البيانات الحالية", "Merge with current data")}</Chip><Chip active={mode === "replace"} onClick={() => setMode("replace")}>{t("استبدال كل شيء", "Replace everything")}</Chip></div>
          <p className="text-xs text-muted">{mode === "merge" ? t("يبقى الأحدث تعديلاً عند وجود تعارض، ولا تُكرَّر العناصر.", "The most recently edited item wins on conflict; nothing is duplicated.") : t("تُحذف البيانات الحالية بعد تأكيدك. عند حدوث خطأ يُلغى الاستيراد كاملاً.", "Current data is removed after you confirm. On any error the whole import is rolled back.")}</p></div>}
      </Modal>
    </div>
  );
}
