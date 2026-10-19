# OpenBao on Cloudflare Containers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single-owner OpenBao server on Cloudflare Containers behind Cloudflare Access, plus a `secrets` CLI that injects a project's local dev secrets into `wrangler dev` (or writes `.dev.vars`) after one browser login.

**Architecture:** A Worker on a custom domain verifies the Cloudflare Access JWT and forwards to one OpenBao container (`@cloudflare/containers`, default scheduling policy), which stores encrypted data in a Neon free Postgres and unseals itself with the static seal. The same Worker runs a daily cron that copies the encrypted table to R2. The CLI (Bun, TypeScript) gets the Access JWT from `cf access token`, logs in to OpenBao's JWT auth method with it, and reads/writes KV v2 at `secret/<project>`.

**Tech Stack:** Cloudflare Workers + Containers + Access + R2, `cf` CLI 1.0.0-beta.18, `@cloudflare/containers`, `jose`, `pg`, OpenBao 2.7.1, Neon Postgres, Bun 1.4.3 (`bun test`, `bun build --compile`), `dotenv` parser, Docker Compose for local integration.

**Spec:** `docs/superpowers/specs/2026-10-19-openbao-cf-design.md`

## Global Constraints

- OpenBao image: `openbao/openbao:2.7.1`. Local admin CLI: `mise use -g openbao@2.7.1` (provides `bao`).
- Deploy with `cf` (`cf@1.0.0-beta.18` as a dev dependency of `server/`). Use `npx wrangler tail openbao-cf` for live logs. Never run `cf dev/build/deploy` in the owner's other (Wrangler) projects.
- Worker name `openbao-cf`, compatibility date `2026-10-19`, flags `["nodejs_compat"]`, `workersDev: false`, `previewUrls: false`, `observability: { enabled: true }`.
- Container: name `openbao`, Durable Object class `OpenBao`, binding `OPENBAO`, default scheduling policy, `instanceType: "lite"`, `maxInstances: 1`, `sleepAfter = "10m"`, `defaultPort = 8200`, single instance name `"primary"`.
- OpenBao config: `storage "postgresql"` (URL from env `BAO_PG_CONNECTION_URL`, `ha_enabled = "false"`, `max_connect_retries = "10"`), `seal "static"` (`current_key_id = "seal-1"`, `current_key = "env://BAO_SEAL_KEY"`), TCP listener `0.0.0.0:8200` with `tls_disable = true`, `disable_mlock = true`, `ui = false`.
- **Deviation from spec, on purpose:** do not set `max_idle_connections = 0`. With zero idle connections every storage operation opens a new TLS connection to Neon (hundreds of ms each). The container stopping after `sleepAfter` already closes all connections, which lets Neon suspend.
- Seal key: 32 random bytes as 64 hex chars (`openssl rand -hex 32`).
- KV v2 mounted at `secret/`. One secret per project at `secret/<project>`; fields = `.dev.vars` keys.
- JWT auth at `auth/jwt`, role `owner`, `role_type = "jwt"`, `user_claim = "email"`, bound audience = Access AUD, bound claim `email` = owner email, `token_policies = ["owner"]`, `token_ttl = "1h"`.
- Access JWT: JWKS `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, issuer `https://<team>.cloudflareaccess.com`, audience = AUD tag, algorithm RS256, `email` claim equals owner email (case-insensitive). Header to origin: `Cf-Access-Jwt-Assertion`. Header from CLI: `cf-access-token`.
- Worker secrets (all via `cf deploy --secrets-file server/secrets.env`, file gitignored): `BAO_SEAL_KEY`, `NEON_DATABASE_URL`, `ACCESS_TEAM_DOMAIN` (full URL, no trailing slash), `ACCESS_AUD`, `OWNER_EMAIL`. The owner's email is not committed.
- Backups: R2 bucket `openbao-cf-backups`, binding `BACKUPS`, key `backups/YYYY-MM-DD.ndjson` (UTC), cron `17 3 * * *`, keep 30 days. Never write or prune when the table is empty.
- CLI: Linux x64 only. Binary name from one constant `APP_NAME = "secrets"`. User config `$XDG_CONFIG_HOME/secrets/config.json` (fallback `~/.config/secrets/config.json`), mode 0600. Project file `.secrets.json` = `{ "project": "<name>" }`, name matches `/^[a-z0-9][a-z0-9_-]{0,63}$/`.
- `run` sets `CLOUDFLARE_INCLUDE_PROCESS_ENV=true` on the child and refuses to start when a `.dev.vars` exists in the project root or the current directory.
- Neither the CLI nor the Worker ever prints or logs a secret value. Output names keys only.
- Test hook: env `SECRETS_ACCESS_JWT`, when set, is used as the Access JWT instead of calling `cf access token`.

## Review Focus

1. **Cold start:** the first request after a sleep wakes the container and Neon. The Worker waits up to 30 s for OpenBao, and the CLI retries a 503 three times, 2 s apart, before failing with "OpenBao is still starting; try again". Tests: Task 2 (`waitForReady` timeout and recovery), Task 7 (`retries 503 then succeeds`, `gives up after retries`).
2. **Expired or missing Access session:** Access answers with a 302 to its login page, not JSON. The CLI must say "Access session missing or expired. Run `secrets login`." instead of a parse error. Tests: Task 7 (`302 → AccessDeniedError`, `worker 403 → AccessDeniedError`), Task 7 (`getAccessToken` with `cf` exiting non-zero).
3. **Awkward `.dev.vars` values:** quotes, `#`, `=`, newlines, empty values and unicode must come back identical after `push` → `pull`, and `run` must inject the exact values. Tests: Task 6 (`round-trips awkward values`).
4. **Project with nothing stored yet:** `run`/`pull` on a project that has never been pushed says "No secrets stored for project <name>. Run `secrets push` first." Tests: Task 8.
5. **Leftover `.dev.vars` shadowing injected secrets:** Wrangler ignores the process env when `.dev.vars` exists, so `run` must stop before starting the child. Tests: Task 8.

---

## File Structure

