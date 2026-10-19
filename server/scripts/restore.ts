// Usage: bun scripts/restore.ts <in.ndjson> <postgres-url>
// Restores a backup into an empty OpenBao PostgreSQL storage table. Refuses a non-empty table.
import { Client } from "pg";
import { ndjsonToRows } from "../src/backup";

// Schema copied from the OpenBao PostgreSQL storage docs.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS openbao_kv_store (
  parent_path TEXT COLLATE "C" NOT NULL,
  path        TEXT COLLATE "C",
  key         TEXT COLLATE "C",
  value       BYTEA,
  CONSTRAINT openbao_kv_store_pkey PRIMARY KEY (path, key)
)`,
  `CREATE INDEX IF NOT EXISTS openbao_kv_store_idx ON openbao_kv_store (parent_path)`,
];

const [file, url] = process.argv.slice(2);
if (!file || !url) {
  console.error("usage: restore.ts <in.ndjson> <postgres-url>");
  process.exit(2);
}
const rows = ndjsonToRows(await Bun.file(file).text());

const client = new Client({ connectionString: url });
await client.connect();
try {
  for (const sql of SCHEMA) await client.query(sql);
  const { rows: count } = await client.query<{ n: string }>("SELECT count(*)::text AS n FROM openbao_kv_store");
  if (count[0]!.n !== "0") {
    console.error("target table is not empty");
    process.exitCode = 1;
  } else {
    await client.query("BEGIN");
    try {
      for (const r of rows) {
        await client.query(
          "INSERT INTO openbao_kv_store (parent_path, path, key, value) VALUES ($1, $2, $3, $4)",
          [r.parent_path, r.path, r.key, r.value === null ? null : Buffer.from(r.value)],
        );
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
    console.log(`restored ${rows.length} rows`);
  }
} finally {
  await client.end();
}
