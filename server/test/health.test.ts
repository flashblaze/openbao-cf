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

import { startAndProbe, statusAndDrain } from "../src/health";

test("startAndProbe: start throwing means not ready, without probing", async () => {
  let probed = false;
  const ok = await startAndProbe({
    budgetMs: 30_000, intervalMs: 10,
    start: async () => { throw new Error("no instance"); },
    probe: async () => { probed = true; return 200; },
  });
  expect(ok).toBe(false);
  expect(probed).toBe(false);
});

test("startAndProbe: slow start eats into the probe budget", async () => {
  let t = 0;
  const seen: number[] = [];
  const ok = await startAndProbe({
    budgetMs: 30_000, intervalMs: 1_000, now: () => t, sleep: async (ms) => { t += ms; },
    start: async (timeout) => { seen.push(timeout); t += 25_000; },
    probe: async () => { t += 0; return 503; },
  });
  expect(seen).toEqual([30_000]);
  expect(ok).toBe(false);
  expect(t).toBeLessThanOrEqual(30_000 + 1_000);
});

test("startAndProbe: ready when probe succeeds", async () => {
  expect(await startAndProbe({ budgetMs: 1000, intervalMs: 1, start: async () => {}, probe: async () => 200 })).toBe(true);
});

test("startAndProbe: start consuming the whole budget is not ready", async () => {
  let t = 0;
  expect(await startAndProbe({ budgetMs: 100, intervalMs: 1, now: () => t,
    start: async () => { t += 100; }, probe: async () => 200 })).toBe(false);
});

test("statusAndDrain cancels the body and returns the status", async () => {
  let cancelled = false;
  const s = await statusAndDrain({ status: 200, body: { cancel: async () => { cancelled = true; } } });
  expect(s).toBe(200);
  expect(cancelled).toBe(true);
  expect(await statusAndDrain({ status: 501, body: null })).toBe(501);
});
