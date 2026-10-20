import { NotLoggedInError, getAccessToken } from "./access.ts";
import { AccessDeniedError, BaoError, connect, type BaoClient } from "./bao.ts";
import { ProjectConfigError, findProject, readUserConfig, userConfigPath, validateEnvName, type Project } from "./config.ts";
import { UnrepresentableValueError } from "./dotenv.ts";
import type { Io } from "./io.ts";

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export type Context = { server: string; project: Project; client(accessJwt?: string): Promise<BaoClient> };

export type ServerContext = { server: string; client(accessJwt?: string): Promise<BaoClient> };

export async function loadServerContext(io: Io): Promise<ServerContext> {
  const cfg = await readUserConfig(userConfigPath(io.env));
  if (!cfg) throw new UsageError("Run `secrets login --server https://<host>` first.");
  const server = cfg.server;
  return {
    server,
    /** Pass `accessJwt` when the caller already fetched it, to avoid a second lookup. */
    async client(accessJwt?: string) {
      const jwt = accessJwt ?? (await getAccessToken(server, { env: io.env, run: io.run }));
      return connect(server, jwt, { fetch: io.fetch });
    },
  };
}

export async function loadContext(io: Io): Promise<Context> {
  const base = await loadServerContext(io);
  let project: Project | null;
  try {
    project = await findProject(io.cwd);
  } catch (e) {
    if (e instanceof ProjectConfigError) throw new UsageError(e.message);
    throw e;
  }
  if (!project) throw new UsageError("No .secrets.json found in this directory or any parent.");
  return { ...base, project };
}

export function noSecretsMessage(project: Project, env: string): string {
  const push = env === project.defaultEnv ? "secrets push" : `secrets push --env ${env}`;
  return `No secrets stored for project ${project.name} (${env}). Run \`${push}\` first.`;
}

export const legacyHint = (project: string) =>
  `Found secrets for ${project} stored before environments existed. Run \`secrets migrate\` to move them into the default environment.`;

/** True when `env` is the default and pre-environment data still sits at secret/<project>. */
export async function legacyPending(client: BaoClient, project: Project, env: string): Promise<boolean> {
  return env === project.defaultEnv && (await client.readLegacy(project.name)) !== null;
}

/** Message for an empty env: points to `secrets migrate` when only pre-environment data exists. */
export async function missingSecretsMessage(client: BaoClient, project: Project, env: string): Promise<string> {
  return (await legacyPending(client, project, env)) ? legacyHint(project.name) : noSecretsMessage(project, env);
}

/** Removes `--env X` / `--env=X` from args (callers pass only the part before `--`). */
export function takeEnvFlag(args: string[]): { env: string | undefined; rest: string[] } {
  let env: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    let value: string | undefined;
    if (a === "--env") value = args[++i] ?? "";
    else if (a.startsWith("--env=")) value = a.slice("--env=".length);
    else {
      rest.push(a);
      continue;
    }
    if (!value) throw new UsageError("--env needs a value");
    if (!validateEnvName(value)) throw new UsageError(`Invalid environment name: ${value}`);
    env = value;
  }
  return { env, rest };
}

export function resolveEnv(flag: string | undefined, project: Project): string {
  return flag ?? project.defaultEnv;
}

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