```
.gitignore                         node_modules, dist, .cloudflare, server/secrets.env, *.key, .dev.vars
server/
  package.json, tsconfig.json
  cloudflare.config.ts             Worker + container + bindings + cron
  secrets.env.example              names of the five Worker secrets, no values
  container/Dockerfile             FROM openbao/openbao:2.7.1 + config
  container/config.hcl             OpenBao server config
  compose.yaml                     local Postgres + OpenBao (+ restore profile)
  policies/owner.hcl               owner policy
  scripts/init.sh                  one-time operator init (prints keys once)
  scripts/configure.sh             idempotent: KV, JWT auth, policy, role, audit
  scripts/backup-local.ts          dump a Postgres table to NDJSON (drills)
  scripts/restore.ts               load NDJSON into an empty Postgres
  scripts/restore-drill.sh         restore a backup into a local unsealed OpenBao on :8201
  src/access.ts                    Access JWT verification
  src/health.ts                    readiness classification + wait loop
  src/backup.ts                    NDJSON encode/decode, key naming, pruning, runBackup
  src/db.ts                        pg query for openbao_kv_store rows
  src/handler.ts                   fetch gate: verify, then forward
  src/container.ts                 OpenBao Container class
  src/env.ts                       Env interface
  src/index.ts                     Worker entry: fetch + scheduled
  test/*.test.ts                   bun unit tests
  test/e2e/jwt.ts                  test keypair + token signer
  test/e2e/lib.sh                  shared bring-up/init/configure helpers
  test/e2e/container.sh            container integration test
  test/e2e/full.sh                 CLI end-to-end + restore drill
cli/
  package.json, tsconfig.json
  src/name.ts                      APP_NAME, PROJECT_FILE, ROLE
  src/io.ts                        Io type (injected cwd/env/output/confirm/fetch/run)
  src/config.ts                    user config + project lookup + validation
  src/dotenv.ts                    parse/serialize .dev.vars
  src/diff.ts                      key-name diff
  src/access.ts                    Access token via cf
  src/bao.ts                       OpenBao HTTP client + error mapping
  src/context.ts                   resolve server + project + client
  src/process.ts                   child env + spawn with signal forwarding
  src/commands/{login,run,pull,push,proxy}.ts
  src/main.ts                      argv dispatch
  test/*.test.ts
docs/runbook.md                    deploy, init, rotate, restore drill (written in Task 10)
```

---

### Task 1: Server scaffold and Access JWT verification

**Files:**
- Create: `.gitignore`, `server/package.json`, `server/tsconfig.json`, `server/src/access.ts`
- Test: `server/test/access.test.ts`

**Interfaces:**
- Produces:
  - `type AccessConfig = { teamDomain: string; aud: string; ownerEmail: string }`
  - `type AccessResult = { ok: true; email: string } | { ok: false; reason: string }`
  - `verifyAccessJwt(token: string | null, cfg: AccessConfig, keys: JWTVerifyGetKey): Promise<AccessResult>` (`JWTVerifyGetKey` from `jose`)
  - `accessJwks(teamDomain: string): JWTVerifyGetKey`, a `createRemoteJWKSet` on `${teamDomain}/cdn-cgi/access/certs`, cached per isolate by team domain

- [ ] **Step 1: Scaffold.** `server/package.json` (private, `"type": "module"`, scripts `test: bun test test/`, `typecheck: tsc --noEmit`), deps `jose`, `pg`, `@cloudflare/containers`; dev deps `cf@1.0.0-beta.18`, `typescript`, `@types/pg`, `@cloudflare/workers-types`. `bun install`. Root `.gitignore` per File Structure. `git init` is already done.

- [ ] **Step 2: Write the failing test** `server/test/access.test.ts`. Generate an RS256 keypair with `jose.generateKeyPair("RS256")`, build `createLocalJWKSet({ keys: [publicJwk] })`, sign tokens with `SignJWT`.

```ts
const cfg = { teamDomain: "https://test.cloudflareaccess.com", aud: "test-aud", ownerEmail: "owner@example.com" };
// sign(claims, key = privateKey, alg = "RS256") → token with iss=cfg.teamDomain, aud=[cfg.aud], email, exp=+5m, then overrides from claims
test("accepts a valid owner token", async () => {
  expect(await verifyAccessJwt(await sign({}), cfg, jwks)).toEqual({ ok: true, email: "owner@example.com" });
});
test("accepts owner email in different case", async () => {
  expect((await verifyAccessJwt(await sign({ email: "Owner@Example.com" }), cfg, jwks)).ok).toBe(true);
});
test.each([
  ["missing token", null],
  ["wrong audience", () => sign({ aud: ["other"] })],
  ["wrong issuer", () => sign({ iss: "https://evil.cloudflareaccess.com" })],
  ["expired", () => sign({ exp: Math.floor(Date.now() / 1000) - 60 })],
  ["other email", () => sign({ email: "someone@example.com" })],
  ["no email claim", () => sign({ email: undefined })],
  ["signed by another key", () => sign({}, otherPrivateKey)],
  ["HS256 token", () => signHs256({})],
])("rejects %s", async (_, make) => {
  const token = typeof make === "function" ? await make() : make;
  expect((await verifyAccessJwt(token, cfg, jwks)).ok).toBe(false);
});
```

- [ ] **Step 3: Run it to make sure it fails.** Run: `cd server && bun test test/access.test.ts`. Expected: FAIL, cannot resolve `../src/access`.

- [ ] **Step 4: Implement `verifyAccessJwt` and `accessJwks` in `server/src/access.ts`.** `jwtVerify(token, keys, { issuer, audience, algorithms: ["RS256"] })`, then compare `payload.email` lowercased with `ownerEmail` lowercased. Catch every jose error into `{ ok: false, reason }`. `reason` is for logs only and never includes the token.

- [ ] **Step 5: Run the tests.** Run: `bun test test/access.test.ts && bunx tsc --noEmit`. Expected: all pass, no type errors.

- [ ] **Step 6: Commit.** `git add .gitignore server && git commit -m "feat(server): verify Cloudflare Access JWTs"`

---

### Task 2: Readiness wait

**Files:**
- Create: `server/src/health.ts`
- Test: `server/test/health.test.ts`

**Interfaces:**
- Produces:
  - `classifyHealth(status: number | null): "ready" | "wait"`: `200` and `501` (not initialized, needed for first setup) → `"ready"`. Everything else, including `null` (connection error) and `503` (sealed), → `"wait"`.
  - `type WaitOptions = { timeoutMs: number; intervalMs: number; now?: () => number; sleep?: (ms: number) => Promise<void> }`
  - `waitForReady(probe: () => Promise<number | null>, opts: WaitOptions): Promise<boolean>`: probes at least once, returns `true` on the first `"ready"`, and `false` once `now()` passes start + `timeoutMs`.

- [ ] **Step 1: Write the failing test.**

```ts
test.each([[200, "ready"], [501, "ready"], [503, "wait"], [500, "wait"], [429, "wait"], [null, "wait"]])(
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
```

