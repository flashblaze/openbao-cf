import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export type AccessConfig = { teamDomain: string; aud: string; ownerEmail: string };
export type AccessResult = { ok: true; email: string } | { ok: false; reason: string };

export async function verifyAccessJwt(
  token: string | null,
  cfg: AccessConfig,
  keys: JWTVerifyGetKey,
): Promise<AccessResult> {
  if (!token) return { ok: false, reason: "missing Access token" };
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer: cfg.teamDomain,
      audience: cfg.aud,
      algorithms: ["RS256"],
    });
    const email = typeof payload.email === "string" ? payload.email : "";
    if (!email) return { ok: false, reason: "no email claim" };
    if (email.toLowerCase() !== cfg.ownerEmail.toLowerCase()) return { ok: false, reason: "email is not the owner" };
    return { ok: true, email };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.name : "verification failed" };
  }
}

const jwksByDomain = new Map<string, JWTVerifyGetKey>();

export function accessJwks(teamDomain: string): JWTVerifyGetKey {
  let keys = jwksByDomain.get(teamDomain);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    jwksByDomain.set(teamDomain, keys);
  }
  return keys;
}
