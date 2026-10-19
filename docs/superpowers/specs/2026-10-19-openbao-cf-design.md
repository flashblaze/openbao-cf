# Self-hosted OpenBao on Cloudflare Containers: design

Date: 2026-10-19
Status: draft, awaiting approval

## Intent

Local dev secrets for Cloudflare Workers projects live in `.dev.vars`, which is
gitignored. When the owner moved to a new machine, the `.dev.vars` for one of
their Workers projects stayed behind on the old one, so the project couldn't run
until the file was rebuilt by hand.

This project puts those secrets in one self-hosted place, OpenBao on Cloudflare
Containers, and adds a small command-line tool. On any machine, after one
browser login, a single command fetches a project's secrets and starts the dev
server with them.

Earlier research (a separate session, 2026-10-18) picked OpenBao over Infisical
and Phase because it's a single small binary that can keep its data in an
external Postgres, encrypts everything before writing it, and can unseal itself
on restart with the static seal. That suits a container with no persistent disk.

## Users

One person, the owner. No teammates for now.

## Success looks like

1. On the old machine: install the CLI, log in, `push` the existing `.dev.vars`
   for that Workers project.
2. On this machine: clone the project, log in once through the browser, run
   `<cli> run -- wrangler dev`. The Worker starts with its secrets and no
   `.dev.vars` file is written to disk.
3. The monthly bill stays within the existing $5 Workers Paid plan, or very
   close to it.

## Goals

- Store local dev secrets per project, in one place, reachable from any of the
  owner's machines.
- One browser login per machine (Cloudflare Access). No second password.
- One command to run a dev process with secrets injected as environment
  variables.
- A `pull` fallback that writes `.dev.vars` for tools that only read files.
- A `push` command that uploads an existing `.dev.vars`.
- No manual unsealing, ever. OpenBao restarts and unlocks itself.
- Off-Cloudflare recovery: the data can be restored even if the Cloudflare
  account or the Neon database is lost.

## Non-goals (for now)

- Production secrets (`wrangler secret put`) and CI/CD.
- Other users, teams, per-person access rules.
- High availability, multiple OpenBao instances.
- Multiple environments per project (`.dev.vars.<env>`). The layout should not
  make this hard to add later.
- Dynamic secrets, PKI, or any OpenBao engine beyond KV.

## Anti-goals (failure even if it technically works)

- Secrets lost: a restart, a month of not using it, or a provider pausing the
  database wipes or locks away the data.
- Secrets reachable without the Access login.
- Needing babysitting: manual unseal, a paused database to click back on.
- Monthly cost creeping beyond a couple of dollars over the $5 plan.

## Constraints

- **Cloudflare Workers Paid plan ($5/month).** Containers include 25 GiB-hours
  memory, 375 vCPU-minutes and 200 GB-hours disk per month. Beyond that:
  $0.0000025/GiB-s memory, $0.000020/vCPU-s CPU, $0.00000007/GB-s disk.
- **Container disk is ephemeral.** Every sleep or restart starts from a clean
  image. All state must live outside the container.
- **Neon free plan** for Postgres: 1 GB storage per project, 100 CU-hours per
  month per project, 5 GB egress per project, compute suspends after 5 minutes
  inactive and wakes in a few hundred ms. Going over a limit suspends compute
  until next month (no data loss). Restore history is only 6 hours.
- **`cf` CLI is in beta** (1.0.0-beta.18 installed). Its commands and config can
  change. It can't stream logs (`npx wrangler tail` instead) or set a single
  secret (use `cf deploy --secrets-file`).
- **The owner's existing Workers projects stay on Wrangler.** The docs warn that
  `cf dev`/`cf build`/`cf deploy` can break an unmigrated Wrangler project. The
  CLI must work with `wrangler dev` today and `cf dev` later.
- Installed locally: `cf`, `wrangler` 4.151.1, `cloudflared`, `bun` 1.4.3,
  Docker 29.9.1, `jq`.
- **Both of the owner's machines are Linux x64**: this one natively, the old one
  under WSL. The CLI only needs a Linux x64 build. `cf` (or `cloudflared`) must
  be installed on the WSL machine too.

## Decided

### By the owner

- OpenBao, hosted on Cloudflare Containers.
- Neon free plan for Postgres (over Postgres in a container, which is about the
  same cost but loses data, and over Supabase/Aiven/Prisma free tiers, which
  pause or power off after inactivity).
- Everything behind Cloudflare Access.
- Browser login, once per machine.
- Just local dev for now.
- Use the `cf` CLI for this project.
- Someone taking over the Cloudflare account and deleting the live data and the
  backups is out of scope. No backup copy outside Cloudflare is needed beyond the
  keys in Bitwarden.
