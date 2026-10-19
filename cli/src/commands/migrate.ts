import { UsageError, guarded, loadContext } from "../context.ts";
import { diffKeys, formatDiff } from "../diff.ts";
import type { Io } from "../io.ts";

const USAGE = "secrets migrate [--yes]";

const sameVars = (a: Record<string, string>, b: Record<string, string>) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => Object.hasOwn(b, k) && b[k] === v);

/** Moves the pre-environments secret/<project> into the default env: copy, verify, then delete. */
export function migrate(args: string[], io: Io): Promise<number> {
  return guarded(io, USAGE, async () => {
    let yes = false;
    for (const a of args) {
      if (a === "--yes" || a === "-y") yes = true;
      else throw new UsageError(`Unknown argument: ${a}`);
    }
    const ctx = await loadContext(io);
    const { name } = ctx.project;
    const env = ctx.project.defaultEnv;
    const client = await ctx.client();
    const legacy = await client.readLegacy(name);
    if (legacy === null) {
      io.out("Nothing to migrate.\n");
      return 0;
    }
    if ((await client.readSecret(name, env)) !== null) {
      io.err(`${name} (${env}) already has secrets; resolve manually in the web UI.\n`);
      return 1;
    }
    const n = Object.keys(legacy).length;
    io.out(`${formatDiff(diffKeys({}, legacy))}\n`);
    if (!yes) {
      if (!io.isTTY) {
        io.err("not a terminal; pass --yes\n");
        return 1;
      }
      if (!(await io.confirm(`Move ${n} keys from ${name} to ${name} (${env}) and delete the old copy?`))) {
        io.err("Aborted.\n");
        return 1;
      }
    }
    await client.writeSecret(name, env, legacy);
    const copied = await client.readSecret(name, env);
    if (copied === null || !sameVars(copied, legacy)) {
      io.err("Copy verification failed; old secret kept.\n");
      return 1;
    }
    await client.deleteLegacy(name);
    io.out(`Migrated ${n} keys to ${name} (${env}).\n`);
    return 0;
  });
}
