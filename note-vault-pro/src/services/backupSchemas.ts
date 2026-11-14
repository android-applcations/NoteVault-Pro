// Strict Zod schemas for NoteVault Pro backup manifest & every persisted table.
import { z } from "zod";
import type { TableName } from "@/data/db";
import { safeUrl } from "@/domain/sanitize";

// Disable Zod v4 JIT `new Function()` probes so strict CSP never reports `script-src:eval`.
z.config({ jitless: true });

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const idSchema = z.string().regex(ID_RE);
export const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const dataImageSchema = z.string().max(3_000_000).regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/);
const shortStr = (max = 512) => z.string().max(max);
const longStr = (max = 2_000_000) => z.string().max(max);
const ts = z.number().finite().min(0);
const defTs = ts.optional().default(() => Date.now());
const optTs = ts.optional();
const optId = idSchema.optional();
const dateStr = z.string().max(32);

export const BackupManifestSchema = z.object({
  format: z.literal("notevault-backup"),
  formatVersion: z.number().int().min(1).max(100),
  dataVersion: z.number().int().min(1).max(100),
  app: shortStr(100).optional(),
  createdAt: ts,
  counts: z.record(z.string().max(40), z.number().int().min(0).max(500_000)).optional(),
  blobs: z.number().int().min(0).max(500_000).optional(),
  tableHashes: z.record(z.string().max(40), z.string().regex(/^[0-9a-f]{64}$/)).optional(),
});

const SemesterSchema = z.object({
  id: idSchema,
  name: shortStr(300).min(1),
  startDate: dateStr.optional().default(""),
  endDate: dateStr.optional().default(""),
  archived: z.boolean().optional().default(false),
  createdAt: defTs,
  updatedAt: defTs,
});

const SubjectSchema = z.object({
  id: idSchema,
  semesterId: optId,
  name: shortStr(300).min(1),
  code: shortStr(64).optional().default(""),
  description: shortStr(5000).optional().default(""),
  color: hexColorSchema.catch("#6366f1"),
  cover: dataImageSchema.optional().catch(undefined),
  teacher: shortStr(200).optional().default(""),
  credits: z.number().finite().min(0).max(100).optional(),
  archived: z.boolean().optional().default(false),
  weeks: z.array(z.object({ n: z.number().int().min(1).max(200), label: shortStr(200).optional() })).max(200).optional().default([]),
  createdAt: defTs,
  updatedAt: defTs,
  deletedAt: optTs,
  trashId: optId,
});

const LectureSchema = z.object({
  id: idSchema,
  subjectId: idSchema,
  week: z.number().int().min(1).max(200).optional().default(1),
  title: shortStr(300).min(1),
  date: dateStr.optional().default(""),
  description: shortStr(10_000).optional().default(""),
  keywords: z.array(shortStr(120)).max(200).optional().default([]),
  reviewStatus: z.enum(["new", "reviewing", "mastered"]).optional().default("new"),
  progress: z.number().finite().min(0).max(100).optional().default(0),
  archived: z.boolean().optional().default(false),
  createdAt: defTs,
  updatedAt: defTs,
  deletedAt: optTs,
  trashId: optId,
});

const NoteSchema = z.object({
  id: idSchema,
  subjectId: optId,
  lectureId: optId,
  title: shortStr(500),
  content: z.unknown().nullable().optional().default(null),
  text: longStr(5_000_000).optional().default(""),
  wordCount: z.number().int().min(0).optional().default(0),
  kind: z.enum(["note", "quick"]).optional().default("note"),
  pinned: z.boolean().optional().default(false),
  favorite: z.boolean().optional().default(false),
  archived: z.boolean().optional().default(false),
  createdAt: defTs,
  updatedAt: defTs,
  deletedAt: optTs,
  trashId: optId,
});

const NoteVersionSchema = z.object({
  id: idSchema,
  noteId: idSchema,
  title: shortStr(500).optional().default(""),
  content: z.unknown().nullable().optional().default(null),
  text: longStr(5_000_000).optional().default(""),
  hash: shortStr(128).optional().default(""),
  label: shortStr(200).optional(),
  createdAt: defTs,
});

const AttachmentSchema = z.object({
  id: idSchema,
  name: shortStr(300).min(1),
  kind: z.enum(["pdf", "image", "audio", "text", "markdown"]),
  mime: shortStr(128).optional().default("application/octet-stream"),
  size: z.number().int().min(0).max(500 * 1024 * 1024).optional().default(0),
  category: z.enum(["lecture", "board", "reference", "assignment", "other"]).optional().default("other"),
  description: shortStr(5000).optional().default(""),
  subjectId: optId,
  lectureId: optId,
  noteId: optId,
  blobId: idSchema,
  hash: shortStr(128).optional().default(""),
  thumb: dataImageSchema.optional().catch(undefined),
  originalSize: z.number().int().min(0).optional(),
  createdAt: defTs,
  updatedAt: defTs,
  deletedAt: optTs,
  trashId: optId,
});

