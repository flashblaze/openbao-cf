import { afterEach, expect, test } from "bun:test";
import { AccessDeniedError, BaoError, connect } from "../src/bao.ts";
import { startFakeBao, type FakeBao, type Scripted } from "./fake-bao.ts";

let fake: FakeBao;
afterEach(() => fake.stop());
const LOGIN: Scripted = { status: 200, body: { auth: { client_token: "s.tok" } } };
const opts = () => ({ fetch, retryDelayMs: 1 });
const start = (...script: Scripted[]) => (fake = startFakeBao(script));

test("logs in with role owner and sends cf-access-token everywhere", async () => {
  start(LOGIN, { status: 200, body: { data: { data: { A: "1" } } } });
  const c = await connect(fake.url, "J", opts());
  await c.readSecret("proj", "dev");
  const [login, read] = fake.requests;
  expect(login.method).toBe("POST");
  expect(login.path).toBe("/v1/auth/jwt/login");
  expect(login.body).toEqual({ role: "owner", jwt: "J" });
  expect(login.headers.get("cf-access-token")).toBe("J");
  expect(login.headers.get("x-vault-token")).toBeNull();
  expect(read.path).toBe("/v1/secret/data/proj/dev");
  expect(read.headers.get("cf-access-token")).toBe("J");
  expect(read.headers.get("x-vault-token")).toBe("s.tok");
  expect(c.token).toBe("s.tok");
});
test("readSecret returns data.data", async () => {
  start(LOGIN, { status: 200, body: { data: { data: { API_KEY: "abc" }, metadata: {} } } });
  expect(await (await connect(fake.url, "J", opts())).readSecret("p", "dev")).toEqual({ API_KEY: "abc" });
});
test("readSecret returns null on 404", async () => {
  start(LOGIN, { status: 404, body: { errors: [] } });
  expect(await (await connect(fake.url, "J", opts())).readSecret("p", "dev")).toBeNull();
});
test("writeSecret posts {data}", async () => {
  start(LOGIN, { status: 200, body: { data: { version: 1 } } });
  await (await connect(fake.url, "J", opts())).writeSecret("p", "staging", { A: "1" });
  const w = fake.requests[1];
  expect(w.method).toBe("POST");
  expect(w.path).toBe("/v1/secret/data/p/staging");
  expect(w.body).toEqual({ data: { A: "1" } });
});
test("readSecret/writeSecret encode each path segment", async () => {
  start(LOGIN, { status: 404, body: { errors: [] } });
  await (await connect(fake.url, "J", opts())).readSecret("my-app", "pr-1");
  expect(fake.requests[1].path).toBe("/v1/secret/data/my-app/pr-1");
});
test("listEnvs drops folders and sorts", async () => {
  start(LOGIN, { status: 200, body: { data: { keys: ["staging", "dev", "sub/"] } } });
  expect(await (await connect(fake.url, "J", opts())).listEnvs("demo")).toEqual(["dev", "staging"]);
  expect(fake.requests[1].method).toBe("GET");
  expect(fake.requests[1].path).toBe("/v1/secret/metadata/demo/");
  expect(fake.requests[1].query).toBe("?list=true");
});
test("listEnvs returns [] on 404", async () => {
  start(LOGIN, { status: 404, body: { errors: [] } });
  expect(await (await connect(fake.url, "J", opts())).listEnvs("demo")).toEqual([]);
});
test("readLegacy reads secret/<project>", async () => {
  start(LOGIN, { status: 200, body: { data: { data: { A: "1" } } } }, { status: 404, body: { errors: [] } });
  const c = await connect(fake.url, "J", opts());
  expect(await c.readLegacy("demo")).toEqual({ A: "1" });
  expect(fake.requests[1].path).toBe("/v1/secret/data/demo");
  expect(await c.readLegacy("demo")).toBeNull();
});
test("deleteLegacy deletes the metadata of secret/<project> only", async () => {
  start(LOGIN, { status: 204 });
  await (await connect(fake.url, "J", opts())).deleteLegacy("demo");
  expect(fake.requests[1].method).toBe("DELETE");
  expect(fake.requests[1].path).toBe("/v1/secret/metadata/demo");
});
test("nested project paths keep their slashes and encode each segment", async () => {
  start(LOGIN, { status: 404, body: { errors: [] } }, { status: 404, body: { errors: [] } });
  const c = await connect(fake.url, "J", opts());
  await c.readSecret("instaclock/api", "dev");
  await c.listEnvs("instaclock/api");
  expect(fake.requests[1].path).toBe("/v1/secret/data/instaclock/api/dev");
  expect(fake.requests[2].path).toBe("/v1/secret/metadata/instaclock/api/");
});
test("readLegacy for a nested project returns null without a request", async () => {
  start(LOGIN);
  const c = await connect(fake.url, "J", opts());
  expect(await c.readLegacy("instaclock/api")).toBeNull();
  expect(fake.requests.length).toBe(1);
});
test("302 → AccessDeniedError", async () => {
  start({ status: 302, headers: { location: "https://t.cloudflareaccess.com/cdn-cgi/access/login" } });
  const err = await connect(fake.url, "J", opts()).catch((e) => e);
  expect(err).toBeInstanceOf(AccessDeniedError);
  expect(err.message).toBe("Access session missing or expired. Run `secrets login`.");
  expect(fake.requests.length).toBe(1);
});
test("worker 403 → AccessDeniedError", async () => {
  start({ status: 403, body: { error: "access denied" } });
  await expect(connect(fake.url, "J", opts())).rejects.toBeInstanceOf(AccessDeniedError);
});
test("openbao 403 → BaoError", async () => {
  start(LOGIN, { status: 403, body: { errors: ["permission denied"] } });
  const c = await connect(fake.url, "J", opts());
  const err = await c.readSecret("p", "dev").catch((e) => e);
  expect(err).toBeInstanceOf(BaoError);
  expect(err).not.toBeInstanceOf(AccessDeniedError);
  expect(err.status).toBe(403);
  expect(err.message).toBe("permission denied");
});
test("non-JSON error body → HTTP <status>", async () => {
  start(LOGIN, { status: 500 });
  const c = await connect(fake.url, "J", opts());
  const err = await c.readSecret("p", "dev").catch((e) => e);
  expect(err).toBeInstanceOf(BaoError);
  expect(err.message).toBe("HTTP 500");
});
test("retries 503 then succeeds", async () => {
  start({ status: 503, body: { error: "openbao not ready" } }, { status: 503 }, LOGIN);
  const c = await connect(fake.url, "J", opts());
  expect(c.token).toBe("s.tok");
  expect(fake.requests.length).toBe(3);
});
test("gives up after retries", async () => {
  start(...Array.from({ length: 4 }, () => ({ status: 503 }) as Scripted));
  const err = await connect(fake.url, "J", opts()).catch((e) => e);
  expect(err).toBeInstanceOf(BaoError);
  expect(err.status).toBe(503);
  expect(err.message).toContain("still starting");
  expect(fake.requests.length).toBe(4);
});
test("errors never contain the JWT or token", async () => {
  start(LOGIN, { status: 403, body: { errors: ["permission denied"] } });
  const c = await connect(fake.url, "JWT.SECRET.VALUE", opts());
  const err = await c.readSecret("p", "dev").catch((e) => e);
  expect(String(err.message) + String(err.stack)).not.toContain("JWT.SECRET.VALUE");
  expect(String(err.message)).not.toContain("s.tok");
});
