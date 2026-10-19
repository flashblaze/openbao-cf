export type Scripted = { status: number; body?: unknown; headers?: Record<string, string> };
export type Logged = { method: string; path: string; headers: Headers; body: unknown };
export type FakeBao = { url: string; requests: Logged[]; queue: Scripted[]; stop(): void };

/** Fake OpenBao: plays `queue` responses in order (200 `{}` once empty) and logs every request. */
export function startFakeBao(script: Scripted[] = []): FakeBao {
  const requests: Logged[] = [];
  const queue = [...script];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const text = await req.text();
      requests.push({
        method: req.method,
        path: new URL(req.url).pathname,
        headers: req.headers,
        body: text ? JSON.parse(text) : null,
      });
      const next = queue.shift() ?? { status: 200, body: {} };
      return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
        status: next.status,
        headers: { "content-type": "application/json", ...next.headers },
      });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, requests, queue, stop: () => void server.stop(true) };
}
