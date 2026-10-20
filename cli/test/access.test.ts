import { expect, test } from "bun:test";
import { NotLoggedInError, accessLogin, extractJwt, getAccessToken, readCachedAccessToken } from "../src/access.ts";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Runner } from "../src/io.ts";

test("extractJwt", () => {
  expect(extractJwt("eyJa.bbb.ccc\n")).toBe("eyJa.bbb.ccc");
  expect(extractJwt('{"token":"eyJa.bbb.ccc"}')).toBe("eyJa.bbb.ccc");
  expect(extractJwt("no token here")).toBeNull();
});
test("extractJwt skips hostnames and versions before the token", () => {
  expect(extractJwt("bao.example.com 1.0.0-beta\neyJhbGci.eyJzdWI.sig_-1\n")).toBe("eyJhbGci.eyJzdWI.sig_-1");
  expect(extractJwt("bao.example.com 1.0.0-beta")).toBeNull();
});
test("SECRETS_ACCESS_JWT skips cf", async () => {
  const calls: string[][] = [];
  const run: Runner = async (cmd) => { calls.push(cmd); return { code: 0, stdout: "", stderr: "" }; };
  expect(await getAccessToken("https://bao.test", { env: { SECRETS_ACCESS_JWT: "x.y.z" }, run })).toBe("x.y.z");
  expect(calls).toEqual([]);
});
test("calls cf access token <server>", async () => {
  const calls: string[][] = [];
  const run: Runner = async (cmd) => { calls.push(cmd); return { code: 0, stdout: "eyJa.bbb.ccc\n", stderr: "" }; };
  expect(await getAccessToken("https://bao.test", { env: {}, run })).toBe("eyJa.bbb.ccc");
  expect(calls).toEqual([["cf", "access", "token", "https://bao.test"]]);
});
test("cf runs in a neutral cwd", async () => {
  const opts: unknown[] = [];
  const run: Runner = async (_cmd, o) => { opts.push(o); return { code: 0, stdout: "eyJa.bbb.ccc", stderr: "" }; };
  await getAccessToken("https://bao.test", { env: {}, run });
  expect(opts).toEqual([{ cwd: homedir() }]);
  const inherit: unknown[] = [];
  await accessLogin("https://bao.test", async (_c, o) => { inherit.push(o); return 0; });
  expect(inherit).toEqual([{ cwd: homedir() }]);
});
test("cf failure → NotLoggedInError", async () => {
  const run: Runner = async () => ({ code: 1, stdout: "", stderr: "" });
  const err = await getAccessToken("https://bao.test", { env: {}, run }).catch((e) => e);
  expect(err).toBeInstanceOf(NotLoggedInError);
  expect(err.message).toBe("Access session missing or expired. Run `secrets login`.");
});
test("cf failure with a real cause surfaces it, redacted", async () => {
  const run: Runner = async () => ({ code: 1, stdout: "", stderr: "noise\nBAO_HOSTNAME is required eyJabc.def.ghi\n\n" });
  const err = await getAccessToken("https://bao.test", { env: {}, run }).catch((e) => e);
  expect(err).not.toBeInstanceOf(NotLoggedInError);
  expect(err.message).toContain("BAO_HOSTNAME is required");
  expect(err.message).not.toContain("eyJ");
});
test("cf output without a JWT → NotLoggedInError", async () => {
  const run: Runner = async () => ({ code: 0, stdout: "please log in", stderr: "" });
  await expect(getAccessToken("https://bao.test", { env: {}, run })).rejects.toBeInstanceOf(NotLoggedInError);
});
test("accessLogin runs cf access login inherited, throws on failure", async () => {
  const calls: string[][] = [];
  await accessLogin("https://bao.test", async (cmd) => { calls.push(cmd); return 0; });
  expect(calls).toEqual([["cf", "access", "login", "https://bao.test"]]);
  await expect(accessLogin("https://bao.test", async () => 2)).rejects.toThrow("cf access login failed");
});

// A JWT-shaped token whose payload carries `exp` (seconds); the signature is irrelevant client-side.
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const tok = (exp: number, tag = "s") => `${b64({ alg: "RS256" })}.${b64({ exp, email: "o@x" })}.${tag}`;
const NOW = 1_800_000_000_000;
const inS = (s: number) => Math.floor(NOW / 1000) + s;
async function cache(files: Record<string, string>) {
  const home = await mkdtemp(join(tmpdir(), "secrets-cfd-"));
  await mkdir(join(home, ".cloudflared"));
  for (const [n, c] of Object.entries(files)) await writeFile(join(home, ".cloudflared", n), c);
  return home;
}

test("readCachedAccessToken returns the host's unexpired token", async () => {
  const t = tok(inS(3600));
  const home = await cache({ "bao.test-aud1-token": t, "bao.test-aud1-token.url": "https://x", "team.cloudflareaccess.com-org-token": "not a jwt" });
  expect(await readCachedAccessToken("https://bao.test", home, NOW)).toBe(t);
  await rm(home, { recursive: true });
});
test("readCachedAccessToken ignores expired and nearly expired tokens", async () => {
  const home = await cache({ "bao.test-a-token": tok(inS(-10)), "bao.test-b-token": tok(inS(30)) });
  expect(await readCachedAccessToken("https://bao.test", home, NOW)).toBeNull();
  await rm(home, { recursive: true });
});
test("readCachedAccessToken ignores other hosts and malformed files", async () => {
  const home = await cache({ "other.test-a-token": tok(inS(3600)), "bao.test-a-token": "garbage" });
  expect(await readCachedAccessToken("https://bao.test", home, NOW)).toBeNull();
  await rm(home, { recursive: true });
});
test("readCachedAccessToken picks the latest-expiring token", async () => {
  const later = tok(inS(7200), "later");
  const home = await cache({ "bao.test-a-token": tok(inS(3600), "sooner"), "bao.test-b-token": later });
  expect(await readCachedAccessToken("https://bao.test", home, NOW)).toBe(later);
  await rm(home, { recursive: true });
});
test("readCachedAccessToken without ~/.cloudflared is null", async () => {
  const home = await mkdtemp(join(tmpdir(), "secrets-cfd-"));
  expect(await readCachedAccessToken("https://bao.test", home, NOW)).toBeNull();
  await rm(home, { recursive: true });
});
test("getAccessToken uses the cached token without running cf", async () => {
  const t = tok(Math.floor(Date.now() / 1000) + 3600);
  const home = await cache({ "bao.test-a-token": t });
  const calls: string[][] = [];
  const run: Runner = async (cmd) => { calls.push(cmd); return { code: 0, stdout: "eyJa.bbb.ccc", stderr: "" }; };
  expect(await getAccessToken("https://bao.test", { env: { HOME: home }, run })).toBe(t);
  expect(calls).toEqual([]);
  await rm(home, { recursive: true });
});
test("getAccessToken falls back to cf when the cache is stale", async () => {
  const home = await cache({ "bao.test-a-token": tok(Math.floor(Date.now() / 1000) - 5) });
  const calls: string[][] = [];
  const run: Runner = async (cmd) => { calls.push(cmd); return { code: 0, stdout: "eyJa.bbb.ccc", stderr: "" }; };
  expect(await getAccessToken("https://bao.test", { env: { HOME: home }, run })).toBe("eyJa.bbb.ccc");
  expect(calls.length).toBe(1);
  await rm(home, { recursive: true });
});
