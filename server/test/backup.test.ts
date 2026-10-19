import { expect, test } from "bun:test";
import { backupKey, keysToPrune, ndjsonToRows, rowsToNdjson, runBackup, type KvRow } from "../src/backup";

const row: KvRow = { parent_path: "/", path: "/core/", key: "keyring", value: Uint8Array.from([1, 2, 3]) };

function fakeBucket(existingKeys: string[]) {
  const puts: { key: string; body: string }[] = [];
  const deleted: string[] = [];
  return {
    puts,
    deleted,
    async put(key: string, body: string) {
      puts.push({ key, body });
      return {};
    },
    async list({ prefix }: { prefix: string }) {
      const keys = [...existingKeys, ...puts.map((p) => p.key)].filter((k) => k.startsWith(prefix));
      return { objects: keys.map((key) => ({ key })) };
    },
    async delete(keys: string[]) {
      deleted.push(...keys);
    },
  };
}

const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
test("round-trips binary values and nulls", () => {
  const rows = [{ parent_path: "/", path: "/core/", key: "keyring", value: bytes },
                { parent_path: "/core/", path: "/core/x/", key: "empty", value: null }];
  expect(ndjsonToRows(rowsToNdjson(rows))).toEqual(rows);
});
test("backupKey uses the UTC date", () => {
  expect(backupKey(new Date("2026-10-19T23:59:00Z"))).toBe("backups/2026-10-19.ndjson");
});
test("prunes only dated backups older than keepDays", () => {
  const keys = ["backups/2026-09-18.ndjson", "backups/2026-09-19.ndjson", "backups/2026-10-19.ndjson",
                "backups/notes.txt", "other/2020-01-01.ndjson"];
  expect(keysToPrune(keys, new Date("2026-10-19T03:17:00Z"), 30)).toEqual(["backups/2026-09-18.ndjson"]);
});
test("runBackup writes today's file then prunes", async () => {
  const bucket = fakeBucket(["backups/2026-09-01.ndjson"]);
  const r = await runBackup({ query: async () => [row], bucket, now: new Date("2026-10-19T03:17:00Z") });
  expect(r).toEqual({ key: "backups/2026-10-19.ndjson", rows: 1, pruned: ["backups/2026-09-01.ndjson"] });
  expect(bucket.puts.map(p => p.key)).toEqual(["backups/2026-10-19.ndjson"]);
});
test("runBackup refuses an empty table and touches nothing", async () => {
  const bucket = fakeBucket(["backups/2026-09-01.ndjson"]);
  await expect(runBackup({ query: async () => [], bucket, now: new Date() })).rejects.toThrow("empty table");
  expect(bucket.puts).toEqual([]); expect(bucket.deleted).toEqual([]);
});
