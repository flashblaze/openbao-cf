import { constants } from "node:os";
import type { Io } from "./io.ts";

export function buildChildEnv(parent: Io["env"], secrets: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(parent)) if (v !== undefined) env[k] = v;
  Object.assign(env, secrets);
  env.CLOUDFLARE_INCLUDE_PROCESS_ENV = "true";
  return env;
}

export async function spawnWithSignals(cmd: string[], env: Record<string, string>, cwd: string): Promise<number> {
  const child = Bun.spawn(cmd, { env, cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const forward = (sig: NodeJS.Signals) => () => void child.kill(sig);
  const onInt = forward("SIGINT");
  const onTerm = forward("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  try {
    const code = await child.exited;
    const sig = child.signalCode;
    if (sig) return 128 + (typeof sig === "number" ? sig : (constants.signals[sig] ?? 0));
    return code;
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  }
}
