import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devVarsFileFor, findProject, normalizeServer, readUserConfig, userConfigPath, validateEnvName, validateProjectName, writeUserConfig } from "../src/config.ts";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "secrets-cfg-")); });
afterEach(() => rm(dir, { recursive: true, force: true }));

test("finds .secrets.json in a parent dir", async () => {
  await writeFile(join(dir, ".secrets.json"), JSON.stringify({ project: "my-app" }));
  await mkdir(join(dir, "a", "b"), { recursive: true });
  expect(await findProject(join(dir, "a", "b"))).toEqual({ name: "my-app", root: dir, defaultEnv: "dev" });
});
test("returns null when no project file exists", async () => {
  expect(await findProject(dir)).toBeNull();
});
test("throws naming the file on invalid JSON or name", async () => {
  await writeFile(join(dir, ".secrets.json"), "{nope");
  await expect(findProject(dir)).rejects.toThrow(".secrets.json");
  await writeFile(join(dir, ".secrets.json"), JSON.stringify({ project: "../x" }));
  await expect(findProject(dir)).rejects.toThrow(".secrets.json");
});
test("accepts valid project names", () => {
  for (const n of ["a", "my-app", "a_b", "0x", "x".repeat(64)]) expect(validateProjectName(n)).toBe(true);
});
test.each(["../x", "A", "", "a/b", "x".repeat(65)])("rejects project name %p", (n) => expect(validateProjectName(n)).toBe(false));
test("normalizeServer", () => {
  expect(normalizeServer("https://bao.example.com/")).toBe("https://bao.example.com");
  expect(normalizeServer("https://bao.example.com/some/path")).toBe("https://bao.example.com");
  expect(normalizeServer("http://127.0.0.1:8200")).toBe("http://127.0.0.1:8200");
  expect(normalizeServer("http://localhost:8200/")).toBe("http://localhost:8200");
  expect(() => normalizeServer("http://bao.example.com")).toThrow();
  expect(() => normalizeServer("ftp://bao.example.com")).toThrow();
  expect(() => normalizeServer("not a url")).toThrow();
});
test("user config path honours XDG_CONFIG_HOME", () =>
  expect(userConfigPath({ XDG_CONFIG_HOME: "/x", HOME: "/h" })).toBe("/x/secrets/config.json"));
test("user config path falls back to ~/.config", () =>
  expect(userConfigPath({ HOME: "/h" })).toBe("/h/.config/secrets/config.json"));
test("readUserConfig returns null when missing", async () => {
  expect(await readUserConfig(join(dir, "none.json"))).toBeNull();
});
test("writeUserConfig creates the file with mode 0600 and round-trips", async () => {
  const p = join(dir, "sub", "secrets", "config.json");
  await writeUserConfig({ server: "https://bao.example.com" }, p);
  expect((await stat(p)).mode & 0o777).toBe(0o600);
  expect(await readUserConfig(p)).toEqual({ server: "https://bao.example.com" });
});

test("defaultEnv defaults to dev", async () => {
  await writeFile(join(dir, ".secrets.json"), JSON.stringify({ project: "p" }));
  expect((await findProject(dir))?.defaultEnv).toBe("dev");
});
test("defaultEnv is read from .secrets.json", async () => {
  await writeFile(join(dir, ".secrets.json"), JSON.stringify({ project: "p", defaultEnv: "local" }));
  expect((await findProject(dir))?.defaultEnv).toBe("local");
});
test("invalid defaultEnv throws naming the file", async () => {
  await writeFile(join(dir, ".secrets.json"), JSON.stringify({ project: "p", defaultEnv: "Staging!" }));
  await expect(findProject(dir)).rejects.toThrow(".secrets.json");
  await writeFile(join(dir, ".secrets.json"), JSON.stringify({ project: "p", defaultEnv: 3 }));
  await expect(findProject(dir)).rejects.toThrow(".secrets.json");
});
test("accepts valid env names", () => {
  for (const n of ["dev", "staging", "pr-12", "a_b", "x".repeat(32)]) expect(validateEnvName(n)).toBe(true);
});
test.each(["", "Dev", "a/b", "-x", "x".repeat(33)])("rejects env %p", (n) => expect(validateEnvName(n)).toBe(false));
test("devVarsFileFor maps the default env to .dev.vars", () => {
  const p = { name: "p", root: "/r", defaultEnv: "dev" };
  expect(devVarsFileFor(p, "dev")).toBe("/r/.dev.vars");
  expect(devVarsFileFor(p, "staging")).toBe("/r/.dev.vars.staging");
  expect(devVarsFileFor({ ...p, defaultEnv: "local" }, "local")).toBe("/r/.dev.vars");
  expect(devVarsFileFor({ ...p, defaultEnv: "local" }, "dev")).toBe("/r/.dev.vars.dev");
});
