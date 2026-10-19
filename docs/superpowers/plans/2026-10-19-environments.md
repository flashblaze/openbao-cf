# Environments for the `secrets` CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Named environments per project (`--env`, a per-repo default, `.dev.vars.<env>` files, `secrets envs`, `secrets migrate`) in the `secrets` CLI, with no server changes.

**Architecture:** Secrets move from `secret/<project>` to `secret/<project>/<env>` in KV v2. The environment is resolved in the CLI from the `--env` flag, then `.secrets.json`'s `defaultEnv`, then `dev`, and every OpenBao client method takes it. Legacy `secret/<project>` data is detected and moved by an explicit `migrate` command.

**Tech Stack:** Bun 1.4.3, TypeScript, `bun test`, the existing fake OpenBao (`cli/test/fake-bao.ts`), Docker e2e (`server/test/e2e/full.sh`) against real OpenBao 2.7.1.

**Spec:** `docs/superpowers/specs/2026-10-19-environments-design.md` (extends `docs/superpowers/specs/2026-10-19-openbao-cf-design.md`)

## Global Constraints

- Storage path: `secret/<project>/<env>`. API paths `/v1/secret/data/<project>/<env>` and `/v1/secret/metadata/<project>/?list=true`; each segment goes through `encodeURIComponent`.
- Environment name regex: `/^[a-z0-9][a-z0-9_-]{0,31}$/`. `DEFAULT_ENV = "dev"`.
- Selection order: `--env` flag, then `.secrets.json` `defaultEnv`, then `"dev"`. Accept `--env X` and `--env=X`. For `run`/`proxy`-style commands, flags come before `--`.
- File mapping: the project's default environment → `<root>/.dev.vars`; any other environment `X` → `<root>/.dev.vars.X`.
- `run`'s `.dev.vars*` guard is unchanged.
- No secret value in any output. Exit codes: 0 / 1 / 2 (usage) / the child's code.
- No changes under `server/` except `server/test/e2e/full.sh`.
- Commit messages end with the session's trailer lines.

## Review Focus

1. **Data pushed before this feature:** `run`/`pull` must not report "no secrets" when legacy `secret/<project>` data exists. They point to `secrets migrate`. Tests: Task 3.
2. **`migrate` must never lose data:** it copies, verifies the read-back is identical, and only then deletes. It refuses if the target environment already has data, and does nothing without confirmation. Tests: Task 3 (fake), plus Task 4 against real OpenBao.
3. **Deleting the legacy secret must not delete the environments below it:** `DELETE /v1/secret/metadata/<project>` removes only that key, not `<project>/dev`. This can only be proven against real OpenBao. Test: Task 4 e2e.
4. **Wrong file for a non-default environment:** `pull --env staging` writes `.dev.vars.staging` and never touches `.dev.vars`. `push --env staging` with no file reads `.dev.vars.staging`. Tests: Task 2.
5. **Typos in environment names:** an invalid `--env` or `defaultEnv` is a usage error (exit 2) that names the bad value, never a silent fallback to `dev`. Tests: Tasks 1–2.

---

### Task 1: Environment model

**Files:**
- Modify: `cli/src/name.ts`, `cli/src/config.ts`, `cli/src/context.ts`
- Test: `cli/test/config.test.ts`, `cli/test/env.test.ts` (new)

**Interfaces:**
- Produces:
  - `name.ts`: `DEFAULT_ENV = "dev"`
  - `config.ts`:
    - `type Project = { name: string; root: string; defaultEnv: string }`. `findProject` reads optional `"defaultEnv"` (default `DEFAULT_ENV`) and throws an `Error` naming the file if it's not a string or fails `validateEnvName`.
    - `validateEnvName(name: string): boolean`
    - `devVarsFileFor(project: Project, env: string): string`
  - `context.ts`:
    - `takeEnvFlag(args: string[]): { env: string | undefined; rest: string[] }`. It removes `--env X` / `--env=X` from `args`. It throws `UsageError("--env needs a value")` when the value is missing, and `UsageError("Invalid environment name: <x>")` when the name fails validation.
    - `resolveEnv(flag: string | undefined, project: Project): string`
    - `noSecretsMessage(project: Project, env: string): string`. Exact text:
      - Default environment: `No secrets stored for project <name> (<env>). Run \`secrets push\` first.`
      - Other environments: `No secrets stored for project <name> (<env>). Run \`secrets push --env <env>\` first.`
      - This replaces the old one-argument version.

