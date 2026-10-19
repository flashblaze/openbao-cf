import type { Io, Runner } from "./io.ts";

export class NotLoggedInError extends Error {
  constructor() {
    super("Access session missing or expired. Run `secrets login`.");
    this.name = "NotLoggedInError";
  }
}

const JWT_RE = /[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;

export function extractJwt(output: string): string | null {
  return JWT_RE.exec(output)?.[0] ?? null;
}

export async function getAccessToken(server: string, deps: { env: Io["env"]; run: Runner }): Promise<string> {
  const override = deps.env.SECRETS_ACCESS_JWT;
  if (override) return override;
  const { code, stdout } = await deps.run(["cf", "access", "token", server]);
  const jwt = code === 0 ? extractJwt(stdout) : null;
  if (!jwt) throw new NotLoggedInError();
  return jwt;
}

export async function accessLogin(server: string, runInherit: Io["runInherit"]): Promise<void> {
  const code = await runInherit(["cf", "access", "login", server]);
  if (code !== 0) throw new Error(`cf access login failed (exit ${code})`);
}