const PdfDocumentSchema = z.object({
  id: idSchema,
  pages: z.number().int().min(0).max(50_000),
  indexedPages: z.number().int().min(0).max(50_000).optional(),
  indexStatus: z.enum(["idle", "indexing", "paused", "partial", "done", "error"]).optional(),
  lastPage: z.number().int().min(1).max(50_000),
  zoom: z.number().finite().min(0.1).max(10),
  pageTexts: z.array(longStr(200_000)).max(50_000),
  indexed: z.boolean(),
  updatedAt: defTs,
});

const BookmarkSchema = z.object({
  id: idSchema,
  attachmentId: idSchema,
  page: z.number().int().min(1).max(50_000),
  label: shortStr(300).optional().default(""),
  createdAt: defTs,
});

const HighlightRectSchema = z.object({
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
  w: z.number().finite().min(0).max(1),
  h: z.number().finite().min(0).max(1),
});

const HighlightSchema = z.object({
  id: idSchema,
  attachmentId: idSchema,
  page: z.number().int().min(1).max(50_000),
  text: shortStr(20_000),
  color: hexColorSchema.catch("#fde047"),
  rects: z.array(HighlightRectSchema).max(500).optional(),
  createdAt: defTs,
});

const AnnotationSchema = z.object({
  id: idSchema,
  attachmentId: idSchema,
  page: z.number().int().min(1).max(50_000),
  text: shortStr(20_000),
  createdAt: defTs,
  updatedAt: defTs,
});

const FlashcardDeckSchema = z.object({
  id: idSchema,
  name: shortStr(300).min(1),
  description: shortStr(2000).optional().default(""),
  subjectId: optId,
  createdAt: defTs,
  updatedAt: defTs,
});

const FlashcardSchema = z.object({
  id: idSchema,
  deckId: idSchema,
  subjectId: optId,
  type: z.enum(["qa", "term", "cloze", "compare", "imageq", "imagelabel", "formula", "multiface"]),
  front: shortStr(10_000),
  back: shortStr(20_000).optional().default(""),
  faces: z.array(shortStr(10_000)).max(20).optional().default([]),
  imageId: optId,
  source: z
    .object({
      noteId: optId,
      lectureId: optId,
      attachmentId: optId,
      page: z.number().int().min(1).max(50_000).optional(),
    })
    .optional(),
  due: z.number().finite(),
  stability: z.number().finite().min(0),
  difficulty: z.number().finite().min(0),
  elapsedDays: z.number().finite().min(0),
  scheduledDays: z.number().finite().min(0),
  learningSteps: z.number().int().min(0),
  reps: z.number().int().min(0),
  lapses: z.number().int().min(0),
  state: z.number().int().min(0).max(10),
  lastReview: optTs,
  successCount: z.number().int().min(0),
  failCount: z.number().int().min(0),
  createdAt: defTs,
  updatedAt: defTs,
});

const ReviewLogSchema = z.object({
  id: idSchema,
  cardId: idSchema,
  rating: z.number().int().min(1).max(4),
  state: z.number().int().min(0).max(10),
  due: z.number().finite(),
  stability: z.number().finite().min(0),
  difficulty: z.number().finite().min(0),
  elapsedDays: z.number().finite().min(0),
  scheduledDays: z.number().finite().min(0),
  reviewedAt: ts,
});

const QuizSchema = z.object({
  id: idSchema,
  title: shortStr(300).min(1),
  description: shortStr(5000).optional().default(""),
  subjectId: optId,
  semesterId: optId,
  durationMin: z.number().finite().min(0).max(1440),
  passScore: z.number().finite().min(0).max(100),
  shuffle: z.boolean(),
  mode: z.enum(["exam", "practice"]),
  questionCount: z.number().int().min(0).max(5000),
  createdAt: defTs,
  updatedAt: defTs,
});

