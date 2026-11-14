// Application services – bibliographic references (user supplied data only).
import { db } from "@/data/db";
import type { Reference } from "@/data/types";
import { safeUrl } from "@/domain/sanitize";
import { logActivity, uid } from "./core";
import { reindex } from "./search";

export type RefInput = Omit<Reference, "id" | "createdAt" | "updatedAt">;

export const emptyRef = (): RefInput => ({
  type: "book", title: "", authors: "", publisher: "", year: "", url: "", accessed: "", doi: "", pages: "", notes: "", container: "", volume: "", issue: "",
});

function validate(r: RefInput) {
  if (!r.title.trim()) throw new Error("NAME_REQUIRED");
  if (r.year && !/^\d{4}[a-z]?$/.test(r.year.trim())) throw new Error("BAD_YEAR");
  if (r.url && r.url.trim() && !safeUrl(r.url)) throw new Error("BAD_URL");
}

export async function saveReference(input: RefInput, id?: string): Promise<Reference> {
  validate(input);
  const t = Date.now();
  const clean: RefInput = Object.fromEntries(Object.entries(input).map(([k, v]) => [k, typeof v === "string" ? v.trim() : v])) as unknown as RefInput;
  if (id) {
    const ex = await db.references.get(id);
    if (!ex) throw new Error("NOT_FOUND");
    const r: Reference = { ...ex, ...clean, updatedAt: t };
    await db.references.put(r);
    await reindex("reference", id);
    return r;
  }
  const r: Reference = { ...clean, id: uid(), createdAt: t, updatedAt: t };
  await db.references.add(r);
  await reindex("reference", r.id);
  await logActivity("create", r.title, "reference", r.id);
  return r;
}

export async function deleteReference(id: string) {
  await db.references.delete(id);
  await reindex("reference", id);
}