- [ ] **Step 2: Run it to make sure it fails.** `bun test test/health.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `classifyHealth` and `waitForReady` in `server/src/health.ts`.** Defaults are `now = Date.now` and `sleep = (ms) => new Promise(r => setTimeout(r, ms))`. A probe that throws counts as `null`.
- [ ] **Step 4: Run the tests.** `bun test test/health.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add server && git commit -m "feat(server): readiness wait for OpenBao"`

---

### Task 3: Backup encoding, naming and pruning

**Files:**
- Create: `server/src/backup.ts`
- Test: `server/test/backup.test.ts`

**Interfaces:**
- Produces:
  - `type KvRow = { parent_path: string; path: string; key: string; value: Uint8Array | null }` (columns of `openbao_kv_store`)
  - `BACKUP_PREFIX = "backups/"`, `KEEP_DAYS = 30`
  - `rowsToNdjson(rows: KvRow[]): string`: one JSON object per line, `{ parent_path, path, key, value_b64 }` (`value_b64` is `null` for null), trailing newline
  - `ndjsonToRows(text: string): KvRow[]`
  - `backupKey(date: Date): string`, giving `backups/YYYY-MM-DD.ndjson` in UTC
  - `keysToPrune(keys: string[], now: Date, keepDays: number): string[]`: only keys matching `^backups/\d{4}-\d{2}-\d{2}\.ndjson$` whose date is strictly before (UTC date of `now`) minus `keepDays` days
  - `type BackupBucket = { put(key: string, body: string): Promise<unknown>; list(opts: { prefix: string }): Promise<{ objects: { key: string }[] }>; delete(keys: string[]): Promise<void> }`
  - `runBackup(deps: { query: () => Promise<KvRow[]>; bucket: BackupBucket; now: Date }): Promise<{ key: string; rows: number; pruned: string[] }>`: throws `Error("refusing to back up an empty table")` on zero rows, before any put or delete

- [ ] **Step 1: Write the failing test.**

```ts
const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
test("round-trips binary values and nulls", () => {
  const rows = [{ parent_path: "/", path: "/core/", key: "keyring", value: bytes },
                { parent_path: "/core/", path: "/core/x/", key: "empty", value: null }];
  expect(ndjsonToRows(rowsToNdjson(rows))).toEqual(rows);
});
test("backupKey uses the UTC date", () => {
  expect(backupKey(new Date("2026-10-19T23:59:00Z"))).toBe("backups/2026-10-19.ndjson");
});
test("prunes only dated backups older than keepDays", () => {
  const keys = ["backups/2026-09-18.ndjson", "backups/2026-09-19.ndjson", "backups/2026-10-19.ndjson",
                "backups/notes.txt", "other/2020-01-01.ndjson"];
  expect(keysToPrune(keys, new Date("2026-10-19T03:17:00Z"), 30)).toEqual(["backups/2026-09-18.ndjson"]);
});
test("runBackup writes today's file then prunes", async () => {
  const bucket = fakeBucket(["backups/2026-09-01.ndjson"]);
  const r = await runBackup({ query: async () => [row], bucket, now: new Date("2026-10-19T03:17:00Z") });
  expect(r).toEqual({ key: "backups/2026-10-19.ndjson", rows: 1, pruned: ["backups/2026-09-01.ndjson"] });
  expect(bucket.puts.map(p => p.key)).toEqual(["backups/2026-10-19.ndjson"]);
});
test("runBackup refuses an empty table and touches nothing", async () => {
  const bucket = fakeBucket(["backups/2026-09-01.ndjson"]);
  await expect(runBackup({ query: async () => [], bucket, now: new Date() })).rejects.toThrow("empty table");
  expect(bucket.puts).toEqual([]); expect(bucket.deleted).toEqual([]);
});
```

- [ ] **Step 2: Run it to make sure it fails.** `bun test test/backup.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement everything listed under Interfaces in `server/src/backup.ts`.** Base64 goes through `Buffer` (available under `nodejs_compat` and in Bun).
- [ ] **Step 4: Run the tests.** `bun test`. Expected: all server tests PASS.
- [ ] **Step 5: Commit.** `git add server && git commit -m "feat(server): backup encoding and retention"`

---

### Task 4: OpenBao container image, local stack, init and configure scripts

**Files:**
- Create: `server/container/Dockerfile`, `server/container/config.hcl`, `server/compose.yaml`, `server/policies/owner.hcl`, `server/scripts/init.sh`, `server/scripts/configure.sh`, `server/test/e2e/jwt.ts`, `server/test/e2e/container.sh`

**Interfaces:**
- Produces:
  - Image: `FROM openbao/openbao:2.7.1`, `COPY config.hcl /openbao/config/config.hcl`, `CMD ["server"]`. The image entrypoint adds `-config=/openbao/config`; confirm in the logs (Step 4).
  - `compose.yaml` services:
    - `postgres` (`postgres:17`, user/password/db `bao`, published `127.0.0.1:55432:5432`, `pg_isready` healthcheck).
    - `openbao` (build `./container`, `127.0.0.1:8200:8200`, `BAO_PG_CONNECTION_URL=postgres://bao:bao@postgres:5432/bao?sslmode=disable`, `BAO_SEAL_KEY=${BAO_SEAL_KEY:?}`, `mem_limit: 256m`, `cpus: "0.0625"` to mimic `lite`).
    - `openbao-restore` (profile `restore`, same image, `127.0.0.1:8201:8200`, database `bao_restore`).
  - `init.sh`: runs `bao operator init -recovery-shares=1 -recovery-threshold=1 -format=json` against `$BAO_ADDR` and prints the JSON to stdout only. Writes nothing to disk.
  - `configure.sh`: needs env `BAO_ADDR`, `BAO_TOKEN`, `OWNER_EMAIL`, `ACCESS_AUD`, plus either `ACCESS_TEAM_DOMAIN` (production: `jwks_url=$ACCESS_TEAM_DOMAIN/cdn-cgi/access/certs`, `bound_issuer=$ACCESS_TEAM_DOMAIN`) or `JWT_PUBKEY_FILE` + `JWT_ISSUER` (tests: `jwt_validation_pubkeys=@file`, `bound_issuer=$JWT_ISSUER`). Idempotent: it enables `kv-v2` at `secret/`, `jwt` auth and the `file` audit device (`file_path=stdout`) only if missing, and always rewrites the JWT config, the `owner` policy and the `owner` role (values in Global Constraints). Uses `set -euo pipefail`, checks mounts with `bao secrets list -format=json | jq`, and checks the JWKS parameter name against the OpenBao JWT API docs.
  - `owner.hcl`: `create/read/update/delete/list` on `secret/*`; `create/read/update/delete/list/sudo` on `sys/*` and `auth/*`.
  - `test/e2e/jwt.ts`: `bun test/e2e/jwt.ts keygen <dir>` writes `private.jwk` and `public.pem`. `bun test/e2e/jwt.ts sign <dir> <email>` prints an RS256 JWT with `iss=https://test.cloudflareaccess.com`, `aud=["test-aud"]`, the given `email`, and `exp=+10m`.

