import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { suggestProjectName, validateEnvName, validateProjectName } from "../config.ts";
import { UsageError, guarded, takeEnvFlag } from "../context.ts";
import type { Io } from "../io.ts";
import { PROJECT_FILE } from "../name.ts";

const USAGE = "secrets init [--project <name>] [--env <default env>] [--force]";

/** The existing file's valid values, so `--force` only changes what was asked for. */
async function readExisting(path: string): Promise<{ project?: string; defaultEnv?: string }> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { project?: unknown; defaultEnv?: unknown } | null;
    return {
      project: typeof parsed?.project === "string" && validateProjectName(parsed.project) ? parsed.project : undefined,
      defaultEnv: typeof parsed?.defaultEnv === "string" && validateEnvName(parsed.defaultEnv) ? parsed.defaultEnv : undefined,
    };
  } catch {
    return {};
  }
}

/** Writes .secrets.json in the current directory. Local only: contacts nothing. */
export function init(args: string[], io: Io): Promise<number> {
  return guarded(io, USAGE, async () => {
    const { env, rest } = takeEnvFlag(args);
    let project: string | undefined;
    let force = false;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === "--force") force = true;
      else if (a === "--project" || a.startsWith("--project=")) {
        const value = a === "--project" ? rest[++i] : a.slice("--project=".length);
        if (!value || value.startsWith("-")) throw new UsageError("--project needs a value");
        project = value;
      } else throw new UsageError(`Unknown argument: ${a}`);
    }
    if (project !== undefined && !validateProjectName(project)) {
      throw new UsageError(`Invalid project name: ${project} (1-4 parts separated by "/", each lowercase letters, digits, "-" and "_")`);
    }
    if (env !== undefined && !validateEnvName(env)) throw new UsageError(`Invalid environment name: ${env}`);

    const path = join(io.cwd, PROJECT_FILE);
    const existing = force ? await readExisting(path) : {};
    const top = await io.run(["git", "-C", io.cwd, "rev-parse", "--show-toplevel"]).catch(() => null);
    const gitRoot = top && top.code === 0 ? top.stdout.trim() || null : null;
    const suggested = project === undefined && existing.project === undefined;
    const name = project ?? existing.project ?? suggestProjectName(gitRoot, io.cwd);
    const defaultEnv = env ?? existing.defaultEnv;

    const body = JSON.stringify(defaultEnv ? { project: name, defaultEnv } : { project: name }, null, 2) + "\n";
    try {
      await writeFile(path, body, { flag: force ? "w" : "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        io.err(`${path} exists; use --force to replace it\n`);
        return 1;
      }
      throw e;
    }
    io.out(`Created ${PROJECT_FILE} for project ${name}${defaultEnv ? ` (default env ${defaultEnv})` : ""}. Commit it with the code.\n`);
    if (suggested) io.out("Not the name you want? Run `secrets init --project <name> --force`.\n");
    if (gitRoot) {
      const ignored = await io.run(["git", "-C", io.cwd, "check-ignore", "-q", ".dev.vars"]).catch(() => null);
      if (ignored && ignored.code === 1) io.err("Warning: .dev.vars is not gitignored\n");
    }
    return 0;
  });
}