- [ ] **Step 1: Write the failing tests.**

```ts
// config.test.ts (additions)
test("defaultEnv defaults to dev", ...);                       // {"project":"p"} → defaultEnv "dev"
test("defaultEnv is read from .secrets.json", ...);            // {"project":"p","defaultEnv":"local"} → "local"
test("invalid defaultEnv throws naming the file", ...);        // "Staging!" → error message contains ".secrets.json"
test.each(["", "Dev", "a/b", "-x", "x".repeat(33)])("rejects env %p", (n) => expect(validateEnvName(n)).toBe(false));
test("devVarsFileFor", () => {
  const p = { name: "p", root: "/r", defaultEnv: "dev" };
  expect(devVarsFileFor(p, "dev")).toBe("/r/.dev.vars");
  expect(devVarsFileFor(p, "staging")).toBe("/r/.dev.vars.staging");
  expect(devVarsFileFor({ ...p, defaultEnv: "local" }, "local")).toBe("/r/.dev.vars");
});
// env.test.ts
test("takeEnvFlag parses both forms and keeps other args", () => {
  expect(takeEnvFlag(["--env", "staging", "--force"])).toEqual({ env: "staging", rest: ["--force"] });
  expect(takeEnvFlag(["--env=prod"])).toEqual({ env: "prod", rest: [] });
  expect(takeEnvFlag(["--yes"])).toEqual({ env: undefined, rest: ["--yes"] });
});
test("takeEnvFlag errors", () => {
  expect(() => takeEnvFlag(["--env"])).toThrow("--env needs a value");
  expect(() => takeEnvFlag(["--env", "Bad!"])).toThrow("Invalid environment name: Bad!");
});
test("resolveEnv precedence", () => {
  const p = { name: "p", root: "/r", defaultEnv: "local" };
  expect(resolveEnv("staging", p)).toBe("staging");
  expect(resolveEnv(undefined, p)).toBe("local");
});
test("noSecretsMessage omits --env for the default", () => {
  const p = { name: "p", root: "/r", defaultEnv: "dev" };
  expect(noSecretsMessage(p, "dev")).toBe("No secrets stored for project p (dev). Run `secrets push` first.");
  expect(noSecretsMessage(p, "qa")).toBe("No secrets stored for project p (qa). Run `secrets push --env qa` first.");
});
```

- [ ] **Step 2: Run them to make sure they fail.** `cd cli && bun test test/config.test.ts test/env.test.ts`. Expected: FAIL (missing exports).
- [ ] **Step 3: Implement everything listed under Interfaces.** The existing callers of `noSecretsMessage` in `run.ts` and `pull.ts` temporarily pass `ctx.project, ctx.project.defaultEnv`, so the build stays green.
- [ ] **Step 4: Run the tests.** `bun test && bunx tsc --noEmit`. Expected: all pass (existing command tests unchanged).
- [ ] **Step 5: Commit.** `git commit -m "feat(cli): environment model (names, default, file mapping)"`

---

### Task 2: Environment-aware client and `run` / `pull` / `push`

