import { accessLogin } from "../access.ts";
import { normalizeServer, readUserConfig, userConfigPath, writeUserConfig } from "../config.ts";
import { UsageError, guarded } from "../context.ts";
import type { Io } from "../io.ts";

const USAGE = "secrets login [--server <url>]";

export function login(args: string[], io: Io): Promise<number> {
  return guarded(io, USAGE, async () => {
    let url: string | undefined;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--server") url = args[++i];
      else throw new UsageError(`Unknown argument: ${args[i]}`);
    }
    const path = userConfigPath(io.env);
    if (url === undefined) {
      if (args.includes("--server")) throw new UsageError("--server needs a URL.");
      url = (await readUserConfig(path))?.server;
      if (!url) throw new UsageError("Run `secrets login --server https://<host>` first.");
    }
    const server = normalizeServer(url);
    await writeUserConfig({ server }, path);
    await accessLogin(server, io.runInherit);
    io.out(`Logged in to ${server}\n`);
    return 0;
  });
}
