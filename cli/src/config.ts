import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { APP_NAME, DEFAULT_ENV, PROJECT_FILE } from "./name.ts";

export type UserConfig = { server: string };

/** A problem with the project's .secrets.json (reported as a usage error). */
export class ProjectConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectConfigError";
  }
}
export type Project = { name: string; root: string; defaultEnv: string };

export function userConfigPath(env: Record<string, string | undefined>): string {
  const base = env.XDG_CONFIG_HOME || join(env.HOME ?? "", ".config");
  return join(base, APP_NAME, "config.json");
}

export async function readUserConfig(path: string): Promise<UserConfig | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  const server = (parsed as { server?: unknown } | null)?.server;
  if (typeof server !== "string") throw new Error(`${path} has no "server" string`);
  return { server };
}

export async function writeUserConfig(cfg: UserConfig, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  await chmod(path, 0o600); // writeFile's mode only applies to new files
}

const SEGMENT = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_SEGMENTS = 4;

/** A project name is 1-4 `/`-separated segments (e.g. `instaclock/api`), stored at secret/<name>/<env>. */
export function validateProjectName(name: string): boolean {
  const parts = name.split("/");
  return parts.length <= MAX_SEGMENTS && parts.every((p) => SEGMENT.test(p));
}

function toSegment(raw: string): string {
  const s = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^[-_]+/, "").replace(/-+$/, "").slice(0, 64);
  return s || "project";
}

/** `<repo>/<folder>` inside a git repo (just `<repo>` at its root), else the folder's own name. */
export function suggestProjectName(gitRoot: string | null, cwd: string): string {
  const here = resolve(cwd);
  if (!gitRoot) return toSegment(basename(here));
  const root = resolve(gitRoot);
  const repo = toSegment(basename(root));
  return here === root ? repo : `${repo}/${toSegment(basename(here))}`;
}

export function validateEnvName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(name);
}

/** The project's default env reads/writes .dev.vars; any other env X uses .dev.vars.X (as `wrangler dev --env X` does). */
export function devVarsFileFor(project: Project, env: string): string {
  return join(project.root, env === project.defaultEnv ? ".dev.vars" : `.dev.vars.${env}`);
}

export async function findProject(startDir: string): Promise<Project | null> {
  let dir = startDir;
  for (;;) {
    const file = join(dir, PROJECT_FILE);
    let text: string | null = null;
    try {
      text = await readFile(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (text !== null) {
      let parsed: { project?: unknown; defaultEnv?: unknown } | null;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new ProjectConfigError(`${file} is not valid JSON`);
      }
      const name = parsed?.project;
      if (typeof name !== "string" || !validateProjectName(name)) {
        throw new ProjectConfigError(`${file} has an invalid "project" name (1-4 parts separated by "/", each lowercase letters, digits, "-" and "_", up to 64 chars)`);
      }
      const defaultEnv = parsed?.defaultEnv ?? DEFAULT_ENV;
      if (typeof defaultEnv !== "string" || !validateEnvName(defaultEnv)) {
        throw new ProjectConfigError(
          `${file} has an invalid "defaultEnv": ${JSON.stringify(defaultEnv)} (use lowercase letters, digits, "-" and "_", up to 32 chars)`,
        );
      }
      return { name, root: dir, defaultEnv };
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function normalizeServer(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`Invalid server URL: ${url}`);
  }
  const local = u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
  if (u.protocol !== "https:" && !local) throw new Error("Server URL must use https://");
  return u.origin;
}
