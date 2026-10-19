import { homedir } from "node:os";
import type { Io, Runner } from "./io.ts";

export class NotLoggedInError extends Error {
  constructor() {
    super("Access session missing or expired. Run `secrets login`.");
    this.name = "NotLoggedInError";
  }
}

const JWT_RE = /eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;

export function extractJwt(output: string): string | null {
  return JWT_RE.exec(output)?.[0] ?? null;
}

function cfFailure(stderr: string): Error {
  const last = stderr.split("\n").map((l) => l.trim()).filter(Boolean).pop();
  if (!last || /log ?in|token|expire/i.test(last)) return new NotLoggedInError();
  return new Error(`cf access token failed: ${last.replace(/eyJ[A-Za-z0-9_.-]*/g, "[redacted]")}`);
}

export async function getAccessToken(server: string, deps: { env: Io["env"]; run: Runner }): Promise<string> {
  const override = deps.env.SECRETS_ACCESS_JWT;
  if (override) return override;
  // Neutral cwd: cf evaluates the nearest cloudflare.config.ts, which must not be the caller's project.
  const { code, stdout, stderr } = await deps.run(["cf", "access", "token", server], { cwd: homedir() });
  if (code !== 0) throw cfFailure(stderr);
  const jwt = extractJwt(stdout);
  if (!jwt) throw new NotLoggedInError();
  return jwt;
}

export async function accessLogin(server: string, runInherit: Io["runInherit"]): Promise<void> {
  const code = await runInherit(["cf", "access", "login", server], { cwd: homedir() });
  if (code !== 0) throw new Error(`cf access login failed (exit ${code})`);
}