const QuizQuestionSchema = z.object({
  id: idSchema,
  quizId: idSchema,
  order: z.number().int().min(0).max(10_000),
  type: z.enum(["mcq", "tf", "short", "cloze", "match", "order", "image"]),
  prompt: shortStr(10_000),
  options: z.array(shortStr(2000)).max(50).optional().default([]),
  correct: z.number().int().min(0).max(50).optional().default(0),
  bool: z.boolean().optional().default(true),
  accepted: z.array(shortStr(1000)).max(100).optional().default([]),
  pairs: z.array(z.tuple([shortStr(1000), shortStr(1000)])).max(50).optional().default([]),
  explanation: shortStr(10_000).optional().default(""),
  imageId: optId,
  points: z.number().finite().min(0).max(1000),
});

const QuestionResultSchema = z.object({
  questionId: idSchema,
  type: z.enum(["mcq", "tf", "short", "cloze", "match", "order", "image"]),
  correct: z.boolean(),
  earned: z.number().finite().min(0),
  points: z.number().finite().min(0),
  answer: z
    .union([z.string().max(5000), z.number().finite(), z.boolean(), z.array(z.string().max(5000)).max(50), z.null()])
    .optional(),
});

const QuizAttemptSchema = z.object({
  id: idSchema,
  quizId: idSchema,
  subjectId: optId,
  startedAt: ts,
  finishedAt: ts,
  score: z.number().finite().min(0),
  total: z.number().finite().min(0),
  percent: z.number().finite().min(0).max(100),
  passed: z.boolean(),
  results: z.array(QuestionResultSchema).max(5000),
});

const ReferenceSchema = z.object({
  id: idSchema,
  type: z.enum(["book", "article", "website", "thesis", "pdf", "lecture", "other"]),
  title: shortStr(500).min(1),
  authors: shortStr(2000).optional().default(""),
  publisher: shortStr(500).optional().default(""),
  year: shortStr(16).optional().default(""),
  url: shortStr(2048)
    .transform((u) => (u.trim() ? safeUrl(u) ?? "" : ""))
    .optional()
    .default(""),
  accessed: shortStr(64).optional().default(""),
  doi: shortStr(256).optional().default(""),
  pages: shortStr(64).optional().default(""),
  notes: shortStr(20_000).optional().default(""),
  container: shortStr(500).optional().default(""),
  volume: shortStr(64).optional().default(""),
  issue: shortStr(64).optional().default(""),
  subjectId: optId,
  createdAt: defTs,
  updatedAt: defTs,
});

const TagSchema = z.object({
  id: idSchema,
  name: shortStr(120).min(1),
  createdAt: defTs,
});

const NoteTagSchema = z.object({
  id: idSchema,
  noteId: idSchema,
  tagId: idSchema,
});

const ActivitySchema = z.object({
  id: idSchema,
  kind: shortStr(64).min(1),
  label: shortStr(300),
  refKind: shortStr(64).optional(),
  refId: optId,
  createdAt: defTs,
});

const PrefsValueSchema = z.object({
  lang: z.enum(["ar", "en"]),
  theme: z.enum(["light", "dark", "system"]),
  reduceMotion: z.boolean(),
  textSize: z.enum(["sm", "md", "lg", "xl"]),
});

const AppSettingSchema = z.discriminatedUnion("key", [
  z.object({ key: z.literal("prefs"), value: PrefsValueSchema }),
  z.object({ key: z.literal("maxVersions"), value: z.number().int().min(1).max(200) }),
  z.object({ key: z.literal("pdfIndexLimit"), value: z.number().int().min(50).max(20_000) }),
  z.object({ key: z.literal("keepOriginalImages"), value: z.boolean() }),
  z.object({ key: z.literal("recentSearches"), value: z.array(shortStr(200)).max(20) }),
  z.object({ key: z.literal("schemaVersion"), value: z.number().int().min(1).max(100) }),
  z.object({ key: z.literal("asrDefaultModel"), value: shortStr(120) }),
  z.object({ key: z.literal("asrDefaultLang"), value: z.enum(["auto", "ar", "en"]) }),
  z.object({ key: z.literal("recorderPreferredDevice"), value: shortStr(128) }),
]);

const TrashItemSchema = z.object({
  id: idSchema,
  kind: z.enum(["subject", "lecture", "note", "attachment"]),
  refId: idSchema,
  label: shortStr(300),
  deletedAt: ts,
});

const CalEventSchema = z.object({
  id: idSchema,
  title: shortStr(300).min(1),
  date: dateStr,
  type: z.enum(["exam", "other"]),
  subjectId: optId,
  createdAt: defTs,
  updatedAt: defTs,
});