- The container and database may sleep when idle; a few seconds of wait on the
  first fetch after a break is fine.
- The overall shape below (played back in conversation and approved).
- Web UI on, with GitHub sign-in (added 2026-10-19, after the first deploy): a
  Cloudflare Access "SaaS / OIDC" application is the OIDC provider for an
  OpenBao `oidc` auth method whose `owner` role is bound to the owner's email
  (`server/scripts/configure-oidc.sh`).

### My calls (approved as part of the playback, but flagged so they're easy to revisit)

- Container sleeps after about 10 minutes idle.
- Daily backup to R2, 30 days kept.
- Static seal key and OpenBao recovery keys also stored in the owner's
  Bitwarden vault (they have Bitwarden Premium).
- CLI written in TypeScript on Bun.
- CLI command name is a placeholder (`secrets` in this doc).
- Access login method: one-time PIN to the owner's email, unless the account
  already has an identity provider set up in Zero Trust, in which case use that.
  If there's no Zero Trust organization yet, create one (free for up to 50
  users).
- Domain: a zone already in the owner's Cloudflare account, chosen at build time
  by listing the account's zones.
- Startup wait: the Worker treats OpenBao as ready when `/v1/sys/health` answers
  200 (ready) or 501 (not initialized yet, needed for the one-time setup). It
  keeps waiting on 503 (sealed) and connection errors, up to a timeout.

## Architecture

```
laptop                          Cloudflare                                  Neon
------                          ----------                                  ----
<cli> --cf-access-token-->  Access (email policy)
                                 |
                                 v
                            Worker (custom domain)
                              - verifies Access JWT
                              - forwards to container ----> OpenBao container --> Postgres
                              - daily cron: backup -------------------------------> (read)
                                    |                                               
                                    v                                              
                                 R2 bucket (encrypted backups)
```

### Edge: Access + Worker

- One subdomain on a zone in the owner's Cloudflare account, e.g.
  `bao.<domain>`, attached to the Worker as a custom domain.
- A self-hosted Access application on that hostname. Policy: allow only the
  owner's email. Session duration: builder's call (24h is a sensible default).
