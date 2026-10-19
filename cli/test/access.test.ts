import { expect, test } from "bun:test";
import { NotLoggedInError, accessLogin, extractJwt, getAccessToken } from "../src/access.ts";
import type { Runner } from "../src/io.ts";

test("extractJwt", () => {
  expect(extractJwt("aaa.bbb.ccc\n")).toBe("aaa.bbb.ccc");
  expect(extractJwt('{"token":"aaa.bbb.ccc"}')).toBe("aaa.bbb.ccc");
  expect(extractJwt("no token here")).toBeNull();
});
test("SECRETS_ACCESS_JWT skips cf", async () => {
  const calls: string[][] = [];
  const run: Runner = async (cmd) => { calls.push(cmd); return { code: 0, stdout: "", stderr: "" }; };
  expect(await getAccessToken("https://bao.test", { env: { SECRETS_ACCESS_JWT: "x.y.z" }, run })).toBe("x.y.z");
  expect(calls).toEqual([]);
});
test("calls cf access token <server>", async () => {
  const calls: string[][] = [];
  const run: Runner = async (cmd) => { calls.push(cmd); return { code: 0, stdout: "aaa.bbb.ccc\n", stderr: "" }; };
  expect(await getAccessToken("https://bao.test", { env: {}, run })).toBe("aaa.bbb.ccc");
  expect(calls).toEqual([["cf", "access", "token", "https://bao.test"]]);
});
test("cf failure → NotLoggedInError", async () => {
  const run: Runner = async () => ({ code: 1, stdout: "", stderr: "boom" });
  const err = await getAccessToken("https://bao.test", { env: {}, run }).catch((e) => e);
  expect(err).toBeInstanceOf(NotLoggedInError);
  expect(err.message).toBe("Access session missing or expired. Run `secrets login`.");
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