- [ ] **Step 1: Write the failing integration test** `server/test/e2e/container.sh` (`set -euo pipefail`, temp dir, `trap 'docker compose down -v' EXIT`). Its checks, in order:
  1. `export BAO_SEAL_KEY=$(openssl rand -hex 32)`, then `docker compose up -d --build --wait postgres openbao`.
  2. Poll `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8200/v1/sys/health` until it returns `501` (60 s cap).
  3. `ROOT=$(BAO_ADDR=http://127.0.0.1:8200 bash scripts/init.sh | jq -r .root_token)`, and assert it's non-empty.
  4. Generate the test keypair and run `configure.sh` with `JWT_PUBKEY_FILE`, `JWT_ISSUER=https://test.cloudflareaccess.com`, `ACCESS_AUD=test-aud`, `OWNER_EMAIL=owner@example.com`. Run it twice to prove it's idempotent.
  5. Log in with `POST /v1/auth/jwt/login {"role":"owner","jwt":<owner token>}` and assert `.auth.policies` contains `"owner"`.
  6. Write `secret/data/demo` `{"data":{"API_KEY":"abc"}}` with that token, then read it back and get `abc`.
  7. A login with a token for `someone@example.com` must fail with a non-200 status.
  8. `docker compose restart openbao`, poll health until `200` (no manual unseal), then read `secret/data/demo` again and get `abc`. This proves the static seal works.
  9. Print `docker stats --no-stream --format '{{.MemUsage}}'` for `openbao` for the record.

- [ ] **Step 2: Run it to make sure it fails.** `cd server && bash test/e2e/container.sh`. Expected: FAIL (no Dockerfile or compose file yet).
- [ ] **Step 3: Write the Dockerfile, `config.hcl` (exact values from Global Constraints), `compose.yaml`, `owner.hcl`, `init.sh`, `configure.sh` and `jwt.ts` described under Interfaces.** The scripts need `bao` locally: `mise use -g openbao@2.7.1`.
- [ ] **Step 4: Run the integration test.** `bash test/e2e/container.sh`. Expected: every check passes. The logs show the config file loaded and `seal type: static`. The memory line prints well under 256 MiB. If OpenBao is OOM-killed at `mem_limit: 256m`, record it; Task 5 then uses `instanceType: "basic"`.
- [ ] **Step 5: Commit.** `git add server && git commit -m "feat(server): OpenBao image, local stack, setup scripts"`

---

### Task 5: Worker entry, Container class and `cloudflare.config.ts`

**Files:**
- Create: `server/src/env.ts`, `server/src/db.ts`, `server/src/handler.ts`, `server/src/container.ts`, `server/src/index.ts`, `server/cloudflare.config.ts`, `server/secrets.env.example`
- Test: `server/test/handler.test.ts`

**Interfaces:**
- Consumes: `verifyAccessJwt`, `accessJwks` (Task 1); `waitForReady` (Task 2); `runBackup`, `KvRow` (Task 3).
- Produces:
  - `interface Env { OPENBAO: DurableObjectNamespace<OpenBao>; BACKUPS: R2Bucket; BAO_SEAL_KEY: string; NEON_DATABASE_URL: string; ACCESS_TEAM_DOMAIN: string; ACCESS_AUD: string; OWNER_EMAIL: string }`
  - `queryKvRows(databaseUrl: string): Promise<KvRow[]>` in `db.ts`: `pg` `Client`, `SELECT parent_path, path, key, value FROM openbao_kv_store ORDER BY path, key`, always `end()`s.
  - `type HandlerDeps = { verify(token: string | null): Promise<AccessResult>; forward(request: Request): Promise<Response> }`
  - `handleRequest(request: Request, deps: HandlerDeps): Promise<Response>`: reads `cf-access-jwt-assertion`. On failure it returns `403` with JSON `{"error":"access denied"}` (exact body; the CLI keys on it), logs `reason`, and never calls `forward`.
  - `class OpenBao extends Container<Env>`: `defaultPort = 8200`, `sleepAfter = "10m"`. Overrides `fetch(request)`:
    1. `await this.startAndWaitForPorts({ startOptions: { envVars: { BAO_PG_CONNECTION_URL: this.env.NEON_DATABASE_URL, BAO_SEAL_KEY: this.env.BAO_SEAL_KEY } } })`.
    2. Unless an in-memory `ready` flag is set, `waitForReady(() => this.containerFetch("http://openbao/v1/sys/health").then(r => r.status), { timeoutMs: 30_000, intervalMs: 500 })`. On `false`, return `503` with `retry-after: 5` and JSON `{"error":"openbao not ready"}`.
    3. Otherwise `this.containerFetch(request)`.

    `onStop()` clears `ready`.
  - `index.ts`:
    - `fetch` calls `handleRequest` with `verify = t => verifyAccessJwt(t, cfg(env), accessJwks(env.ACCESS_TEAM_DOMAIN))` and `forward = r => getContainer(env.OPENBAO, "primary").fetch(r)`.
    - `scheduled` calls `runBackup({ query: () => queryKvRows(env.NEON_DATABASE_URL), bucket: env.BACKUPS, now: new Date(controller.scheduledTime) })` and logs `{ key, rows, pruned }`.
    - Re-exports `OpenBao`.
  - `cloudflare.config.ts`:
    - `defineContainer({ name: "openbao", image: { dockerfile: "./container/Dockerfile" }, instanceType: "lite", maxInstances: 1 })`.
    - Worker `openbao-cf` with:
      - `exports: { OpenBao: exports.durableObject({ storage: "sqlite", container }) }`
      - `env`: `OPENBAO: bindings.durableObject({ worker: "openbao-cf", exportName: "OpenBao" })`, `BACKUPS: bindings.r2({ name: "openbao-cf-backups" })`, and the five `bindings.secret()` entries
      - `triggers: [triggers.scheduled({ schedule: "17 3 * * *" })]`
      - `domains: [process.env.BAO_HOSTNAME!]`. The hostname is read at build time so it isn't committed. Fail the build with a clear message if it's unset.
      - The flags from Global Constraints.
  - `secrets.env.example`: the five names, each with an empty value and a one-line comment.

- [ ] **Step 1: Write the failing test** `server/test/handler.test.ts`.

```ts
test("rejects without forwarding", async () => {
  let forwarded = false;
  const res = await handleRequest(new Request("https://bao.test/v1/sys/health"), {
    verify: async () => ({ ok: false, reason: "missing token" }), forward: async () => { forwarded = true; return new Response(); } });
  expect(res.status).toBe(403); expect(await res.json()).toEqual({ error: "access denied" }); expect(forwarded).toBe(false);
});
test("passes the token to verify and forwards the same request", async () => {
  const req = new Request("https://bao.test/v1/secret/data/demo", { headers: { "cf-access-jwt-assertion": "tok" } });
  let seen: string | null = null; let got: Request | null = null;
  const res = await handleRequest(req, { verify: async (t) => { seen = t; return { ok: true, email: "owner@example.com" }; },
    forward: async (r) => { got = r; return new Response("ok"); } });
  expect(seen).toBe("tok"); expect(got).toBe(req); expect(await res.text()).toBe("ok");
});
```