**Files:**
- Modify: `cli/src/bao.ts`, `cli/src/commands/run.ts`, `cli/src/commands/pull.ts`, `cli/src/commands/push.ts`, `cli/src/main.ts` (help text), `cli/test/fake-bao.ts` (log `query` too)
- Test: `cli/test/bao.test.ts`, `cli/test/commands.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces, in `bao.ts`:
  - `BaoClient.readSecret(project: string, env: string)`: GET `/v1/secret/data/<project>/<env>`, 404 → `null`.
  - `BaoClient.writeSecret(project: string, env: string, data)`: POST the same path.
  - Usage strings:
    - `secrets run [--env <name>] -- <command...>`
    - `secrets pull [--env <name>] [--force]`
    - `secrets push [file] [--env <name>] [--yes]`
  - Help lines in `main.ts` updated to match.
  - Messages:
    - `pull`: `Wrote <n> keys to <path> (<env>)`, and the gitignore warning uses the written file's base name.
    - `push`: `Pushed <n> keys to <project> (<env>).`, and the confirm prompt is `Write <n> changes to <project> (<env>)?`.

- [ ] **Step 1: Write the failing tests.** Update the existing tests to the new paths (`/v1/secret/data/demo/dev`), then add:

```ts
// bao.test.ts
test("readSecret/writeSecret use <project>/<env>", ...);       // paths /v1/secret/data/demo/staging, encoded segments
// commands.test.ts
test("run --env staging reads the staging secret", ...);       // fake sees GET /v1/secret/data/demo/staging; child sees its value
test("run uses defaultEnv from .secrets.json", ...);           // {"project":"demo","defaultEnv":"local"} → /demo/local
test("run leaves --env after -- to the child", ...);           // `run -- sh -c 'echo "$@"' _ --env x` → child receives "--env x"; env stays default
test("invalid --env is a usage error", ...);                   // exit 2, err contains "Invalid environment name: Bad!", no requests
test("pull --env staging writes .dev.vars.staging only", ...); // file exists with values; .dev.vars absent; out mentions "(staging)"
test("push --env staging reads .dev.vars.staging by default", ...); // fake sees POST /v1/secret/data/demo/staging with that file's keys
test("push --env names the env in the summary", ...);           // out contains "Pushed 2 keys to demo (staging)."
test("no-secrets message names the env", ...);                  // 404 on /demo/qa → err "No secrets stored for project demo (qa). Run `secrets push --env qa` first."
```

- [ ] **Step 2: Run them to make sure they fail.** `bun test test/bao.test.ts test/commands.test.ts`. Expected: FAIL (paths and flags missing).
- [ ] **Step 3: Implement.** Change the `bao.ts` signatures. In each command, call `takeEnvFlag` on the arguments: for `run`, only on the part before `--`; for `pull`/`push`, on all arguments. Then `resolveEnv`, then `devVarsFileFor` for `pull`'s target and `push`'s default file. Add `query` to `Logged` in `fake-bao.ts`.
- [ ] **Step 4: Run the tests.** `bun test && bunx tsc --noEmit && bun run build`. Expected: PASS, and `../dist/secrets --help` shows the new usage lines.
- [ ] **Step 5: Commit.** `git commit -m "feat(cli): --env on run, pull and push"`

---

### Task 3: `secrets envs`, legacy detection and `secrets migrate`

**Files:**
- Create: `cli/src/commands/envs.ts`, `cli/src/commands/migrate.ts`
- Modify: `cli/src/bao.ts`, `cli/src/commands/run.ts`, `cli/src/commands/pull.ts`, `cli/src/main.ts`
- Test: `cli/test/bao.test.ts`, `cli/test/commands.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces:
  - `BaoClient.listEnvs(project): Promise<string[]>`: GET `/v1/secret/metadata/<project>/?list=true`, 404 → `[]`. Returns `data.keys` minus entries ending in `/`, sorted.
  - `BaoClient.readLegacy(project): Promise<Record<string,string> | null>`: GET `/v1/secret/data/<project>`, 404 → `null`.
  - `BaoClient.deleteLegacy(project): Promise<void>`: DELETE `/v1/secret/metadata/<project>`.
  - `legacyHint(project: string): string` in `context.ts`, with exact text: `Found secrets for <project> stored before environments existed. Run \`secrets migrate\` to move them into the default environment.`
  - `secrets envs`: prints one environment per line. The default gets a `* ` prefix; others get two spaces.
    - With no environments: `No environments for project <name>.`, plus `legacyHint` on stderr if legacy data exists.
    - Exit code 0.
  - `run`/`pull`: when the selected environment reads `null` *and* it is the default environment *and* `readLegacy` is non-null, print `legacyHint` instead of the no-secrets message. Exit 1.
  - `secrets migrate [--yes]`:
    1. If there's no legacy data, print `Nothing to migrate.` and exit 0.
    2. If the default environment already has data, refuse: `<project> (<env>) already has secrets; resolve manually in the web UI.` Exit 1.
    3. Print the key names to be moved (via `formatDiff` against `{}`).
    4. Confirm. Without `--yes`, a non-TTY is refused with `not a terminal; pass --yes`; on a TTY the prompt is `Move <n> keys from <project> to <project> (<env>) and delete the old copy?`.
    5. `writeSecret(project, env, legacy)`, then `readSecret(project, env)`, and deep-compare with the legacy data. On mismatch, exit 1 with `Copy verification failed; old secret kept.` and do not delete.
    6. `deleteLegacy(project)`, then print `Migrated <n> keys to <project> (<env>).`

- [ ] **Step 1: Write the failing tests.**

