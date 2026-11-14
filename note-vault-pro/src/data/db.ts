// Data Access Layer – Dexie schema. Bump versions and add .upgrade() for migrations.
import Dexie, { type Table } from "dexie";
import type * as T from "./types";

export const DATA_VERSION = 2;

export class VaultDB extends Dexie {
  semesters!: Table<T.Semester, string>;
  subjects!: Table<T.Subject, string>;
  lectures!: Table<T.Lecture, string>;
  notes!: Table<T.Note, string>;
  noteVersions!: Table<T.NoteVersion, string>;
  attachments!: Table<T.Attachment, string>;
  blobs!: Table<T.BlobRecord, string>;
  pdfDocuments!: Table<T.PdfDocument, string>;
  bookmarks!: Table<T.Bookmark, string>;
  highlights!: Table<T.Highlight, string>;
  annotations!: Table<T.Annotation, string>;
  flashcardDecks!: Table<T.FlashcardDeck, string>;
  flashcards!: Table<T.Flashcard, string>;
  reviewLogs!: Table<T.ReviewLog, string>;
  quizzes!: Table<T.Quiz, string>;
  quizQuestions!: Table<T.QuizQuestion, string>;
  quizAttempts!: Table<T.QuizAttempt, string>;
  references!: Table<T.Reference, string>;
  tags!: Table<T.Tag, string>;
  noteTags!: Table<T.NoteTag, string>;
  searchIndex!: Table<T.SearchDoc, string>;
  activities!: Table<T.Activity, string>;
  appSettings!: Table<T.Setting, string>;
  trashItems!: Table<T.TrashItem, string>;
  events!: Table<T.CalEvent, string>;

  constructor(name = "notevault-pro") {
    super(name);
    this.version(1).stores({
      semesters: "id, archived, startDate, updatedAt",
      subjects: "id, semesterId, archived, deletedAt, trashId, updatedAt",
      lectures: "id, subjectId, week, date, archived, deletedAt, trashId, updatedAt",
      notes: "id, subjectId, lectureId, kind, pinned, favorite, archived, deletedAt, trashId, updatedAt",
      noteVersions: "id, noteId, createdAt",
      attachments: "id, subjectId, lectureId, noteId, blobId, hash, kind, category, size, deletedAt, trashId, createdAt",
      blobs: "id",
      pdfDocuments: "id",
      bookmarks: "id, attachmentId",
      highlights: "id, attachmentId",
      annotations: "id, attachmentId",
      flashcardDecks: "id, subjectId",
      flashcards: "id, deckId, subjectId, due, state",
      reviewLogs: "id, cardId, reviewedAt",
      quizzes: "id, subjectId, semesterId",
      quizQuestions: "id, quizId",
      quizAttempts: "id, quizId, finishedAt",
      references: "id, subjectId, type",
      tags: "id, &name",
      noteTags: "id, noteId, tagId, [noteId+tagId]",
      searchIndex: "id, kind, refId, subjectId",
      activities: "id, createdAt",
      appSettings: "key",
      trashItems: "id, kind, deletedAt",
      events: "id, date, subjectId",
    });

    this.version(2)
      .stores({
        semesters: "id, archived, startDate, updatedAt",
        subjects: "id, semesterId, archived, deletedAt, trashId, updatedAt",
        lectures: "id, subjectId, week, date, archived, deletedAt, trashId, updatedAt",
        notes: "id, subjectId, lectureId, kind, pinned, favorite, archived, deletedAt, trashId, updatedAt",
        noteVersions: "id, noteId, createdAt",
        attachments: "id, subjectId, lectureId, noteId, blobId, hash, kind, category, size, deletedAt, trashId, createdAt",
        blobs: "id",
        pdfDocuments: "id, indexStatus",
        bookmarks: "id, attachmentId",
        highlights: "id, attachmentId",
        annotations: "id, attachmentId",
        flashcardDecks: "id, subjectId",
        flashcards: "id, deckId, subjectId, due, state, imageId",
        reviewLogs: "id, cardId, reviewedAt",
        quizzes: "id, subjectId, semesterId",
        quizQuestions: "id, quizId",
        quizAttempts: "id, quizId, finishedAt",
        references: "id, subjectId, type",
        tags: "id, &name",
        noteTags: "id, noteId, tagId, [noteId+tagId]",
        searchIndex: "id, kind, refId, subjectId",
        activities: "id, createdAt",
        appSettings: "key",
        trashItems: "id, kind, deletedAt",
        events: "id, date, subjectId",
      })
      .upgrade(async (tx) => {
        await tx
          .table("pdfDocuments")
          .toCollection()
          .modify((doc: T.PdfDocument) => {
            if (!doc.indexStatus) doc.indexStatus = doc.indexed ? "done" : "idle";
            if (typeof doc.indexedPages !== "number") doc.indexedPages = doc.indexed ? doc.pages : 0;
          });
        await tx.table("appSettings").put({ key: "schemaVersion", value: 2 });
      });
  }
}

export const db = new VaultDB();

/** Names of every table that participates in backup/restore. */
export const TABLE_NAMES = [
  "semesters", "subjects", "lectures", "notes", "noteVersions", "attachments", "blobs", "pdfDocuments",
  "bookmarks", "highlights", "annotations", "flashcardDecks", "flashcards", "reviewLogs", "quizzes",
  "quizQuestions", "quizAttempts", "references", "tags", "noteTags", "searchIndex", "activities",
  "appSettings", "trashItems", "events",
] as const;
export type TableName = (typeof TABLE_NAMES)[number];