- [ ] **Step 2: Run it to make sure it fails.** `bun test test/handler.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `handleRequest` in `server/src/handler.ts`.**
- [ ] **Step 4: Run the test.** Expected: PASS.
- [ ] **Step 5: Write `env.ts`, `db.ts`, `container.ts`, `index.ts`, `cloudflare.config.ts` and `secrets.env.example` as specified.** Before writing `cloudflare.config.ts`, check field names with `cf docs search "attach a container"` and the config explorer page.
- [ ] **Step 6: Verify the build.** Run: `bunx tsc --noEmit && bun test && BAO_HOSTNAME=bao.example.com bunx cf deploy --dry-run`. Expected: no type errors, all tests pass, and the dry run builds the Worker and the container image without uploading. Then run without `BAO_HOSTNAME` and expect the clear "BAO_HOSTNAME is required" failure.
- [ ] **Step 7: Commit.** `git add server && git commit -m "feat(server): Worker, OpenBao container and cf config"`

---

### Task 6: CLI scaffold, config, `.dev.vars` codec, key diff

**Files:**
- Create: `cli/package.json`, `cli/tsconfig.json`, `cli/src/name.ts`, `cli/src/io.ts`, `cli/src/config.ts`, `cli/src/dotenv.ts`, `cli/src/diff.ts`
- Test: `cli/test/config.test.ts`, `cli/test/dotenv.test.ts`, `cli/test/diff.test.ts`

**Interfaces:**
- Produces:
  - `name.ts`: `APP_NAME = "secrets"`, `PROJECT_FILE = ".secrets.json"`, `ROLE = "owner"`
  - `io.ts`:
    ```ts
    type Io = { cwd: string; env: Record<string, string | undefined>; out(s: string): void; err(s: string): void; isTTY: boolean; confirm(q: string): Promise<boolean>; fetch: typeof fetch; run: Runner; runInherit(cmd: string[]): Promise<number> }
    type Runner = (cmd: string[]) => Promise<{ code: number; stdout: string; stderr: string }>
    ```
    Also `defaultIo(): Io`, built on `process` and `Bun.spawn`.
  - `config.ts`:
    - `type UserConfig = { server: string }`
    - `userConfigPath(env): string`
    - `readUserConfig(path: string): Promise<UserConfig | null>`
    - `writeUserConfig(cfg: UserConfig, path: string): Promise<void>`: `mkdir -p`, mode `0o600`
    - `type Project = { name: string; root: string }`
    - `findProject(startDir: string): Promise<Project | null>`: walks up to `/`. Throws `Error` naming the file if the JSON is invalid or the name fails `validateProjectName`.
    - `validateProjectName(name: string): boolean`
    - `normalizeServer(url: string): string`: requires `https:`, except `http://127.0.0.1` and `http://localhost` (tests). Strips the trailing slash and any path. Throws on anything else.
  - `dotenv.ts`:
    - `parseDevVars(text: string): Record<string, string>`: `dotenv`'s `parse`, the same parser Wrangler uses
    - `serializeDevVars(vars: Record<string, string>): string`: keys sorted, one `KEY=<quoted>` per line, trailing newline. Quoting rule, the first that fits:
      1. Single quotes when the value has no `'` and no newline.
      2. Double quotes when the value has no `"` and no literal `\n` or `\r` sequence; real newlines are written as `\n`.
      3. Backticks when the value has no backtick.
      4. Otherwise throw `UnrepresentableValueError(key)`.
    - `class UnrepresentableValueError extends Error`
  - `diff.ts`:
    - `type KeyDiff = { added: string[]; changed: string[]; removed: string[] }`, each sorted
    - `diffKeys(current: Record<string,string>, next: Record<string,string>): KeyDiff`
    - `isEmptyDiff(d: KeyDiff): boolean`
    - `formatDiff(d: KeyDiff): string`: lines `+ KEY`, `~ KEY`, `- KEY`, names only

- [ ] **Step 1: Scaffold.** `cli/package.json` (private, `"type": "module"`, scripts `test: bun test test/`, `typecheck: tsc --noEmit`, `build: bun build --compile --target=bun-linux-x64 ./src/main.ts --outfile ../dist/secrets`), dep `dotenv`, dev deps `typescript`, `@types/bun`. `bun install`.

- [ ] **Step 2: Write the failing tests.**

```ts
// dotenv.test.ts
const awkward = { A: "plain", B: "with space", C: `it's`, D: `say "hi"`, E: "a=b=c", F: "#not a comment",
  G: "line1\nline2", H: "", I: "naïve ✓", J: `both ' and "`, K: "back\\slash", L: "literal \\n here" };
test("round-trips awkward values", () => expect(parseDevVars(serializeDevVars(awkward))).toEqual(awkward));
test("parses a typical file", () => expect(parseDevVars(
  "# comment\nexport API_KEY=abc\nURL=\"https://x?y=1\" # trailing\nSINGLE='raw $x'\n")).toEqual(
  { API_KEY: "abc", URL: "https://x?y=1", SINGLE: "raw $x" }));
test("throws when a value cannot be quoted", () => expect(() =>
  serializeDevVars({ X: "' \" ` \n" })).toThrow(UnrepresentableValueError));
// config.test.ts
test("finds .secrets.json in a parent dir", ...);           // root = the dir holding the file, name from JSON
test("returns null when no project file exists", ...);
test.each(["../x", "A", "", "a/b", "x".repeat(65)])("rejects project name %p", (n) => expect(validateProjectName(n)).toBe(false));
test("normalizeServer", () => {
  expect(normalizeServer("https://bao.example.com/")).toBe("https://bao.example.com");
  expect(normalizeServer("http://127.0.0.1:8200")).toBe("http://127.0.0.1:8200");
  expect(() => normalizeServer("http://bao.example.com")).toThrow();
});
test("user config path honours XDG_CONFIG_HOME", () =>
  expect(userConfigPath({ XDG_CONFIG_HOME: "/x", HOME: "/h" })).toBe("/x/secrets/config.json"));
test("writeUserConfig creates the file with mode 0600", ...);
// diff.test.ts
test("diffKeys", () => expect(diffKeys({ A: "1", B: "2", C: "3" }, { A: "1", B: "9", D: "4" }))
  .toEqual({ added: ["D"], changed: ["B"], removed: ["C"] }));
test("formatDiff names only", () => expect(formatDiff({ added: ["D"], changed: ["B"], removed: ["C"] }))
  .toBe("+ D\n~ B\n- C"));
