import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { UsageError, guarded, loadContext, noSecretsMessage } from "../context.ts";
import { serializeDevVars } from "../dotenv.ts";
import type { Io } from "../io.ts";

const USAGE = "secrets pull [--force]";

export function pull(args: string[], io: Io): Promise<number> {
  return guarded(io, USAGE, async () => {
    let force = false;
    for (const a of args) {
      if (a === "--force") force = true;
      else throw new UsageError(`Unknown argument: ${a}`);
    }
    const ctx = await loadContext(io);
    const secret = await (await ctx.client()).readSecret(ctx.project.name);
    if (secret === null) {
      io.err(`${noSecretsMessage(ctx.project.name)}\n`);
      return 1;
    }
    const path = join(ctx.project.root, ".dev.vars");
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
    const ignored = await io.run(["git", "-C", ctx.project.root, "check-ignore", "-q", ".dev.vars"]).catch(() => null);
    if (ignored && ignored.code === 1) io.err("Warning: .dev.vars is not gitignored\n");
    io.out(`Wrote ${Object.keys(secret).length} keys to ${path}\n`);
    return 0;
  });
}
