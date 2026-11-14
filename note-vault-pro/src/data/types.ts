// Data Access Layer – record types. All records use UUID string ids and ms timestamps.
import type { JSONContent } from "@tiptap/core";

export type ID = string;
export interface Base {
  id: ID;
  createdAt: number;
  updatedAt: number;
}
export interface Trashable {
  deletedAt?: number;
  trashId?: ID;
}

export interface Semester extends Base {
  name: string;
  startDate: string;
  endDate: string;
  archived: boolean;
}
export interface Subject extends Base, Trashable {
  semesterId?: ID;
  name: string;
  code: string;
  description: string;
  color: string;
  cover?: string;
  teacher: string;
  credits?: number;
  archived: boolean;
  weeks: { n: number; label?: string }[];
}
export type ReviewStatus = "new" | "reviewing" | "mastered";
export interface Lecture extends Base, Trashable {
  subjectId: ID;
  week: number;
  title: string;
  date: string;
  description: string;
  keywords: string[];
  reviewStatus: ReviewStatus;
  progress: number;
  archived: boolean;
}
export interface Note extends Base, Trashable {
  subjectId?: ID;
  lectureId?: ID;
  title: string;
  content: JSONContent | null;
  text: string;
  wordCount: number;
  kind: "note" | "quick";
  pinned: boolean;
  favorite: boolean;
  archived: boolean;
}
export interface NoteVersion {
  id: ID;
  noteId: ID;
  title: string;
  content: JSONContent | null;
  text: string;
  hash: string;
  label?: string;
  createdAt: number;
}
export type FileKind = "pdf" | "image" | "audio" | "text" | "markdown";
export type FileCategory = "lecture" | "board" | "reference" | "assignment" | "other";
export interface Attachment extends Base, Trashable {
  name: string;
  kind: FileKind;
  mime: string;
  size: number;
  category: FileCategory;
  description: string;
  subjectId?: ID;
  lectureId?: ID;
  noteId?: ID;
  blobId: ID;
  hash: string;
  thumb?: string;
  originalSize?: number;
}
export interface BlobRecord {
  id: ID;
  blob: Blob;
}
export interface PdfDocument {
  id: ID; // = attachment id
  pages: number;
  indexedPages?: number;
  indexStatus?: "idle" | "indexing" | "paused" | "partial" | "done" | "error";
  lastPage: number;
  zoom: number;
  pageTexts: string[];
  indexed: boolean;
  updatedAt: number;
}
export interface Bookmark {
  id: ID;
  attachmentId: ID;
  page: number;
  label: string;
  createdAt: number;
}
export interface HighlightRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Highlight {
  id: ID;
  attachmentId: ID;
  page: number;
  text: string;
  color: string;
  rects?: HighlightRect[];
  createdAt: number;
}
export interface Annotation extends Base {
  attachmentId: ID;
  page: number;
  text: string;
}
export interface FlashcardDeck extends Base {
  name: string;
  description: string;
  subjectId?: ID;
}
export type CardType = "qa" | "term" | "cloze" | "compare" | "imageq" | "imagelabel" | "formula" | "multiface";
export interface CardSource {
  noteId?: ID;
  lectureId?: ID;
  attachmentId?: ID;
  page?: number;
}
export interface Flashcard extends Base {
  deckId: ID;
  subjectId?: ID;
  type: CardType;
  front: string;
  back: string;
  faces: string[];
  imageId?: ID;
  source?: CardSource;
  // FSRS state
  due: number;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
  learningSteps: number;
  reps: number;
  lapses: number;
  state: number;
  lastReview?: number;
  successCount: number;
  failCount: number;
}
export interface ReviewLog {
  id: ID;
  cardId: ID;
  rating: number;
  state: number;
  due: number;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
  reviewedAt: number;
}
export interface Quiz extends Base {
  title: string;
  description: string;
  subjectId?: ID;
  semesterId?: ID;
  durationMin: number;
  passScore: number;
  shuffle: boolean;
  mode: "exam" | "practice";
  questionCount: number;
}
export type QuestionType = "mcq" | "tf" | "short" | "cloze" | "match" | "order" | "image";
export interface QuizQuestion {
  id: ID;
  quizId: ID;
  order: number;
  type: QuestionType;
  prompt: string;
  options: string[]; // mcq options / correct sequence for "order"
  correct: number; // mcq index
  bool: boolean; // tf
  accepted: string[]; // short / image answers
  pairs: [string, string][]; // match
  explanation: string;
  imageId?: ID;
  points: number;
}
export interface QuestionResult {
  questionId: ID;
  type: QuestionType;
  correct: boolean;
  earned: number;
  points: number;
  answer: unknown;
}
export interface QuizAttempt {
  id: ID;
  quizId: ID;
  subjectId?: ID;
  startedAt: number;
  finishedAt: number;
  score: number;
  total: number;
  percent: number;
  passed: boolean;
  results: QuestionResult[];
}
export type RefType = "book" | "article" | "website" | "thesis" | "pdf" | "lecture" | "other";
export interface Reference extends Base {
  type: RefType;
  title: string;
  authors: string;
  publisher: string;
  year: string;
  url: string;
  accessed: string;
  doi: string;
  pages: string;
  notes: string;
  container: string;
  volume: string;
  issue: string;
  subjectId?: ID;
}
export interface Tag {
  id: ID;
  name: string;
  createdAt: number;
}
export interface NoteTag {
  id: ID;
  noteId: ID;
  tagId: ID;
}
export type SearchKind = "subject" | "lecture" | "note" | "file" | "pdf" | "card" | "reference";
export interface SearchDoc {
  id: string; // `${kind}:${refId}`
  kind: SearchKind;
  refId: ID;
  title: string;
  body: string;
  subjectId?: ID;
  lectureId?: ID;
  updatedAt: number;
}
export interface Activity {
  id: ID;
  kind: string;
  label: string;
  refKind?: string;
  refId?: ID;
  createdAt: number;
}
export interface Setting {
  key: string;
  value: unknown;
}
export type TrashKind = "subject" | "lecture" | "note" | "attachment";
export interface TrashItem {
  id: ID;
  kind: TrashKind;
  refId: ID;
  label: string;
  deletedAt: number;
}
export interface CalEvent extends Base {
  title: string;
  date: string;
  type: "exam" | "other";
  subjectId?: ID;
}