```

- [ ] **Step 3: Run them to make sure they fail.** `cd cli && bun test`. Expected: FAIL, modules not found.
- [ ] **Step 4: Implement `name.ts`, `io.ts`, `config.ts`, `dotenv.ts` and `diff.ts` per Interfaces.**
- [ ] **Step 5: Run the tests.** `bun test && bunx tsc --noEmit`. Expected: PASS. If `D` or `J` fail because `dotenv` keeps a backslash, the quoting rule above is wrong for that case; fix the rule, not the test.
- [ ] **Step 6: Commit.** `git add cli && git commit -m "feat(cli): config, .dev.vars codec, key diff"`

---

### Task 7: Access token and OpenBao client

**Files:**
- Create: `cli/src/access.ts`, `cli/src/bao.ts`
- Test: `cli/test/access.test.ts`, `cli/test/bao.test.ts`

**Interfaces:**
- Consumes: `Runner` (Task 6), `ROLE` (Task 6).
- Produces:
  - `access.ts`:
    - `class NotLoggedInError extends Error`, with message "Access session missing or expired. Run `secrets login`."
    - `extractJwt(output: string): string | null`: first match of `/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/`
    - `getAccessToken(server: string, deps: { env: Io["env"]; run: Runner }): Promise<string>`: uses `env.SECRETS_ACCESS_JWT` if set; otherwise runs `["cf", "access", "token", server]`. A non-zero exit or no JWT in stdout throws `NotLoggedInError`.
    - `accessLogin(server: string, runInherit: Io["runInherit"]): Promise<void>`: `["cf", "access", "login", server]` with inherited stdio, so the URL shows in WSL. Throws on a non-zero exit.
  - `bao.ts`:
    - `class AccessDeniedError extends Error`, with the same message as `NotLoggedInError`
    - `class BaoError extends Error { status: number }`
    - `type BaoClient = { token: string; readSecret(project: string): Promise<Record<string, string> | null>; writeSecret(project: string, data: Record<string, string>): Promise<void> }`
    - `connect(server: string, accessJwt: string, opts: { fetch: typeof fetch; retries?: number; retryDelayMs?: number }): Promise<BaoClient>`: logs in with `POST {server}/v1/auth/jwt/login` and body `{ role: "owner", jwt }`.
    - Every request sends `cf-access-token: <jwt>`, and requests after login also send `X-Vault-Token`.
    - Requests use `redirect: "manual"`.
    - Responses map to errors like this:
      - 3xx → `AccessDeniedError`
      - 403 with body `{"error":"access denied"}` → `AccessDeniedError`
      - 503 → retry up to `retries` (default 3) after `retryDelayMs` (default 2000); still 503 → `BaoError(503, "OpenBao is still starting; try again")`
      - `readSecret` 404 → `null`
      - any other non-2xx → `BaoError(status, first entry of body.errors or "HTTP <status>")`
    - `readSecret` returns `body.data.data`. `writeSecret` sends `POST /v1/secret/data/<project>` with `{ data }`.

- [ ] **Step 1: Write the failing tests.** `bao.test.ts` uses a `Bun.serve({ port: 0 })` fake that records requests and plays scripted responses.

```ts
test("logs in with role owner and sends cf-access-token everywhere", ...);   // body {role:"owner",jwt:"J"}; header on login and read
test("readSecret returns data.data", ...);                                  // {data:{data:{API_KEY:"abc"}}} → {API_KEY:"abc"}
test("readSecret returns null on 404", ...);
test("writeSecret posts {data}", ...);
test("302 → AccessDeniedError", ...);                                       // Location: https://t.cloudflareaccess.com/cdn-cgi/access/login
test("worker 403 → AccessDeniedError", ...);                                // body {"error":"access denied"}
test("openbao 403 → BaoError", ...);                                        // body {"errors":["permission denied"]}, message "permission denied"
test("retries 503 then succeeds", ...);                                     // 503, 503, 200 with retryDelayMs: 1
test("gives up after retries", ...);                                        // 4×503 → BaoError status 503, message mentions "still starting"
```

```ts
// access.test.ts
test("extractJwt", () => {
  expect(extractJwt("aaa.bbb.ccc\n")).toBe("aaa.bbb.ccc");
  expect(extractJwt('{"token":"aaa.bbb.ccc"}')).toBe("aaa.bbb.ccc");
  expect(extractJwt("no token here")).toBeNull();
});
test("SECRETS_ACCESS_JWT skips cf", async () => { /* run spy never called; returns override */ });
test("calls cf access token <server>", async () => { /* run spy receives ["cf","access","token","https://bao.test"] */ });
test("cf failure → NotLoggedInError", async () => { /* run returns code 1 */ });
```

- [ ] **Step 2: Run them to make sure they fail.** `bun test test/access.test.ts test/bao.test.ts`. Expected: FAIL, modules not found.
- [ ] **Step 3: Implement `access.ts` and `bao.ts` per Interfaces.** Route every HTTP call through one private `request()` helper that does the error mapping and the retries.
- [ ] **Step 4: Run the tests.** `bun test`. Expected: PASS.
- [ ] **Step 5: Check what `cf access token` really prints.** Against any Access-protected URL you have (or after Task 10 Step 4), run `cf access token <url>` once and confirm `extractJwt` finds the token. If `cf` asks for `cf auth login` first, note that in the runbook (Task 10).
- [ ] **Step 6: Commit.** `git add cli && git commit -m "feat(cli): Access token and OpenBao client"`

---

### Task 8: CLI commands and entry point

**Files:**
- Create: `cli/src/context.ts`, `cli/src/process.ts`, `cli/src/commands/login.ts`, `cli/src/commands/run.ts`, `cli/src/commands/pull.ts`, `cli/src/commands/push.ts`, `cli/src/commands/proxy.ts`, `cli/src/main.ts`
- Test: `cli/test/process.test.ts`, `cli/test/commands.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 6–7.
- Produces:
  - `context.ts`:
    - `class UsageError extends Error`
    - `loadContext(io: Io): Promise<{ server: string; project: Project; client(): Promise<BaoClient> }>`
    - With no user config it throws `UsageError("Run \`secrets login --server https://<host>\` first.")`. With no project it throws `UsageError("No .secrets.json found in this directory or any parent.")`.
    - `client()` calls `getAccessToken` and then `connect`.
  - `process.ts`:
    - `buildChildEnv(parent: Io["env"], secrets: Record<string,string>): Record<string,string>`: drops undefined values, lets secrets override the parent, and sets `CLOUDFLARE_INCLUDE_PROCESS_ENV = "true"`.
    - `spawnWithSignals(cmd: string[], env: Record<string,string>, cwd: string): Promise<number>`: inherits stdio and forwards `SIGINT`/`SIGTERM` to the child without exiting the parent. Resolves with the child's exit code, or `128 + signal number` if the child was killed.
  - Commands. Each is `(args: string[], io: Io) => Promise<number>` and returns the exit code: 0 on success, 1 on an error with the message on `io.err`, the child's code for `run`, and 2 for a `UsageError` (message plus a usage hint).
    - `login [--server <url>]`: `normalizeServer`, then `writeUserConfig`, then `accessLogin`.
    - `run -- <cmd...>`:
      1. If `<project.root>/.dev.vars` or `<io.cwd>/.dev.vars` exists, fail with: "Found .dev.vars at <path>. Wrangler ignores injected secrets while it exists; delete it or use `secrets pull` instead."
      2. Read the secret. If it's `null`, fail with: "No secrets stored for project <name>. Run `secrets push` first."
      3. Otherwise `spawnWithSignals(cmd, buildChildEnv(...), io.cwd)`.
    - `pull [--force]`:
      - Writes `serializeDevVars(secret)` to `<project.root>/.dev.vars` with mode `0o600`.
      - If the file exists and `--force` isn't given, fail ("<path> exists; use --force").
      - If `git -C <root> check-ignore -q .dev.vars` exits non-zero inside a git repo, print a warning: ".dev.vars is not gitignored".
      - A `null` secret fails with the same message as `run`.
    - `push [file] [--yes]`:
      1. Parse the file (default `<project.root>/.dev.vars`) and `diffKeys(current ?? {}, parsed)`.
      2. If the diff is empty, print "Nothing to change." and return 0.
      3. Otherwise print `formatDiff`. Without `--yes`: on a non-TTY, fail ("not a terminal; pass --yes"); on a TTY, `confirm("Write N changes to <project>?")`.
      4. Then `writeSecret(project, parsed)`.
    - `proxy [--login] -- <cmd...>`:
      1. Start `Bun.serve({ hostname: "127.0.0.1", port: 0 })`. It forwards method, path, query, body and headers to `server`, and adds `cf-access-token` to every forwarded request.
      2. Run the child with `BAO_ADDR=http://127.0.0.1:<port>`. With `--login`, also set `BAO_TOKEN=client().token`.
      3. Stop the proxy when the child exits, and return the child's code.
  - `main.ts`: `main(argv: string[], io = defaultIo()): Promise<number>`; `--help` prints usage for the five commands; unknown command → 2. File ends with `process.exit(await main(Bun.argv.slice(2)))` guarded by `import.meta.main`.