- `workers_dev` and preview URLs disabled, so the only way in is through Access.
- The Worker verifies the `Cf-Access-Jwt-Assertion` header on every request
  (JWKS at `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, issuer
  `https://<team>.cloudflareaccess.com`, audience = the Access app's AUD tag,
  and the `email` claim equals the owner's email). Reject anything else with
  403 before touching the container. This is a second check behind Access.
- The Worker forwards the request, including the Access JWT header, to the
  single OpenBao container instance (one fixed instance name, `max_instances`
  = 1).
- On a cold start the Worker waits until OpenBao reports itself initialized and
  unsealed (`/v1/sys/health`) before forwarding, so the first request after
  sleep succeeds instead of failing.

### Container: OpenBao

- Default scheduling policy (the `durable_object` policy is beta and only needed
  for snapshots, which we don't use). Configured through `cloudflare.config.ts`
  with `defineContainer()` and a Durable Object export, deployed with
  `cf deploy`.
- Instance type `lite` (256 MiB, 1/16 vCPU, 2 GB disk). If OpenBao runs out of
  memory, step up to `basic` (1 GiB, 1/4 vCPU).
- Official OpenBao image, pinned to an exact version tag.
- `sleepAfter` about 10 minutes.
- OpenBao config:
  - `storage "postgresql"` with the connection URL from an env var
    (`BAO_PG_CONNECTION_URL`), `ha_enabled = false`, and no idle connections
    held (`max_idle_connections = 0`) so Neon can suspend. Increase
    `max_connect_retries` so OpenBao tolerates Neon waking up.
  - `seal "static"` with `current_key = "env://..."`. The key is 32 random bytes,
    generated once, passed in from a Worker secret.
  - Listener on the container port with TLS disabled (TLS ends at Cloudflare's
    edge; Worker-to-container traffic is internal).
  - `disable_mlock = true` (containers usually can't mlock).
- Worker secrets (uploaded with `cf deploy --secrets-file`, never committed):
  the static seal key, the Neon connection string, plus the Access team domain
  and AUD tag as plain config.
- The container needs outbound internet to reach Neon and the Access JWKS URL.

### OpenBao setup (one time)

- Initialize with the static seal. That produces recovery keys and a root token.
  Store the recovery keys and the seal key in Bitwarden.
- Enable KV v2 at `secret/`. One path per project: `secret/<project>`, all keys
  of that project's `.dev.vars` stored as fields of one secret. KV v2 keeps
  versions, so a bad `push` can be rolled back.
- Enable the JWT auth method, pointed at the Access JWKS URL, with bound issuer
  = team domain. One role (e.g. `owner`): `role_type = "jwt"`, bound audience =
  the Access AUD tag, `user_claim = "email"`, bound claim `email` = the owner's
  email, short token TTL (about 1h).
- One policy for that role: read/write on `secret/data/*` and
  `secret/metadata/*`, and enough admin rights to manage the server, so the root
  token isn't needed afterwards.
- Enable an audit device that writes to stdout, so requests show up in Workers
  Logs.
- Revoke the root token when setup is done. A new one can be generated from the
  recovery keys if ever needed.

### Backups

- A `scheduled` handler (daily cron) on the same Worker reads every row of the
  `openbao_kv_store` table from Neon and writes one file per day to a private
  R2 bucket. Keep 30 days (lifecycle rule or cleanup in the same job).
- The rows are already encrypted by OpenBao, so the backup is ciphertext. It is
  only useful together with the seal key, which is why the seal key also lives
  in Bitwarden.
- The plan must include a restore drill: restore a backup into a fresh Neon
  database, point a local OpenBao at it with the seal key from Bitwarden, and
  read a secret back.

### CLI (`secrets`, placeholder name)

Config:
- Server URL in a per-user config file (set once, e.g. on first `login`).
- Project name in a small file committed to each repo, e.g. `.secrets.json`
  `{ "project": "<name>" }`. Commands find it by walking up from the current
  directory.

Commands:
- `login`: runs `cf access login <url>` (browser). That's the only interactive
  login. Under WSL the browser may not open by itself, so the login URL must be
  visible in the terminal to copy into a Windows browser.
- `run -- <cmd...>`: gets the Access JWT with `cf access token <url>`, logs in to
  OpenBao (`POST /v1/auth/jwt/login` with the JWT, header `cf-access-token` set
  to the same JWT so Access lets the request through), reads
  `secret/data/<project>`, then starts `<cmd>` with those values added to its
  environment and `CLOUDFLARE_INCLUDE_PROCESS_ENV=true` so Wrangler picks them
  up. Passes through the child's stdin/stdout/stderr, signals and exit code.
  - Wrangler only reads the process environment when there is no `.dev.vars`
    file, so `run` warns (or stops) if one exists in the project.
  - If the Access token is missing or expired, say so and offer to run `login`.
- `pull`: writes the project's secrets to `.dev.vars`. Refuses to overwrite an
  existing file without a flag. Checks `.dev.vars` is gitignored and warns if
  not.
- `push [file]`: parses a `.dev.vars` (dotenv format, default `./.dev.vars`),
  shows which keys would be added, changed or removed, asks for confirmation,
  and writes a new KV version.
- An admin escape hatch: a way to run the official `bao` CLI against the server,
  e.g. a small local proxy that adds the `cf-access-token` header and sets
  `BAO_ADDR` for a child `bao` process. The OpenBao one-time setup above can use
  it.

The OpenBao token from login is kept in memory for the duration of a command
and not written to disk. The Access JWT is cached by `cloudflared`, as it
normally is.

`cf access login/token` wrap `cloudflared`. If `cf` changes those commands
during its beta, calling `cloudflared access login/token` directly is a drop-in
fallback.

## Cost estimate

| Scenario | Extra per month |
|---|---|
| Container asleep most of the time (a few hours of use a day) | about $0, inside included usage |
| Container running 24/7 (`lite`) | about $1.75 + CPU, and Neon would likely run out of free compute-hours |
| Neon, R2 (a few KB of backups), Worker and Durable Object requests | about $0 at one person's usage |

## Security notes

- Access in front, Worker verifying the Access JWT, OpenBao verifying it again
  through the JWT auth method. Three checks of the same identity.
- Someone with the owner's Cloudflare account could read the seal key and the
  Neon URL and so decrypt everything, or delete the live data and the backups.
  Both are accepted for a personal dev-secrets store. Keep 2FA on the Cloudflare
  account.
- Neon alone (or a leaked backup alone) gives only ciphertext.
- Nothing listens publicly except the Worker; the container is reachable only
  through its Durable Object.

## Left to the builder

- Repo layout. A sensible default: `server/` (Worker, Dockerfile, OpenBao
  config, `cloudflare.config.ts`) and `cli/` (Bun TypeScript), in this repo.
- Exact OpenBao version, Neon region, Access session length, sleep timeout
  within "about 10 minutes".
- Postgres client used by the backup job.
- How the CLI is built and installed (e.g. `bun build --compile` for Linux x64
  into `~/.local/bin`).
- Local testing approach for the Worker + container (`cf dev` with Docker is
  available).
- Backup file format, as long as the restore drill works.
