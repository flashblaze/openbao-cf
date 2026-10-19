import { expect, test } from "bun:test";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { makeVerifier, verifyAccessJwt } from "../src/access";

const cfg = { teamDomain: "https://test.cloudflareaccess.com", aud: "test-aud", ownerEmail: "owner@example.com" };

const { publicKey, privateKey } = await generateKeyPair("RS256");
const { privateKey: otherPrivateKey } = await generateKeyPair("RS256");
const jwks = createLocalJWKSet({ keys: [await exportJWK(publicKey)] });

async function sign(claims: Record<string, unknown>, key: CryptoKey = privateKey, alg = "RS256") {
  const payload = {
    iss: cfg.teamDomain,
    aud: [cfg.aud],
    email: "owner@example.com",
    exp: Math.floor(Date.now() / 1000) + 300,
    ...claims,
  };
  return new SignJWT(payload as any).setProtectedHeader({ alg }).sign(key);
}

async function signHs256(claims: Record<string, unknown>) {
  const secret = new TextEncoder().encode("0123456789abcdef0123456789abcdef");
  return new SignJWT({ iss: cfg.teamDomain, aud: [cfg.aud], email: "owner@example.com", ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("5m")
    .sign(secret);
}

test("accepts a valid owner token", async () => {
  expect(await verifyAccessJwt(await sign({}), cfg, jwks)).toEqual({ ok: true, email: "owner@example.com" });
});

test("accepts owner email in different case", async () => {
  expect((await verifyAccessJwt(await sign({ email: "Owner@Example.com" }), cfg, jwks)).ok).toBe(true);
});

test.each([
  ["missing token", null],
  ["wrong audience", () => sign({ aud: ["other"] })],
  ["wrong issuer", () => sign({ iss: "https://evil.cloudflareaccess.com" })],
  ["expired", () => sign({ exp: Math.floor(Date.now() / 1000) - 60 })],
  ["other email", () => sign({ email: "someone@example.com" })],
  ["no email claim", () => sign({ email: undefined })],
  ["signed by another key", () => sign({}, otherPrivateKey)],
  ["HS256 token", () => signHs256({})],
] as const)("rejects %s", async (_, make) => {
  const token = typeof make === "function" ? await make() : make;
  expect((await verifyAccessJwt(token, cfg, jwks)).ok).toBe(false);
});

test.each([
  ["teamDomain", undefined],
  ["teamDomain", ""],
  ["aud", undefined],
  ["aud", ""],
  ["ownerEmail", undefined],
  ["ownerEmail", ""],
] as const)("rejects when cfg.%s is %p", async (field, value) => {
  const bad = { ...cfg, [field]: value } as unknown as typeof cfg;
  expect(await verifyAccessJwt(await sign({ aud: ["some-other-app"] }), bad, jwks)).toEqual({
    ok: false,
    reason: "Access not configured",
  });
});

test("rejection reasons name the failing claim, not its value", async () => {
  const aud = await verifyAccessJwt(await sign({ aud: ["other"] }), cfg, jwks);
  expect(aud).toEqual({ ok: false, reason: "JWTClaimValidationFailed:ERR_JWT_CLAIM_VALIDATION_FAILED:aud" });
  const iss = await verifyAccessJwt(await sign({ iss: "https://evil.cloudflareaccess.com" }), cfg, jwks);
  expect(iss.ok).toBe(false);
  expect(!iss.ok && iss.reason).toMatch(/:iss$/);
  expect(!iss.ok && iss.reason).not.toContain("evil");
});

test("makeVerifier with an empty team domain returns not-configured instead of throwing", async () => {
  const verify = makeVerifier({ ...cfg, teamDomain: "" });
  expect(await verify(await sign({}))).toEqual({ ok: false, reason: "Access not configured" });
});