- [ ] **Step 1: Write the failing tests.** `commands.test.ts` builds a temp project (`.secrets.json` `{"project":"demo"}`), a temp `XDG_CONFIG_HOME` with `{"server":"http://127.0.0.1:<fake port>"}`, `SECRETS_ACCESS_JWT=J`, a fake OpenBao (as in Task 7) holding `secret/data/demo = { API_KEY: "abc", MULTI: "a\nb" }`, and an `Io` that captures `out`/`err`.

```ts
test("run injects secrets and the Wrangler flag", ...);       // cmd: sh -c 'printf %s "$API_KEY|$CLOUDFLARE_INCLUDE_PROCESS_ENV" > out'; out == "abc|true"
test("run passes the child's exit code", ...);                // sh -c 'exit 7' → 7
test("run refuses when .dev.vars exists", ...);               // returns 1, err mentions ".dev.vars", child never ran (no out file)
test("run on an empty project explains", ...);                // fake 404 → 1, err contains "No secrets stored for project demo"
test("pull writes .dev.vars 0600 and round-trips", ...);      // parseDevVars(file) equals stored secret; mode & 0o777 == 0o600
test("pull refuses to overwrite without --force", ...);       // second pull → 1, file unchanged; with --force → 0
test("push without --yes on non-TTY writes nothing", ...);    // returns 1; fake saw no write
test("push --yes writes and prints names only", ...);         // out has "+ NEW", no stored or new value appears in out/err
test("push with no changes says so", ...);                    // out "Nothing to change.", no write
test("proxy gives the child a BAO_ADDR that adds the header", ...); // child: sh -c 'curl -sf "$BAO_ADDR/v1/sys/health" > out'; fake saw cf-access-token: J
test("no server config is a usage error", ...);               // returns 2, err mentions "secrets login --server"
// process.test.ts
test("buildChildEnv: secrets override parent and flag is set", ...);
test("spawnWithSignals forwards SIGTERM", ...);               // child: sh -c 'trap "exit 42" TERM; sleep 5 & wait'; after 200 ms process.emit("SIGTERM") → resolves 42, test process still alive
```

- [ ] **Step 2: Run them to make sure they fail.** `bun test test/commands.test.ts test/process.test.ts`. Expected: FAIL, modules not found.
- [ ] **Step 3: Implement `context.ts`, `process.ts`, the five commands and `main.ts` per Interfaces.**
- [ ] **Step 4: Run the tests and build.** Run: `bun test && bunx tsc --noEmit && bun run build && ../dist/secrets --help`. Expected: all pass, and the binary prints usage listing `login`, `run`, `pull`, `push`, `proxy`.
- [ ] **Step 5: Commit.** `git add cli && git commit -m "feat(cli): login, run, pull, push, proxy"`

---

### Task 9: Local end-to-end and restore drill

**Files:**
- Create: `server/scripts/backup-local.ts`, `server/scripts/restore.ts`, `server/scripts/restore-drill.sh`, `server/test/e2e/lib.sh`, `server/test/e2e/full.sh`
- Modify: `server/test/e2e/container.sh` (source `lib.sh` instead of inlining bring-up)

**Interfaces:**
- Consumes: `queryKvRows` (Task 5), `rowsToNdjson`, `ndjsonToRows` (Task 3), the compose stack and scripts (Task 4), `dist/secrets` (Task 8).
- Produces:
  - `bun scripts/backup-local.ts <postgres-url> <out.ndjson>`: `queryKvRows` → `rowsToNdjson` → file.
  - `bun scripts/restore.ts <in.ndjson> <postgres-url>`:
    - Creates `openbao_kv_store` and its index if missing, using the exact schema from the OpenBao PostgreSQL docs, which is copied into the script.
    - Exits 1 with "target table is not empty" if rows exist.
    - Otherwise inserts every row in one transaction and prints the row count.
  - `bash scripts/restore-drill.sh <backup.ndjson>`:
    1. Requires `BAO_SEAL_KEY`.
    2. Brings up `postgres`, creates database `bao_restore` (`docker compose exec -T postgres createdb -U bao bao_restore`), runs `restore.ts` into it, and starts `openbao-restore` (profile `restore`).
    3. Waits for `200` on `:8201` and prints "Restored OpenBao at http://127.0.0.1:8201". Leaves it running.

    It works for both the local drill and the production drill (Task 11).
  - `test/e2e/lib.sh` shell functions:
    - `stack_up`: generates and exports `BAO_SEAL_KEY`, brings up `postgres` and `openbao`, waits for `501`.
    - `wait_health <port> <code>`
    - `init_and_configure`: exports `ROOT`, configures with the test key, puts the keypair in `$TMP/jwt`.
    - `owner_jwt`: prints a fresh owner token.

- [ ] **Step 1: Write the failing test** `server/test/e2e/full.sh` (sources `lib.sh`, runs `stack_up` and `init_and_configure`). Then:
  1. Build the CLI. Make a temp project with `.secrets.json` `{"project":"demo"}` and a `.dev.vars` holding three keys, including a quoted value with `#` and a multiline value.
  2. Point a temp `XDG_CONFIG_HOME` at `http://127.0.0.1:8200` and set `SECRETS_ACCESS_JWT=$(owner_jwt)`.
  3. `secrets push --yes` exits 0. Delete `.dev.vars`. `secrets run -- sh -c 'printf %s "$MULTI"'` prints exactly the multiline value.
  4. `secrets pull`, then compare `parseDevVars` of the new file with the original via `bun -e`.
  5. Run `bun scripts/backup-local.ts postgres://bao:bao@127.0.0.1:55432/bao "$TMP/b.ndjson"`, then `bash scripts/restore-drill.sh "$TMP/b.ndjson"`. Running `restore.ts` again into `bao_restore` must exit 1.
  6. Log in with a JWT on `:8201` and read `secret/data/demo`. The values must equal the ones pushed in step 3.
