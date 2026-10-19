import { expect, test } from "bun:test";
import { buildChildEnv, spawnWithSignals } from "../src/process.ts";

test("buildChildEnv: secrets override parent and flag is set", () => {
  const env = buildChildEnv({ A: "parent", B: "keep", GONE: undefined, CLOUDFLARE_INCLUDE_PROCESS_ENV: "false" }, { A: "secret", C: "new" });
  expect(env).toEqual({ A: "secret", B: "keep", C: "new", CLOUDFLARE_INCLUDE_PROCESS_ENV: "true" });
  expect("GONE" in env).toBe(false);
});

test("spawnWithSignals forwards SIGTERM", async () => {
  const before = process.listenerCount("SIGTERM");
  const beforeInt = process.listenerCount("SIGINT");
  const p = spawnWithSignals(["sh", "-c", 'trap "exit 42" TERM; sleep 5 & wait'], { PATH: process.env.PATH ?? "" }, process.cwd());
  await new Promise((r) => setTimeout(r, 200));
  process.emit("SIGTERM");
  expect(await p).toBe(42);
  expect(process.listenerCount("SIGTERM")).toBe(before);
  expect(process.listenerCount("SIGINT")).toBe(beforeInt);
});

test("spawnWithSignals returns the exit code", async () => {
  expect(await spawnWithSignals(["sh", "-c", "exit 3"], { PATH: process.env.PATH ?? "" }, process.cwd())).toBe(3);
});
