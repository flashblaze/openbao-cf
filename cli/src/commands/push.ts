import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { UsageError, guarded, loadContext } from "../context.ts";
import { diffKeys, formatDiff, isEmptyDiff } from "../diff.ts";
import { parseDevVars } from "../dotenv.ts";
import type { Io } from "../io.ts";

const USAGE = "secrets push [file] [--yes]";

export function push(args: string[], io: Io): Promise<number> {
  return guarded(io, USAGE, async () => {
    let yes = false;
    let file: string | undefined;
    for (const a of args) {
      if (a === "--yes" || a === "-y") yes = true;
      else if (a.startsWith("-")) throw new UsageError(`Unknown argument: ${a}`);
      else if (file === undefined) file = a;
      else throw new UsageError("Only one file may be given.");
    }
    const ctx = await loadContext(io);
    const path = file === undefined ? join(ctx.project.root, ".dev.vars") : isAbsolute(file) ? file : join(io.cwd, file);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        io.err(`${path} not found\n`);
        return 1;
      }
      throw e;
    }
    const parsed = parseDevVars(text);
    const client = await ctx.client();
    const current = (await client.readSecret(ctx.project.name)) ?? {};
    const diff = diffKeys(current, parsed);
    if (isEmptyDiff(diff)) {
      io.out("Nothing to change.\n");
      return 0;
    }
    io.out(`${formatDiff(diff)}\n`);
    if (!yes) {
      if (!io.isTTY) {
        io.err("not a terminal; pass --yes\n");
        return 1;
      }
      const n = diff.added.length + diff.changed.length + diff.removed.length;
      if (!(await io.confirm(`Write ${n} changes to ${ctx.project.name}?`))) {
        io.err("Aborted.\n");
        return 1;
      }
    }
    await client.writeSecret(ctx.project.name, parsed);
    io.out(`Pushed ${Object.keys(parsed).length} keys to ${ctx.project.name}.\n`);
    return 0;
  });
}