- [ ] **Step 2: Run it to make sure it fails.** `bash test/e2e/full.sh`. Expected: FAIL, `test/e2e/lib.sh` not found.
- [ ] **Step 3: Write `lib.sh` and switch `container.sh` to it, then implement `backup-local.ts`, `restore.ts` and `restore-drill.sh` per Interfaces.**
- [ ] **Step 4: Run both integration tests.** `bash test/e2e/container.sh && bash test/e2e/full.sh`. Expected: both pass end to end.
- [ ] **Step 5: Commit.** `git add server && git commit -m "test: local end-to-end and restore drill"`

---

### Task 10: Provision, deploy and first-time setup (owner steps marked **[owner]**)

**Files:**
- Create: `docs/runbook.md`
- Local only, never committed: `server/secrets.env`

**Interfaces:**
- Consumes: everything above.
- Produces: the live service at `https://$BAO_HOSTNAME`, and `docs/runbook.md` recording the exact commands used in each step below, plus key rotation (`previous_key` per the static seal docs) and the restore drill.

- [ ] **Step 1: Pick the hostname.** `cf auth login` if needed, then `cf cli search "list zones"` and list them. **[owner]** picks a zone. `export BAO_HOSTNAME=bao.<zone>`.
- [ ] **Step 2 [owner]: Create the Neon database.** A free-plan project `openbao-cf` in the region closest to the owner. Copy the **direct** (non-pooled) connection string with `sslmode=require`.
- [ ] **Step 3: Generate the seal key.** `openssl rand -hex 32`. **[owner]** saves it in Bitwarden (item `openbao-cf`, field `seal key`) before going on.
- [ ] **Step 4 [owner]: Set up Access, before any deploy.**
  - Make sure a Zero Trust organization exists (create the free one if not).
  - Create a self-hosted Access application for `$BAO_HOSTNAME` with a 24h session, an Allow policy for the owner's email only, and the one-time PIN login method (or an identity provider that already exists).
  - Note the team domain (`https://<team>.cloudflareaccess.com`) and the application's AUD tag. These can be done from the dashboard or via `cf cli search "create access application"`.
- [ ] **Step 5: Fill `server/secrets.env`** with the five values. Run `git status` and expect it **not** listed.
- [ ] **Step 6: Deploy.** `cd server && BAO_HOSTNAME=$BAO_HOSTNAME bunx cf deploy --secrets-file secrets.env`. Expected: Worker, container image and R2 bucket `openbao-cf-backups` are created (provisioned automatically; if not, create the bucket with `cf` and redeploy).
- [ ] **Step 7: Smoke-test the edge.**
  - `curl -sI https://$BAO_HOSTNAME/v1/sys/health` returns a 302 to `*.cloudflareaccess.com`.
  - The `workers.dev` URL for `openbao-cf` doesn't serve the Worker.
  - `secrets login --server https://$BAO_HOSTNAME` completes in the browser.
  - `secrets proxy -- bao status` shows `Initialized false`.
- [ ] **Step 8: Initialize.** `secrets proxy -- bash server/scripts/init.sh`. **[owner]** stores `recovery_keys_b64[0]` and `root_token` in the Bitwarden item, then clears the terminal scrollback.
- [ ] **Step 9: Configure.** `BAO_TOKEN=<root> OWNER_EMAIL=… ACCESS_TEAM_DOMAIN=… ACCESS_AUD=… secrets proxy -- bash server/scripts/configure.sh`. Then `secrets proxy --login -- bao token lookup` lists policies `default` and `owner`.
- [ ] **Step 10: Revoke the root token.** `BAO_TOKEN=<root> secrets proxy -- bao token revoke -self`. A second `bao token lookup` with the root token fails with permission denied.
- [ ] **Step 11: Cold-start check.** Wait at least 15 minutes, then `time secrets proxy --login -- bao secrets list`. Expected: it succeeds, and the time goes in the runbook. If OpenBao was OOM-killed (`npx wrangler tail openbao-cf`, or the Containers dashboard), switch `instanceType` to `"basic"` and redeploy.
- [ ] **Step 12: Write `docs/runbook.md`** from the commands actually run in Steps 1–11. Commit: `git add docs/runbook.md && git commit -m "docs: deployment runbook"`.

---

### Task 11: Move the real project and prove recovery (owner-driven)

**Files:**
- Modify (in the owner's Workers project, not this repo): add `.secrets.json`
- Modify: `docs/runbook.md` (record the drill results)

- [ ] **Step 1 [owner]: Set up the WSL machine.** Install `cf@1.0.0-beta.18` (Node ≥ 22.18) and `cloudflared`. Copy `dist/secrets` to `~/.local/bin/secrets` there, or clone this repo and run `cd cli && bun install && bun run build`.
- [ ] **Step 2 [owner]: Log in on WSL.** `secrets login --server https://$BAO_HOSTNAME`. If no browser opens, copy the printed URL into a Windows browser.
- [ ] **Step 3 [owner]: Push from WSL.** In the Workers project, create `.secrets.json` `{"project":"<name>"}`, then run `secrets push`. Check that the listed key names are the expected ones and confirm. Commit `.secrets.json` in that project.
- [ ] **Step 4 [owner]: Run on this machine.** Clone the project, `secrets login`, then `secrets run -- wrangler dev`. Expected: the Worker starts and the code paths that use the secrets work. No `.dev.vars` exists in the checkout.
- [ ] **Step 5: Check the backup and run the production restore drill (the day after Step 3).**
  - `cf` lists `backups/` in `openbao-cf-backups` and shows today's file.
  - Download it (`cf cli search "download R2 object"`). Then, in `server/`, run `BAO_SEAL_KEY=<from Bitwarden> bash scripts/restore-drill.sh <file>`. It must come up unsealed on `:8201`.
  - The restored server keeps the production JWT config, so log in with a real Access token: `SECRETS_ACCESS_JWT=$(cf access token https://$BAO_HOSTNAME)`, then `POST http://127.0.0.1:8201/v1/auth/jwt/login`, then read `secret/data/<project>`. The key names must match.
  - Fallback if that login fails: `bao operator generate-root` with the recovery key from Bitwarden.
  - `docker compose --profile restore down -v`, then record the result in `docs/runbook.md`.
- [ ] **Step 6 [owner]: Check cost (a week later).** In Billing → Containers usage, memory and disk should sit within the included 25 GiB-hours and 200 GB-hours. In Neon → Usage, compute hours should be far below 100.
- [ ] **Step 7: Commit.** `git add docs/runbook.md && git commit -m "docs: record restore drill"`
