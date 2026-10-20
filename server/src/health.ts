export type WaitOptions = {
  timeoutMs: number;
  intervalMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

// 501 means OpenBao is up but not initialized yet, which the first-run setup needs.
export function classifyHealth(status: number | null): "ready" | "wait" {
  return status === 200 || status === 501 ? "ready" : "wait";
}

export async function waitForReady(
  probe: () => Promise<number | null>,
  opts: WaitOptions,
): Promise<boolean> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const start = now();
  for (;;) {
    let status: number | null;
    try {
      status = await probe();
    } catch {
      status = null;
    }
    if (classifyHealth(status) === "ready") return true;
    if (now() - start >= opts.timeoutMs) return false;
    await sleep(opts.intervalMs);
  }
}

// Reads the status and cancels the body so the container library's in-flight
// counter is released (otherwise sleepAfter may never fire).
export async function statusAndDrain(res: { status: number; body: { cancel(): Promise<void> } | null }): Promise<number> {
  const status = res.status;
  await res.body?.cancel();
  return status;
}

export type StartAndProbeOptions = {
  budgetMs: number;
  intervalMs: number;
  start: (timeoutMs: number) => Promise<void>;
  probe: () => Promise<number | null>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onStartError?: (err: unknown) => void;
};

// Start the container and wait for readiness within one budget. Never throws.
export async function startAndProbe(opts: StartAndProbeOptions): Promise<boolean> {
  const now = opts.now ?? Date.now;
  const begin = now();
  try {
    await opts.start(opts.budgetMs);
  } catch (err) {
    opts.onStartError?.(err);
    return false;
  }
  const remaining = opts.budgetMs - (now() - begin);
  if (remaining <= 0) return false;
  return waitForReady(opts.probe, { timeoutMs: remaining, intervalMs: opts.intervalMs, now: opts.now, sleep: opts.sleep });
}

// A request may go straight to OpenBao only when it was confirmed ready since the
// container last started and the container is still running. Otherwise run the
// start + readiness path (which also re-supplies the env vars).
export function canSkipStart(state: { ready: boolean; running: boolean }): boolean {
  return state.ready && state.running;
}
