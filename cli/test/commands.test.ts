import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, stat, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { login } from "../src/commands/login.ts";
import { proxy } from "../src/commands/proxy.ts";
import { pull } from "../src/commands/pull.ts";
import { push } from "../src/commands/push.ts";
import { run } from "../src/commands/run.ts";
import { parseDevVars } from "../src/dotenv.ts";
import type { Io } from "../src/io.ts";
import { main } from "../src/main.ts";
import { startFakeBao, type FakeBao, type Scripted } from "./fake-bao.ts";

const LOGIN: Scripted = { status: 200, body: { auth: { client_token: "s.tok" } } };
const STORED = { API_KEY: "abc", MULTI: "a\nb" };
const READ: Scripted = { status: 200, body: { data: { data: STORED } } };
const NOT_FOUND: Scripted = { status: 404, body: { errors: [] } };

let dir: string;
let fake: FakeBao;
let outBuf: string;
let errBuf: string;
let io: Io;

async function setup(script: Scripted[], opts: { config?: boolean; tty?: boolean; confirm?: boolean } = {}) {
  dir = await mkdtemp(join(tmpdir(), "secrets-cmd-"));
  fake = startFakeBao(script);
  await writeFile(join(dir, ".secrets.json"), JSON.stringify({ project: "demo" }));
  const xdg = join(dir, "xdg");
  if (opts.config !== false) {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(xdg, "secrets"), { recursive: true });
    await writeFile(join(xdg, "secrets", "config.json"), JSON.stringify({ server: fake.url }));
  }
  outBuf = "";
  errBuf = "";
  io = {
    cwd: dir,
    env: { PATH: process.env.PATH, HOME: dir, XDG_CONFIG_HOME: xdg, SECRETS_ACCESS_JWT: "J" },
    out: (s) => void (outBuf += s),
    err: (s) => void (errBuf += s),
    isTTY: opts.tty ?? false,
    confirm: async () => opts.confirm ?? true,
    fetch,
    run: async () => ({ code: 128, stdout: "", stderr: "" }),
    runInherit: async () => 0,
  };
}

const exists = (p: string) => access(p).then(() => true, () => false);
const writes = () => fake.requests.filter((r) => r.method === "POST" && r.path.startsWith("/v1/secret/"));

