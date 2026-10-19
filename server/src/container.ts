import { Container } from "@cloudflare/containers";
import { waitForReady } from "./health";
import type { Env } from "./env";

export class OpenBao extends Container<Env> {
  defaultPort = 8200;
  sleepAfter = "10m";
  private ready = false;

  async fetch(request: Request): Promise<Response> {
    await this.startAndWaitForPorts({
      startOptions: {
        envVars: {
          BAO_PG_CONNECTION_URL: this.env.NEON_DATABASE_URL,
          BAO_SEAL_KEY: this.env.BAO_SEAL_KEY,
        },
      },
    });
    if (!this.ready) {
      this.ready = await waitForReady(
        () => this.containerFetch("http://openbao/v1/sys/health").then((r) => r.status),
        { timeoutMs: 30_000, intervalMs: 500 },
      );
      if (!this.ready) {
        return Response.json({ error: "openbao not ready" }, { status: 503, headers: { "retry-after": "5" } });
      }
    }
    return this.containerFetch(request);
  }

  override onStop(): void {
    this.ready = false;
  }
}
