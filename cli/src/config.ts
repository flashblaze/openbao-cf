import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { APP_NAME, PROJECT_FILE } from "./name.ts";

export type UserConfig = { server: string };
export type Project = { name: string; root: string };

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

export function validateProjectName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(name);
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
      let name: unknown;
      try {
        name = (JSON.parse(text) as { project?: unknown } | null)?.project;
      } catch {
        throw new Error(`${file} is not valid JSON`);
      }
      if (typeof name !== "string" || !validateProjectName(name)) {
        throw new Error(`${file} has an invalid "project" name (use lowercase letters, digits, "-" and "_", up to 64 chars)`);
      }
      return { name, root: dir };
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