const RecordingSchema = z.object({
  id: idSchema,
  subjectId: optId,
  lectureId: idSchema,
  attachmentId: optId,
  noteId: optId,
  title: shortStr(300).min(1),
  mime: shortStr(128).optional().default("audio/webm"),
  ext: shortStr(16).optional().default("webm"),
  status: z.enum(["recording", "paused", "finalizing", "ready", "error"]).optional().default("ready"),
  durationMs: z.number().finite().min(0).max(86_400_000).optional().default(0),
  chunkCount: z.number().int().min(0).max(100_000).optional().default(0),
  totalBytes: z.number().int().min(0).max(1024 * 1024 * 1024).optional().default(0),
  deviceLabel: shortStr(200).optional(),
  transcriptionStatus: z.enum(["idle", "queued", "transcribing", "paused", "done", "error"]).optional().default("idle"),
  transcriptionLang: z.enum(["auto", "ar", "en"]).optional().default("auto"),
  transcriptionModelId: shortStr(120).optional(),
  transcriptionProgress: z.number().finite().min(0).max(100).optional().default(0),
  transcribedMs: z.number().finite().min(0).max(86_400_000).optional(),
  transcriptionError: shortStr(500).optional(),
  errorDetail: shortStr(500).optional(),
  createdAt: defTs,
  updatedAt: defTs,
  deletedAt: optTs,
  trashId: optId,
});

const RecordingChunkSchema = z.object({
  id: idSchema,
  recordingId: idSchema,
  seq: z.number().int().min(0).max(100_000),
  blobId: idSchema,
  mime: shortStr(128).optional().default("audio/webm"),
  size: z.number().int().min(0).max(200 * 1024 * 1024),
  durationMs: z.number().finite().min(0).max(3_600_000).optional().default(0),
  startMs: z.number().finite().min(0).max(86_400_000).optional().default(0),
  endMs: z.number().finite().min(0).max(86_400_000).optional().default(0),
  createdAt: defTs,
});

const RecordingMarkerSchema = z.object({
  id: idSchema,
  recordingId: idSchema,
  timeMs: z.number().finite().min(0).max(86_400_000),
  label: shortStr(300).optional().default(""),
  color: hexColorSchema.optional().catch(undefined),
  noteId: optId,
  createdAt: defTs,
  updatedAt: defTs,
});

const TranscriptSegmentSchema = z.object({
  id: idSchema,
  recordingId: idSchema,
  order: z.number().int().min(0).max(500_000),
  startMs: z.number().finite().min(0).max(86_400_000),
  endMs: z.number().finite().min(0).max(86_400_000),
  text: shortStr(10_000),
  lang: shortStr(16).optional(),
  confidence: z.number().finite().min(0).max(1).optional(),
  editedManually: z.boolean().optional().default(false),
  createdAt: defTs,
  updatedAt: defTs,
});

const AsrModelFileInfoSchema = z.object({
  url: shortStr(512),
  size: z.number().int().min(0),
  sha256: shortStr(128),
});

const AsrModelSchema = z.object({
  id: idSchema,
  name: shortStr(200).min(1),
  repoId: shortStr(200),
  languages: z.array(shortStr(16)).max(100).optional().default([]),
  sizeBytes: z.number().int().min(0),
  downloadedBytes: z.number().int().min(0).optional().default(0),
  status: z.enum(["not_installed", "downloading", "verifying", "ready", "error"]),
  fileHashes: z.record(shortStr(200), AsrModelFileInfoSchema).optional().default({}),
  verifiedAt: optTs,
  error: shortStr(500).optional(),
  updatedAt: defTs,
});

export const TABLE_SCHEMAS: Partial<Record<TableName, z.ZodTypeAny>> = {
  semesters: SemesterSchema,
  subjects: SubjectSchema,
  lectures: LectureSchema,
  notes: NoteSchema,
  noteVersions: NoteVersionSchema,
  attachments: AttachmentSchema,
  pdfDocuments: PdfDocumentSchema,
  bookmarks: BookmarkSchema,
  highlights: HighlightSchema,
  annotations: AnnotationSchema,
  flashcardDecks: FlashcardDeckSchema,
  flashcards: FlashcardSchema,
  reviewLogs: ReviewLogSchema,
  quizzes: QuizSchema,
  quizQuestions: QuizQuestionSchema,
  quizAttempts: QuizAttemptSchema,
  references: ReferenceSchema,
  tags: TagSchema,
  noteTags: NoteTagSchema,
  activities: ActivitySchema,
  appSettings: AppSettingSchema,
  trashItems: TrashItemSchema,
  events: CalEventSchema,
  recordings: RecordingSchema,
  recordingChunks: RecordingChunkSchema,
  recordingMarkers: RecordingMarkerSchema,
  transcriptSegments: TranscriptSegmentSchema,
  asrModels: AsrModelSchema,
};
