import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { UsageError, guarded, loadContext, noSecretsMessage, splitDashDash } from "../context.ts";
import type { Io } from "../io.ts";
import { buildChildEnv, spawnWithSignals } from "../process.ts";

const USAGE = "secrets run -- <command...>";

const isDevVars = (n: string) => n === ".dev.vars" || n.startsWith(".dev.vars.");
const findDevVars = async (dir: string) =>
  (await readdir(dir).catch(() => [] as string[])).filter(isDevVars).sort()[0];

export function run(args: string[], io: Io): Promise<number> {
  return guarded(io, USAGE, async () => {
    const { before, cmd } = splitDashDash(args);
    if (before.length > 0 || cmd.length === 0) throw new UsageError("Missing command after `--`.");
    const ctx = await loadContext(io);
    for (const dir of new Set([ctx.project.root, io.cwd])) {
      const found = await findDevVars(dir);
      if (found) {
        const p = join(dir, found);
        io.err(`Found ${found} at ${p}. Wrangler ignores injected secrets while it exists; delete it or use \`secrets pull\` instead.\n`);
        return 1;
      }
    }
    const secret = await (await ctx.client()).readSecret(ctx.project.name);
    if (secret === null) {
      io.err(`${noSecretsMessage(ctx.project.name)}\n`);
      return 1;
    }
    return spawnWithSignals(cmd, buildChildEnv(io.env, secret), io.cwd);
  });
}
