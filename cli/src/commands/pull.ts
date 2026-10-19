import { chmod, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { devVarsFileFor } from "../config.ts";
import { UsageError, guarded, loadContext, missingSecretsMessage, resolveEnv, takeEnvFlag } from "../context.ts";
import { serializeDevVars } from "../dotenv.ts";
import type { Io } from "../io.ts";

const USAGE = "secrets pull [--env <name>] [--force]";

export function pull(args: string[], io: Io): Promise<number> {
  return guarded(io, USAGE, async () => {
    const { env: flag, rest } = takeEnvFlag(args);
    let force = false;
    for (const a of rest) {
      if (a === "--force") force = true;
      else throw new UsageError(`Unknown argument: ${a}`);
    }
    const ctx = await loadContext(io);
    const env = resolveEnv(flag, ctx.project);
    const client = await ctx.client();
    const secret = await client.readSecret(ctx.project.name, env);
    if (secret === null) {
      io.err(`${await missingSecretsMessage(client, ctx.project, env)}\n`);
      return 1;
    }
    const path = devVarsFileFor(ctx.project, env);
    const name = basename(path);
    const text = serializeDevVars(secret); // throws before touching the file if lossy
    try {
      // "wx" fails atomically if the file exists; --force overwrites.
      await writeFile(path, text, { mode: 0o600, flag: force ? "w" : "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        io.err(`${path} exists; use --force\n`);
        return 1;
      }
      throw e;
    }
    await chmod(path, 0o600); // mode only applies to newly created files
    const ignored = await io.run(["git", "-C", ctx.project.root, "check-ignore", "-q", name]).catch(() => null);
    if (ignored && ignored.code === 1) io.err(`Warning: ${name} is not gitignored\n`);
    io.out(`Wrote ${Object.keys(secret).length} keys to ${path} (${env})\n`);
    return 0;
  });
}