beforeEach(() => {
  dir = "";
});
afterEach(async () => {
  fake?.stop();
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("run injects secrets and the Wrangler flag", async () => {
  await setup([LOGIN, READ]);
  const code = await run(["--", "sh", "-c", 'printf %s "$API_KEY|$CLOUDFLARE_INCLUDE_PROCESS_ENV" > out'], io);
  expect(code).toBe(0);
  expect(await readFile(join(dir, "out"), "utf8")).toBe("abc|true");
});

test("run passes the child's exit code", async () => {
  await setup([LOGIN, READ]);
  expect(await run(["--", "sh", "-c", "exit 7"], io)).toBe(7);
});

test("run refuses when .dev.vars exists", async () => {
  await setup([LOGIN, READ]);
  await writeFile(join(dir, ".dev.vars"), "X=1\n");
  const code = await run(["--", "sh", "-c", "echo hi > out"], io);
  expect(code).toBe(1);
  expect(errBuf).toContain(".dev.vars");
  expect(await exists(join(dir, "out"))).toBe(false);
  expect(fake.requests.length).toBe(0);
});

test("run refuses when .dev.vars exists in the cwd below the project root", async () => {
  await setup([LOGIN, READ]);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(dir, "sub"));
  await writeFile(join(dir, "sub", ".dev.vars"), "X=1\n");
  io.cwd = join(dir, "sub");
  expect(await run(["--", "sh", "-c", "echo hi > out"], io)).toBe(1);
  expect(errBuf).toContain(join(dir, "sub", ".dev.vars"));
  expect(await exists(join(dir, "sub", "out"))).toBe(false);
});

test("run refuses when .dev.vars.<env> exists", async () => {
  await setup([LOGIN, READ]);
  await writeFile(join(dir, ".dev.vars.staging"), "X=1\n");
  expect(await run(["--", "sh", "-c", "echo hi > out"], io)).toBe(1);
  expect(errBuf).toContain(join(dir, ".dev.vars.staging"));
  expect(await exists(join(dir, "out"))).toBe(false);
  expect(fake.requests.length).toBe(0);
});

test("run on an empty project explains", async () => {
  await setup([LOGIN, NOT_FOUND]);
  const code = await run(["--", "sh", "-c", "echo hi > out"], io);
  expect(code).toBe(1);
  expect(errBuf).toContain("No secrets stored for project demo (dev). Run `secrets push` first.");
  expect(await exists(join(dir, "out"))).toBe(false);
});

test("pull on an empty project explains", async () => {
  await setup([LOGIN, NOT_FOUND]);
  expect(await pull([], io)).toBe(1);
  expect(errBuf).toContain("No secrets stored for project demo (dev). Run `secrets push` first.");
  expect(await exists(join(dir, ".dev.vars"))).toBe(false);
});

test("pull writes .dev.vars 0600 and round-trips", async () => {
  await setup([LOGIN, READ]);
  expect(await pull([], io)).toBe(0);
  const file = join(dir, ".dev.vars");
  expect(parseDevVars(await readFile(file, "utf8"))).toEqual(STORED);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(outBuf).not.toContain("abc");
});

test("run --env staging reads the staging secret", async () => {
  await setup([LOGIN, { status: 200, body: { data: { data: { API_KEY: "stg" } } } }]);
  const code = await run(["--env", "staging", "--", "sh", "-c", 'printf %s "$API_KEY" > out'], io);
  expect(code).toBe(0);
  expect(fake.requests[1].path).toBe("/v1/secret/data/demo/staging");
  expect(await readFile(join(dir, "out"), "utf8")).toBe("stg");
});

test("run uses defaultEnv from .secrets.json", async () => {
  await setup([LOGIN, READ]);
  await writeFile(join(dir, ".secrets.json"), JSON.stringify({ project: "demo", defaultEnv: "local" }));
  expect(await run(["--", "true"], io)).toBe(0);
  expect(fake.requests[1].path).toBe("/v1/secret/data/demo/local");
});

test("run leaves --env after -- to the child", async () => {
  await setup([LOGIN, READ]);
  const code = await run(["--", "sh", "-c", 'printf %s "$*" > out', "_", "--env", "x"], io);
  expect(code).toBe(0);
  expect(fake.requests[1].path).toBe("/v1/secret/data/demo/dev");
  expect(await readFile(join(dir, "out"), "utf8")).toBe("--env x");
});

test("invalid --env is a usage error", async () => {
  await setup([LOGIN, READ]);
  expect(await run(["--env", "Bad!", "--", "true"], io)).toBe(2);
  expect(errBuf).toContain("Invalid environment name: Bad!");
  expect(fake.requests.length).toBe(0);
});

test("pull --env staging writes .dev.vars.staging only", async () => {
  await setup([LOGIN, READ]);
  expect(await pull(["--env", "staging"], io)).toBe(0);
  expect(fake.requests[1].path).toBe("/v1/secret/data/demo/staging");
  expect(parseDevVars(await readFile(join(dir, ".dev.vars.staging"), "utf8"))).toEqual(STORED);
  expect(await exists(join(dir, ".dev.vars"))).toBe(false);
  expect(outBuf).toContain("(staging)");
});

test("push --env staging reads .dev.vars.staging by default", async () => {
  await setup([LOGIN, NOT_FOUND, { status: 200, body: {} }]);
  await writeFile(join(dir, ".dev.vars.staging"), "A=1\nB=2\n");
  expect(await push(["--env", "staging", "--yes"], io)).toBe(0);
  const w = writes()[0];
  expect(w.path).toBe("/v1/secret/data/demo/staging");
  expect(w.body).toEqual({ data: { A: "1", B: "2" } });
  expect(outBuf).toContain("Pushed 2 keys to demo (staging).");
});

test("no-secrets message names the env", async () => {
  await setup([LOGIN, NOT_FOUND]);
  expect(await run(["--env", "qa", "--", "true"], io)).toBe(1);
  expect(errBuf).toContain("No secrets stored for project demo (qa). Run `secrets push --env qa` first.");
});

test("pull refuses to overwrite without --force", async () => {
  await setup([LOGIN, READ, LOGIN, READ]);
  expect(await pull([], io)).toBe(0);
  const file = join(dir, ".dev.vars");
  const first = await readFile(file, "utf8");
  expect(await pull([], io)).toBe(1);
  expect(errBuf).toContain("use --force");
  expect(await readFile(file, "utf8")).toBe(first);
  await writeFile(file, "OLD=1\n");
  fake.queue.push(LOGIN, READ);
  expect(await pull(["--force"], io)).toBe(0);
  expect(parseDevVars(await readFile(file, "utf8"))).toEqual(STORED);
});

test("pull warns when .dev.vars is not gitignored", async () => {
  await setup([LOGIN, READ]);
  io.run = async (cmd) => (cmd.includes("check-ignore") ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: "", stderr: "" });
  expect(await pull([], io)).toBe(0);
  expect(errBuf).toContain(".dev.vars is not gitignored");
});

test("push without --yes on non-TTY writes nothing", async () => {
  await setup([LOGIN, READ]);
  await writeFile(join(dir, ".dev.vars"), "API_KEY=changed\n");
  expect(await push([], io)).toBe(1);
  expect(errBuf).toContain("not a terminal; pass --yes");
  expect(writes().length).toBe(0);
});

test("push --yes writes and prints names only", async () => {
  await setup([LOGIN, READ, { status: 200, body: {} }]);
  await writeFile(join(dir, ".dev.vars"), "API_KEY=abc\nNEW=newsecretvalue\n");
  expect(await push(["--yes"], io)).toBe(0);
  expect(outBuf).toContain("+ NEW");
  expect(outBuf + errBuf).not.toContain("newsecretvalue");
  expect(outBuf + errBuf).not.toContain("abc");
  const w = writes();
  expect(w.length).toBe(1);
  expect(w[0].body).toEqual({ data: { API_KEY: "abc", NEW: "newsecretvalue" } });
});

