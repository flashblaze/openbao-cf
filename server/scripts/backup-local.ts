// Usage: bun scripts/backup-local.ts <postgres-url> <out.ndjson>
import { rowsToNdjson } from "../src/backup";
import { queryKvRows } from "../src/db";

const [url, out] = process.argv.slice(2);
if (!url || !out) {
  console.error("usage: backup-local.ts <postgres-url> <out.ndjson>");
  process.exit(2);
}
const rows = await queryKvRows(url);
await Bun.write(out, rowsToNdjson(rows));
console.log(`wrote ${rows.length} rows to ${out}`);
