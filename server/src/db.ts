import { Client } from "pg";
import type { KvRow } from "./backup";

export async function queryKvRows(databaseUrl: string): Promise<KvRow[]> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const res = await client.query<KvRow>(
      "SELECT parent_path, path, key, value FROM openbao_kv_store ORDER BY path, key",
    );
    return res.rows;
  } finally {
    await client.end();
  }
}
