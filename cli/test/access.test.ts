import { expect, test } from "bun:test";
import { NotLoggedInError, accessLogin, extractJwt, getAccessToken } from "../src/access.ts";
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