export type RecordingStatus = "recording" | "paused" | "finalizing" | "ready" | "error";
export type TranscriptionStatus = "idle" | "queued" | "transcribing" | "paused" | "done" | "error";

export interface LectureRecording extends Base, Trashable {
  subjectId?: ID;
  lectureId: ID;
  attachmentId?: ID;
  noteId?: ID;
  title: string;
  mime: string;
  ext: string;
  status: RecordingStatus;
  durationMs: number;
  chunkCount: number;
  totalBytes: number;
  deviceLabel?: string;
  transcriptionStatus: TranscriptionStatus;
  transcriptionLang: "auto" | "ar" | "en";
  transcriptionModelId?: string;
  transcriptionProgress: number;
  transcribedMs?: number;
  transcriptionError?: string;
  errorDetail?: string;
}

export interface RecordingChunk {
  id: ID;
  recordingId: ID;
  seq: number;
  blobId: ID;
  mime: string;
  size: number;
  durationMs: number;
  startMs: number;
  endMs: number;
  createdAt: number;
}

export interface RecordingMarker extends Base {
  recordingId: ID;
  timeMs: number;
  label: string;
  color?: string;
  noteId?: ID;
}

export interface TranscriptSegment extends Base {
  recordingId: ID;
  order: number;
  startMs: number;
  endMs: number;
  text: string;
  lang?: string;
  confidence?: number;
  editedManually: boolean;
}

export type AsrModelStatus = "not_installed" | "downloading" | "verifying" | "ready" | "error";

export interface AsrModelFileInfo {
  url: string;
  size: number;
  sha256: string;
}

export interface AsrModelRecord {
  id: string;
  name: string;
  repoId: string;
  languages: string[];
  sizeBytes: number;
  downloadedBytes: number;
  status: AsrModelStatus;
  fileHashes: Record<string, AsrModelFileInfo>;
  verifiedAt?: number;
  error?: string;
  updatedAt: number;
}

