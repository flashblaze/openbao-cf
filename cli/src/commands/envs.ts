import { UsageError, guarded, legacyHint, loadContext } from "../context.ts";
import type { Io } from "../io.ts";

const USAGE = "secrets envs";

export function envs(args: string[], io: Io): Promise<number> {
  return guarded(io, USAGE, async () => {
    if (args.length > 0) throw new UsageError(`Unknown argument: ${args[0]}`);
    const ctx = await loadContext(io);
    const client = await ctx.client();
    const names = await client.listEnvs(ctx.project.name);
    if (names.length === 0) {
      io.out(`No environments for project ${ctx.project.name}.\n`);
      if ((await client.readLegacy(ctx.project.name)) !== null) io.err(`${legacyHint(ctx.project.name)}\n`);
      return 0;
    }
    for (const n of names) io.out(`${n === ctx.project.defaultEnv ? "* " : "  "}${n}\n`);
    return 0;
  });
}