test("push on a TTY asks for confirmation and honours a refusal", async () => {
  await setup([LOGIN, READ], { tty: true, confirm: false });
  await writeFile(join(dir, ".dev.vars"), "API_KEY=abc\nNEW=x\n");
  expect(await push([], io)).toBe(1);
  expect(writes().length).toBe(0);
});

test("push with no changes says so", async () => {
  await setup([LOGIN, READ]);
  await writeFile(join(dir, ".dev.vars"), 'API_KEY=abc\nMULTI="a\nb"\n');
  expect(await push(["--yes"], io)).toBe(0);
  expect(outBuf).toContain("Nothing to change.");
  expect(writes().length).toBe(0);
});

test("proxy gives the child a BAO_ADDR that adds the header", async () => {
  await setup([{ status: 200, body: { initialized: true } }]);
  const code = await proxy(["--", "sh", "-c", 'curl -sf "$BAO_ADDR/v1/sys/health" > out'], io);
  expect(code).toBe(0);
  expect(fake.requests.length).toBe(1);
  expect(fake.requests[0].path).toBe("/v1/sys/health");
  expect(fake.requests[0].headers.get("cf-access-token")).toBe("J");
  expect(await readFile(join(dir, "out"), "utf8")).toContain("initialized");
});

test("proxy works without a .secrets.json", async () => {
  await setup([{ status: 200, body: { initialized: true } }]);
  await rm(join(dir, ".secrets.json"));
  expect(await proxy(["--", "sh", "-c", 'curl -sf "$BAO_ADDR/v1/sys/health" > out; exit 5'], io)).toBe(5);
  expect(fake.requests.length).toBe(1);
});

test(
  "proxy waits out a slow upstream (container cold start)",
  async () => {
    await setup([{ status: 200, body: { initialized: true }, delayMs: 16_000 }]);
    const code = await proxy(["--", "sh", "-c", 'curl -sf -m 40 "$BAO_ADDR/v1/sys/health" > out'], io);
    expect(code).toBe(0);
    expect(await readFile(join(dir, "out"), "utf8")).toContain("initialized");
  },
  30_000,
);

test("proxy without a server config is a usage error", async () => {
  await setup([], { config: false });
  expect(await proxy(["--", "true"], io)).toBe(2);
  expect(errBuf).toContain("secrets login --server");
});

test("proxy rejects foreign Host headers", async () => {
  await setup([{ status: 200, body: { initialized: true } }]);
  const code = await proxy(
    ["--", "sh", "-c", 'curl -s -o /dev/null -w "%{http_code}" -H "Host: evil.example" "$BAO_ADDR/v1/sys/health" > evil; curl -s -o /dev/null -w "%{http_code}" -H "Host: localhost:${BAO_ADDR##*:}" "$BAO_ADDR/v1/sys/health" > local'],
    io,
  );
  expect(code).toBe(0);
  expect(await readFile(join(dir, "evil"), "utf8")).toBe("403");
  expect(await readFile(join(dir, "local"), "utf8")).toBe("200");
  expect(fake.requests.length).toBe(1);
});

test("proxy --login sets BAO_TOKEN and forwards body and query", async () => {
  await setup([LOGIN, { status: 200, body: { ok: 1 } }]);
  const code = await proxy(
    ["--login", "--", "sh", "-c", 'printf %s "$BAO_TOKEN" > tok; curl -sf -X PUT -d \'{"a":1}\' -H "content-type: application/json" "$BAO_ADDR/v1/x?y=z" > out'],
    io,
  );
  expect(code).toBe(0);
  expect(await readFile(join(dir, "tok"), "utf8")).toBe("s.tok");
  const fwd = fake.requests[1];
  expect(fwd.method).toBe("PUT");
  expect(fwd.path).toBe("/v1/x");
  expect(fwd.body).toEqual({ a: 1 });
});

test("no server config is a usage error", async () => {
  await setup([], { config: false });
  expect(await run(["--", "true"], io)).toBe(2);
  expect(errBuf).toContain("secrets login --server");
});

test("login saves the normalized server and runs cf access login", async () => {
  await setup([], { config: false });
  let ran: string[] = [];
  io.runInherit = async (cmd) => ((ran = cmd), 0);
  expect(await login(["--server", `${fake.url}/`], io)).toBe(0);
  expect(ran).toEqual(["cf", "access", "login", fake.url]);
  const cfgPath = join(dir, "xdg", "secrets", "config.json");
  expect(JSON.parse(await readFile(cfgPath, "utf8"))).toEqual({ server: fake.url });
  expect((await stat(cfgPath)).mode & 0o777).toBe(0o600);
});

test("login rejects a non-https server with exit 1", async () => {
  await setup([], { config: false });
  expect(await login(["--server", "http://example.com"], io)).toBe(1);
  expect(errBuf).toContain("https");
});

test("main: --help lists the commands, unknown command is 2", async () => {
  await setup([]);
  expect(await main(["--help"], io)).toBe(0);
  for (const c of ["login", "run", "pull", "push", "proxy"]) expect(outBuf).toContain(c);
  expect(await main(["bogus"], io)).toBe(2);
});
