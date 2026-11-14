import "fake-indexeddb/auto";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/data/db";
import { applyBackup, BackupError, exportBackup, parseBackup } from "@/services/backup";
import { createSubject } from "@/services/library";
import { createNote } from "@/services/notes";

async function wipeAll() {
  for (const t of db.tables) await t.clear();
}

describe("Backup & Restore security hardening", () => {
  beforeEach(async () => {
    await wipeAll();
  });

  it("blocks DEFLATE ZIP bombs (high compression expansion ratio) during streaming parse", async () => {
    // 20 MiB of zeros compresses down to ~20 KiB in DEFLATE (ratio > 1000x)
    const bombPayload = new Uint8Array(20 * 1024 * 1024);
    const manifest = JSON.stringify({
      format: "notevault-backup",
      formatVersion: 1,
      dataVersion: 1,
      createdAt: Date.now(),
    });
    const zipBytes = zipSync(
      {
        "manifest.json": strToU8(manifest),
        "blobs/b1": bombPayload,
      },
      { level: 9 }
    );
    expect(zipBytes.byteLength).toBeLessThan(100 * 1024);
    await expect(parseBackup(zipBytes)).rejects.toMatchObject({ code: "too_large" });
  });

  it("detects tampered JSON tables via manifest tableHashes", async () => {
    await createSubject({ name: "Physics" });
    const exported = await exportBackup();
    const rawZip = new Uint8Array(await exported.arrayBuffer());
    const entries = unzipSync(rawZip);
    const notesJson = JSON.parse(strFromU8(entries["data/subjects.json"]));
    notesJson[0].name = "Tampered Physics";
    entries["data/subjects.json"] = strToU8(JSON.stringify(notesJson));
    const tampered = zipSync(entries);

    await expect(parseBackup(tampered)).rejects.toMatchObject({ code: "corrupt" });
  });

  it("rejects Zod-invalid records, unknown appSettings keys, and strips injected fields", async () => {
    const manifest = JSON.stringify({
      format: "notevault-backup",
      formatVersion: 1,
      dataVersion: 1,
      createdAt: 1000,
    });

    const badSettingZip = zipSync({
      "manifest.json": strToU8(manifest),
      "data/appSettings.json": strToU8(JSON.stringify([{ key: "evilKey", value: "x" }])),
    });
    await expect(parseBackup(badSettingZip)).rejects.toMatchObject({ code: "bad_record" });

    const badTypeZip = zipSync({
      "manifest.json": strToU8(manifest),
      "data/notes.json": strToU8(JSON.stringify([{ id: "n1", title: 9999 }])),
    });
    await expect(parseBackup(badTypeZip)).rejects.toMatchObject({ code: "bad_record" });

    // Subject with injected extra fields, CSS injection color, and SVG cover
    const injectedJson = JSON.stringify([
      {
        id: "s1",
        name: "Safe Subject",
        color: "red; background-image: url(https://evil.test)",
        cover: "data:image/svg+xml;base64,PHN2Zz4=",
        __injectedProp: "bad",
      },
    ]);
    const cleanZip = zipSync({
      "manifest.json": strToU8(manifest),
      "data/subjects.json": strToU8(injectedJson),
    });
    const parsed = await parseBackup(cleanZip);
    await applyBackup(parsed, "replace");
    const sub = (await db.subjects.get("s1"))!;
    expect(sub.color).toBe("#6366f1");
    expect(sub.cover).toBeUndefined();
    expect((sub as unknown as Record<string, unknown>).__injectedProp).toBeUndefined();
  });

  it("rejects spoofed attachment payloads (SVG disguised as PNG) without altering existing DB", async () => {
    await createNote({ title: "Existing Note" });
    const manifest = JSON.stringify({
      format: "notevault-backup",
      formatVersion: 1,
      dataVersion: 1,
      createdAt: 1000,
    });
    const svgAttack = strToU8('<svg onload="alert(1)"></svg>');
    const badAttZip = zipSync({
      "manifest.json": strToU8(manifest),
      "data/attachments.json": strToU8(
        JSON.stringify([
          {
            id: "a1",
            name: "photo.png",
            kind: "image",
            mime: "image/png",
            size: svgAttack.byteLength,
            blobId: "b1",
            thumb: 'data:image/jpeg;base64,AAAA") ; background: url(evil)',
          },
        ])
      ),
      "blobs/b1": svgAttack,
    });

    const parsed = await parseBackup(badAttZip);
    await expect(applyBackup(parsed, "replace")).rejects.toBeInstanceOf(BackupError);
    expect(await db.notes.count()).toBe(1);
    expect((await db.notes.toArray())[0].title).toBe("Existing Note");
  });
});
