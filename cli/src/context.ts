import { NotLoggedInError, getAccessToken } from "./access.ts";
import { AccessDeniedError, BaoError, connect, type BaoClient } from "./bao.ts";
import { findProject, readUserConfig, userConfigPath, type Project } from "./config.ts";
import { UnrepresentableValueError } from "./dotenv.ts";
import type { Io } from "./io.ts";

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export type Context = { server: string; project: Project; client(): Promise<BaoClient> };

export async function loadContext(io: Io): Promise<Context> {
  const cfg = await readUserConfig(userConfigPath(io.env));
  if (!cfg) throw new UsageError("Run `secrets login --server https://<host>` first.");
  const project = await findProject(io.cwd);
  if (!project) throw new UsageError("No .secrets.json found in this directory or any parent.");
  const server = cfg.server;
  return {
    server,
    project,
    async client() {
      const jwt = await getAccessToken(server, { env: io.env, run: io.run });
      return connect(server, jwt, { fetch: io.fetch });
    },
  };
}

export const noSecretsMessage = (project: string) =>
  `No secrets stored for project ${project}. Run \`secrets push\` first.`;

/** Maps thrown errors to exit codes: usage -> 2 (with hint), everything else -> 1. */
export async function guarded(io: Io, usage: string, fn: () => Promise<number>): Promise<number> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`${e.message}\nUsage: ${usage}\n`);
      return 2;
    }
    if (
      e instanceof NotLoggedInError ||
      e instanceof AccessDeniedError ||
      e instanceof BaoError ||
      e instanceof UnrepresentableValueError ||
      e instanceof Error
    ) {
      io.err(`${e.message}\n`);
      return 1;
    }
    io.err(`${String(e)}\n`);
    return 1;
  }
}

/** Splits `args` at the first `--`. */
export function splitDashDash(args: string[]): { before: string[]; cmd: string[] } {
  const i = args.indexOf("--");
  return i === -1 ? { before: args, cmd: [] } : { before: args.slice(0, i), cmd: args.slice(i + 1) };
}
