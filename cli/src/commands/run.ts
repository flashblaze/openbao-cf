import { access } from "node:fs/promises";
import { join } from "node:path";
import { UsageError, guarded, loadContext, noSecretsMessage, splitDashDash } from "../context.ts";
import type { Io } from "../io.ts";
import { buildChildEnv, spawnWithSignals } from "../process.ts";

const USAGE = "secrets run -- <command...>";

const exists = (p: string) => access(p).then(() => true, () => false);

export function run(args: string[], io: Io): Promise<number> {
  return guarded(io, USAGE, async () => {
    const { before, cmd } = splitDashDash(args);
    if (before.length > 0 || cmd.length === 0) throw new UsageError("Missing command after `--`.");
    const ctx = await loadContext(io);
    for (const dir of new Set([ctx.project.root, io.cwd])) {
      const p = join(dir, ".dev.vars");
      if (await exists(p)) {
        io.err(`Found .dev.vars at ${p}. Wrangler ignores injected secrets while it exists; delete it or use \`secrets pull\` instead.\n`);
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
