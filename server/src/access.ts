import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export type AccessConfig = { teamDomain: string; aud: string; ownerEmail: string };
export type AccessResult = { ok: true; email: string } | { ok: false; reason: string };

/** Error name plus jose's code and claim name when present; never the token or claim value. */
function rejectionReason(err: unknown): string {
  if (!(err instanceof Error)) return "verification failed";
  const { code, claim } = err as { code?: unknown; claim?: unknown };
  const parts = [err.name];
  if (typeof code === "string") parts.push(code);
  if (typeof claim === "string") parts.push(claim);
  return parts.join(":");
}

export async function verifyAccessJwt(
  token: string | null,
  cfg: AccessConfig,
  keys: JWTVerifyGetKey,
): Promise<AccessResult> {
  if (!cfg.teamDomain || !cfg.aud || !cfg.ownerEmail) return { ok: false, reason: "Access not configured" };
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
    return { ok: false, reason: rejectionReason(err) };
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

/** Builds the request verifier; the JWKS is created lazily so a missing team domain yields a 403, not a throw. */
export function makeVerifier(cfg: AccessConfig): (token: string | null) => Promise<AccessResult> {
  const keys: JWTVerifyGetKey = (header, input) => accessJwks(cfg.teamDomain)(header, input);
  return (token) => verifyAccessJwt(token, cfg, keys);
}
