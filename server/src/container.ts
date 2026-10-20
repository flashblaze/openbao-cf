import { Container } from "@cloudflare/containers";
import { canSkipStart, startAndProbe, statusAndDrain } from "./health";
import type { Env } from "./env";

export class OpenBao extends Container<Env> {
  defaultPort = 8200;
  sleepAfter = "10m";
  private ready = false;

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    // Library-initiated restarts (e.g. inside containerFetch) fall back to this field.
    this.envVars = { BAO_PG_CONNECTION_URL: env.NEON_DATABASE_URL, BAO_SEAL_KEY: env.BAO_SEAL_KEY };
  }

  async fetch(request: Request): Promise<Response> {
    // Fast path: skip the library's per-request port ping and state write, which cost a
    // round trip to the container and serialise concurrent requests.
    if (canSkipStart({ ready: this.ready, running: this.ctx.container?.running === true })) {
      return this.containerFetch(request);
    }
    const budgetMs = 30_000;
    const started = await startAndProbe({
      budgetMs,
      intervalMs: 500,
      start: (timeoutMs) =>
        this.startAndWaitForPorts({
          startOptions: {
            envVars: {
              BAO_PG_CONNECTION_URL: this.env.NEON_DATABASE_URL,
              BAO_SEAL_KEY: this.env.BAO_SEAL_KEY,
            },
          },
          cancellationOptions: { portReadyTimeoutMS: timeoutMs },
        }),
      probe: () => this.containerFetch("http://openbao/v1/sys/health").then(statusAndDrain),
      onStartError: (err) =>
        console.warn(`container start failed: ${err instanceof Error ? `${err.name}: ${err.message}` : "unknown"}`),
    });
    if (!started) {
      return Response.json({ error: "openbao not ready" }, { status: 503, headers: { "retry-after": "5" } });
    }
    this.ready = true;
    return this.containerFetch(request);
  }

  override onStop(): void {
    this.ready = false;
  }
}
