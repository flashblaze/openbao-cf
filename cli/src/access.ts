import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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

const MIN_LIFETIME_MS = 60_000;

function expiresAtMs(jwt: string): number | null {
  try {
    const exp = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"))?.exp;
    return typeof exp === "number" ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * cloudflared caches the app token at ~/.cloudflared/<host>-<aud>-token. Reading it directly skips
 * `cf`/`cloudflared`, whose token command makes a network round trip first. Returns the
 * latest-expiring token with at least a minute left, or null. The server still verifies it.
 */
export async function readCachedAccessToken(server: string, home: string, now = Date.now()): Promise<string | null> {
  const host = new URL(server).hostname;
  const dir = join(home, ".cloudflared");
  const names = await readdir(dir).catch(() => [] as string[]);
  let best: { jwt: string; exp: number } | null = null;
  for (const name of names) {
    if (!name.startsWith(`${host}-`) || !name.endsWith("-token")) continue;
    const jwt = extractJwt(await readFile(join(dir, name), "utf8").catch(() => ""));
    const exp = jwt ? expiresAtMs(jwt) : null;
    if (jwt && exp !== null && exp - now >= MIN_LIFETIME_MS && (!best || exp > best.exp)) best = { jwt, exp };
  }
  return best?.jwt ?? null;
}

export async function getAccessToken(server: string, deps: { env: Io["env"]; run: Runner }): Promise<string> {
  const override = deps.env.SECRETS_ACCESS_JWT;
  if (override) return override;
  if (deps.env.HOME) {
    const cached = await readCachedAccessToken(server, deps.env.HOME);
    if (cached) return cached;
  }
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
