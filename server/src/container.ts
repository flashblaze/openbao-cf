import { Container } from "@cloudflare/containers";
import { startAndProbe, statusAndDrain } from "./health";
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
      // After the first success the readiness probe is skipped, but start still runs every request.
      probe: () =>
        this.ready
          ? Promise.resolve(200)
          : this.containerFetch("http://openbao/v1/sys/health").then(statusAndDrain),
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
