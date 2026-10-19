# Environments for the `secrets` CLI: design addendum

Date: 2026-10-19
Status: draft, awaiting approval (not scheduled; "good to have")
Extends: `2026-10-19-openbao-cf-design.md`

## Intent

Today each project has exactly one set of secrets (`secret/<project>`). Projects often have
more than one: local dev, staging, a preview account. Infisical models this as environments
(`infisical run --env=staging -- …`). This adds the same shape to `secrets`, so one project
can hold several named sets and you pick one per command.

## Goals

- `secrets run --env <name> -- <cmd>`, `secrets pull --env <name>`, `secrets push --env <name>`.
- A per-repo default environment, so everyday commands need no flag.
- Files line up with Wrangler: the default environment ↔ `.dev.vars`, and any other
  environment `X` ↔ `.dev.vars.X` (what `wrangler dev --env X` reads).
- A way to see which environments a project has.
- Secrets pushed before this feature existed are not stranded.

## Non-goals

- Per-environment access control (still single owner, `owner` policy on `secret/*`).
- Syncing an environment to a deployed Worker (production sync).
- `.env` output, or selecting the environment through an environment variable.
- Copying or diffing between environments. Do it with `pull` then `push`, or in the web UI.
- Any server change. The Worker, container, OpenBao policy and backups are untouched. The
  web UI shows each project as a folder of environments.

## Decided (my calls; the owner approved "environments only, like Infisical")

1. **Storage:** `secret/<project>/<env>` in KV v2, one secret per environment, fields = keys.
2. **Environment names:** `^[a-z0-9][a-z0-9_-]{0,31}$`.
3. **Default environment:** `dev`, unless `.secrets.json` sets `"defaultEnv": "<name>"`.
   **Selection:** the `--env` flag, then `defaultEnv`, then `dev`. Both `--env X` and `--env=X` are accepted.
4. **File mapping:** used by `pull` (target) and `push` (default source). The default
   environment maps to `.dev.vars`; any other environment `X` maps to `.dev.vars.X`, in the
   project root.
5. **`run`:** reads the selected environment and injects it. The existing guard is
   unchanged: it refuses if any `.dev.vars` or `.dev.vars.*` exists in the project root or
   cwd. It can't know which `--env` the wrapped Wrangler command will use, so it stays conservative.
6. **`secrets envs`:** lists the project's environment names, one per line, with the default marked.
7. **Legacy data:** secrets pushed before this feature live at `secret/<project>`.
   - When the selected environment is empty and legacy data exists, `run`, `pull` and
     `envs` say so and point to `secrets migrate`.
   - `secrets migrate [--yes]` copies the legacy secret into the default environment and
     checks the copy reads back identically.
   - Then, after confirming, it deletes the legacy secret and its version history.
   - It refuses if the default environment already has data.
8. **Messages name the environment:** "Pushed 4 keys to my-worker (staging)."; "No secrets
   stored for project my-worker (staging). Run `secrets push --env staging` first." The
   hint omits `--env` for the default environment.

## Constraints carried over

- Values are never printed.
- Exit codes:
  - 0 on success;
  - 1 on errors;
  - 2 on usage errors;
  - the child's exit code for `run`.
- `push` asks for confirmation (`--yes` on a non-TTY).
- `pull` won't overwrite without `--force`.
- Files are written with mode 0600 and a gitignore warning.
- `.dev.vars.*` must also be gitignored. The `pull` warning checks the actual file it wrote.

## Left to the builder

- Internal helper names beyond those the plan fixes.
- Test fixture layout.
