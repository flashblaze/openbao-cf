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
