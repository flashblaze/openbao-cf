import { getAccessToken } from "../access.ts";
import { UsageError, guarded, loadServerContext, splitDashDash } from "../context.ts";
import type { Io } from "../io.ts";
import { buildChildEnv, spawnWithSignals } from "../process.ts";

const USAGE = "secrets proxy [--login] -- <command...>";

const HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade",
]);

function stripHeaders(h: Headers, extra: string[]): Headers {
  const out = new Headers(h);
  const listed = (h.get("connection") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const name of [...HOP, ...listed, ...extra]) out.delete(name);
  return out;
}

export function proxy(args: string[], io: Io): Promise<number> {
  return guarded(io, USAGE, async () => {
    const { before, cmd } = splitDashDash(args);
    if (cmd.length === 0) throw new UsageError("Missing command after `--`.");
    let withLogin = false;
    for (const a of before) {
      if (a === "--login") withLogin = true;
      else throw new UsageError(`Unknown argument: ${a}`);
    }
    const ctx = await loadServerContext(io);
    const jwt = await getAccessToken(ctx.server, { env: io.env, run: io.run });
    const env: Record<string, string> = {};
    if (withLogin) env.BAO_TOKEN = (await ctx.client()).token;

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      // Bun's default 10 s idle timeout drops requests during a container cold start
      // (the Worker may wait up to 30 s for OpenBao), so allow well past that.
      idleTimeout: 120,
      async fetch(req) {
        // Reject DNS-rebinding callers: only loopback Host values may use the injected JWT.
        const host = (req.headers.get("host") ?? "").toLowerCase();
        if (host !== `127.0.0.1:${server.port}` && host !== `localhost:${server.port}`) {
          return new Response("forbidden host\n", { status: 403 });
        }
        const url = new URL(req.url);
        const headers = stripHeaders(req.headers, ["host", "content-length"]);
        headers.set("cf-access-token", jwt);
        const hasBody = req.method !== "GET" && req.method !== "HEAD";
        try {
          const res = await io.fetch(`${ctx.server}${url.pathname}${url.search}`, {
            method: req.method,
            headers,
            body: hasBody ? await req.arrayBuffer() : undefined,
            redirect: "manual",
          });
          // fetch has already decoded the body, so drop the encoding and length headers.
          return new Response(res.body, {
            status: res.status,
            statusText: res.statusText,
            headers: stripHeaders(res.headers, ["content-encoding", "content-length"]),
          });
        } catch (e) {
          return new Response(`proxy error: ${(e as Error).message}\n`, { status: 502 });
        }
      },
    });
    try {
      env.BAO_ADDR = `http://127.0.0.1:${server.port}`;
      return await spawnWithSignals(cmd, buildChildEnv(io.env, env), io.cwd);
    } finally {
      await server.stop(true);
    }
  });
}