```ts
test("listEnvs drops folders and sorts", ...);                       // keys ["staging","dev","sub/"] → ["dev","staging"]
test("envs marks the default", ...);                                 // out "* dev\n  staging\n"
test("envs with none prints a message and the legacy hint", ...);    // 404 list + legacy 200 → out "No environments…", err has legacyHint
test("run points to migrate when only legacy data exists", ...);     // /demo/dev 404, /demo 200 → exit 1, err === legacyHint, child never ran
test("run on a non-default env doesn't check legacy", ...);          // /demo/qa 404 → normal no-secrets message, no GET /v1/secret/data/demo
test("migrate moves, verifies, then deletes", ...);                  // order: GET legacy, GET dev(404), POST dev, GET dev, DELETE metadata/demo
test("migrate refuses when dev already has data", ...);              // no POST, no DELETE, exit 1
test("migrate keeps the old copy if verification fails", ...);       // read-back differs → exit 1, no DELETE
test("migrate on non-TTY without --yes writes nothing", ...);        // exit 1, no POST
test("migrate with nothing to do", ...);                             // legacy 404 → "Nothing to migrate.", exit 0
test("migrate output names keys, never values", ...);
```

- [ ] **Step 2: Run them to make sure they fail.** `bun test test/bao.test.ts test/commands.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the client methods, `envs.ts`, `migrate.ts`, the legacy check in `run`/`pull`, and the help lines in `main.ts`.**
  - New help lines: `secrets envs` ("List the project's environments") and `secrets migrate [--yes]` ("Move pre-environment secrets into the default environment").
- [ ] **Step 4: Run the tests.** `bun test && bunx tsc --noEmit && bun run build`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(cli): secrets envs and secrets migrate"`

---

### Task 4: End-to-end against real OpenBao, and docs

**Files:**
- Modify: `server/test/e2e/full.sh`, `README.md`, `docs/deploy.md` (section 8), `docs/runbook.md` (Daily use)

**Interfaces:**
- Consumes: Tasks 1–3 (the built `dist/secrets`).

- [ ] **Step 1: Extend `full.sh` (it should fail before Tasks 1–3 are merged and pass after).** After the existing push/run/pull checks, which now use the default environment `dev`:
  1. `push --yes --env staging` from a `.dev.vars.staging`. Then `run --env staging -- sh -c 'printf %s "$API_KEY"'` returns the staging value, and `run` without `--env` still returns the dev value.
  2. `secrets envs` prints `* dev` and `  staging`.
  3. **Legacy migration against real OpenBao:**
     - Write a legacy secret with `curl` to `/v1/secret/data/legacyproj`, using the owner token from `jwt_login`.
     - Make a project dir with `{"project":"legacyproj"}`. `secrets run -- true` exits 1 with the legacy hint.
     - `secrets migrate --yes` exits 0.
     - `/v1/secret/data/legacyproj/dev` holds the same keys. `/v1/secret/data/legacyproj` is now 404.
     - **`/v1/secret/data/legacyproj/dev` still exists after the delete** (Review Focus 3).
  4. The backup → restore part still runs after this, and the restored instance returns `demo/staging` too.
- [ ] **Step 2: Run it.** `cd server && bash test/e2e/container.sh && bash test/e2e/full.sh`. Expected: PASS, with no containers left behind.
- [ ] **Step 3: Update the docs.**
  - README CLI table: `--env` on run/pull/push, plus `envs` and `migrate`, and a short "Environments" paragraph covering default `dev`, `defaultEnv`, the file mapping, and that `run` refuses on any `.dev.vars*`.
  - `deploy.md` section 8: one `--env staging` example.
  - Runbook daily use: the same, plus "after upgrading the CLI, run `secrets migrate` in projects pushed before environments existed".
- [ ] **Step 4: Commit.** `git commit -m "test,docs: environments end to end"`

---

## Self-review notes

- **Spec coverage:**
  - Decisions 1–4 → Task 1 (+ Task 2 paths).
  - Decisions 5 and 8 → Task 2.
  - Decisions 6–7 → Task 3.
  - Server untouched; the real-OpenBao proof → Task 4.
- **Type consistency:**
  - `Project.defaultEnv` is added in Task 1 and used by `devVarsFileFor`, `resolveEnv`, `noSecretsMessage` and `migrate`.
  - `readSecret`/`writeSecret` gain `env` in Task 2 and are used unchanged in Task 3.
- **Ordering risk:** if real projects are pushed before this lands, they become legacy data. Task 3's `migrate` plus Task 4's e2e cover that path.
