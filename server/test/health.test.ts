import { expect, test } from "bun:test";
import { classifyHealth, waitForReady } from "../src/health";

test.each([[200, "ready"], [501, "ready"], [503, "wait"], [500, "wait"], [429, "wait"], [null, "wait"]] as const)(
  "classifyHealth(%p) = %p", (s, v) => expect(classifyHealth(s)).toBe(v));

test("waits through connection errors and sealed", async () => {
  const seq = [null, 503, 200]; let calls = 0;
  const ok = await waitForReady(async () => seq[calls++], { timeoutMs: 10_000, intervalMs: 1, sleep: async () => {} });
  expect(ok).toBe(true); expect(calls).toBe(3);
});

test("times out", async () => {
  let t = 0;
  const ok = await waitForReady(async () => 503, { timeoutMs: 30_000, intervalMs: 500, now: () => t, sleep: async (ms) => { t += ms; } });
  expect(ok).toBe(false); expect(t).toBeGreaterThanOrEqual(30_000);
});

test("probes once even with zero timeout", async () => {
  expect(await waitForReady(async () => 200, { timeoutMs: 0, intervalMs: 1 })).toBe(true);
});
