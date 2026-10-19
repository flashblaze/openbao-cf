export type KvRow = { parent_path: string; path: string; key: string; value: Uint8Array | null };

export type BackupBucket = {
  put(key: string, body: string): Promise<unknown>;
  list(opts: { prefix: string }): Promise<{ objects: { key: string }[] }>;
  delete(keys: string[]): Promise<void>;
};

export const BACKUP_PREFIX = "backups/";
export const KEEP_DAYS = 30;

const DATED_KEY = /^backups\/(\d{4}-\d{2}-\d{2})\.ndjson$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export function rowsToNdjson(rows: KvRow[]): string {
  return rows
    .map((r) =>
      JSON.stringify({
        parent_path: r.parent_path,
        path: r.path,
        key: r.key,
        value_b64: r.value === null ? null : Buffer.from(r.value).toString("base64"),
      }),
    )
    .map((line) => `${line}\n`)
    .join("");
}

export function ndjsonToRows(text: string): KvRow[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const o = JSON.parse(line) as { parent_path: string; path: string; key: string; value_b64: string | null };
      return {
        parent_path: o.parent_path,
        path: o.path,
        key: o.key,
        value: o.value_b64 === null ? null : new Uint8Array(Buffer.from(o.value_b64, "base64")),
      };
    });
}

export function backupKey(date: Date): string {
  return `${BACKUP_PREFIX}${date.toISOString().slice(0, 10)}.ndjson`;
}

export function keysToPrune(keys: string[], now: Date, keepDays: number): string[] {
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const cutoff = new Date(todayUtc - keepDays * DAY_MS).toISOString().slice(0, 10);
  // ISO dates compare correctly as strings.
  return keys.filter((k) => {
    const m = DATED_KEY.exec(k);
    return m !== null && m[1] < cutoff;
  });
}

export async function runBackup(deps: {
  query: () => Promise<KvRow[]>;
  bucket: BackupBucket;
  now: Date;
}): Promise<{ key: string; rows: number; pruned: string[] }> {
  const rows = await deps.query();
  if (rows.length === 0) throw new Error("refusing to back up an empty table");
  const key = backupKey(deps.now);
  await deps.bucket.put(key, rowsToNdjson(rows));
  const { objects } = await deps.bucket.list({ prefix: BACKUP_PREFIX });
  const pruned = keysToPrune(
    objects.map((o) => o.key),
    deps.now,
    KEEP_DAYS,
  );
  if (pruned.length > 0) await deps.bucket.delete(pruned);
  return { key, rows: rows.length, pruned };
}
