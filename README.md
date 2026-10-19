# openbao-cf

Self-hosted [OpenBao](https://openbao.org) (the open-source fork of HashiCorp Vault) on
**Cloudflare Containers**, behind **Cloudflare Access**, plus a small CLI called `secrets`.
On any machine, after one browser login, it puts a project's local dev secrets into
`wrangler dev`, or into any other command.

```bash
secrets login --server https://bao.example.com   # once per machine (GitHub/Access in the browser)
cd my-worker && secrets push                      # upload ./.dev.vars once (environment "dev")
secrets run -- wrangler dev                       # anywhere else: no .dev.vars on disk
secrets run --env staging -- wrangler dev --env staging   # other environments, like Infisical's --env
```

## Why

`.dev.vars` is gitignored, so a Workers project's local secrets live on whichever machine
created them. A new laptop or a WSL box means rebuilding the file by hand. Hosted secret
managers solve this, but their free tiers cap projects. Running Vault or OpenBao yourself
normally means a server with a disk, plus unsealing it by hand after every restart.

This repo runs OpenBao where you already deploy Workers, for roughly nothing extra:

- **No disk to manage.** OpenBao's storage is a free Neon Postgres. OpenBao encrypts
  everything before writing it, so the database only ever holds ciphertext.
- **No manual unseal.** The static seal lets OpenBao unlock itself whenever the container restarts.
- **Sleeps when idle.** The container stops after 10 idle minutes and wakes on the next
  request in about 10 s, so it stays inside the Workers Paid plan's included usage.
- **One login.** Cloudflare Access (for example with GitHub) guards the hostname. The same
  Access token also signs you in to OpenBao, so there's no second password.

## Use cases

- **Local dev secrets for Cloudflare Workers projects, across machines.** This is the main
  use: `secrets run -- wrangler dev` injects the values, and `secrets pull` writes
  `.dev.vars` for tools that only read files.
- **Any command that reads env vars:** `secrets run -- npm run dev`, `secrets run -- ./script.sh`.
- **A personal secrets vault with a web UI** at `https://<host>/ui`, with GitHub sign-in.
  You can browse, edit and see the version history of each project's secrets.
- **Admin access with the official `bao` CLI** through `secrets proxy`.

Not built for: production or CI secret delivery, teams (it's single-owner by design), or
dynamic secrets and PKI. OpenBao can do all of those, but this setup doesn't wire them up.

## How it works

```
your machine                    Cloudflare                                        Neon
------------                    ----------                                        ----
secrets CLI ──cf-access-token──▶ Access (your IdP + your email only)
browser (UI) ──cookie──────────▶   │
                                   ▼
                              Worker (bao.<your-domain>)
                                - checks the Access JWT again (issuer, audience, email)
                                - wakes the container, waits until OpenBao is ready
                                - forwards ─────────────────▶ OpenBao container ──▶ Postgres
                                - daily cron 03:17 UTC ─────────────────────────────▶ (read)
                                      │                                         (ciphertext)
                                      ▼
                              R2 bucket: backups/YYYY-MM-DD.ndjson (30 days)
```

Your identity is checked three times: by Access at the edge, by the Worker, and by
OpenBao's JWT auth method, which accepts the same Access token. The `secrets` CLI gets that
token from `cf access token` (a wrapper around `cloudflared`). It logs in to OpenBao, reads
`secret/<project>/<env>` (KV v2), and starts your command with the values in its environment,
setting `CLOUDFLARE_INCLUDE_PROCESS_ENV=true` so Wrangler picks them up.

## The `secrets` CLI

| Command | What it does |
|---|---|
| `secrets login [--server <url>]` | Saves the server URL and opens the Access login in your browser. Under WSL, copy the printed URL. |
| `secrets push [file] [--env <name>] [--yes]` | Uploads `.dev.vars` (or `file`) as the environment's secrets. Shows which **key names** are added, changed or removed, then asks to confirm. |
| `secrets run [--env <name>] -- <cmd...>` | Runs `<cmd>` with the environment's secrets as env vars. Passes through the exit code and Ctrl-C. |
| `secrets pull [--env <name>] [--force]` | Writes `.dev.vars`, or `.dev.vars.<env>` for a non-default environment (mode 0600). Won't overwrite an existing file without `--force`, and warns if the file isn't gitignored. |
| `secrets envs` | Lists the project's environments, marking the default with `*`. |
| `secrets migrate [--yes]` | Moves secrets pushed before environments existed into the default environment: copy, verify, then delete the old copy. |
| `secrets proxy [--login] -- <cmd...>` | Runs `<cmd>` with `BAO_ADDR` pointing at a local proxy that adds your Access token. With `--login`, also sets `BAO_TOKEN`. Use it with `bao`. |

- **Project name:** each project has a committed `.secrets.json`, `{"project": "my-worker"}`
  (lowercase letters, digits, `-` and `_`). Commands find it by walking up from the current directory.
- **Environments:** each project can hold several named sets of secrets, such as `dev`,
  `staging` or `pr-12`, stored at `secret/<project>/<env>`.
  - Commands use `dev` unless you pass `--env <name>`, or set `"defaultEnv"` in `.secrets.json`.
  - The default environment pairs with `.dev.vars`; any other environment `X` pairs with
    `.dev.vars.X`, the file `wrangler dev --env X` reads. For example:
    `secrets run --env staging -- wrangler dev --env staging`.
- **No values in output:** values never appear in the CLI's output, and every message names keys only.
- **`.dev.vars` must be absent:** `run` refuses to start while a `.dev.vars` or `.dev.vars.<env>`
  file exists, because Wrangler ignores injected env vars when one is present.
- **Exact values:** `.dev.vars` values round-trip exactly, including quotes, `#`, `=`, newlines
  and unicode. A value that can't be written safely is refused rather than corrupted.
- **Cold start:** the first command after a quiet spell waits about 10 s for the container.
  The CLI retries while it wakes.
**Install or update** from GitHub Releases. There are builds for `linux-x64` (also WSL),
`linux-arm64`, `darwin-arm64` and `darwin-x64`. The repo is private, so this needs `gh auth login` first.

```bash
gh release download -R flashblaze/openbao-cf -p secrets-linux-x64 -O ~/.local/bin/secrets --clobber \
  && chmod +x ~/.local/bin/secrets && secrets --version
```

Every release also includes a `SHA256SUMS` file. To build from source instead, run
`cd cli && bun install && bun run build`, which produces `dist/secrets` and reports its
version as `dev`.

**On a new machine:**
1. Install `cloudflared` and [`cf`](https://developers.cloudflare.com/cf/) (Node 22.18 or newer).
2. Install `secrets` with the command above.
3. Run `secrets login`.

## Repo layout

```
server/                    Worker + container (deployed with `cf`)
  cloudflare.config.ts     Worker, container (lite, max 1), R2 binding, cron, custom domain
  src/                     Access check, cold-start wait, backups, OpenBao Container class
  container/               Dockerfile (openbao/openbao:2.7.1) and config.hcl
  scripts/                 init.sh, configure.sh, configure-oidc.sh, backup-local.ts,
                           restore.ts, restore-drill.sh
  compose.yaml             local Postgres + OpenBao (+ a restore profile on :8201)
  test/                    unit tests; e2e/ has the Docker integration tests
cli/                       the `secrets` CLI (Bun, TypeScript)
docs/
  deploy.md                deploy your own instance, step by step
  runbook.md               operating the flashblaze.dev instance
  superpowers/             the design spec and implementation plan
.github/workflows/         Test on every push, Deploy server changes on main, Release on v* tags
```

## Develop locally

You don't need a Cloudflare account for this. Prerequisites: [Bun](https://bun.sh) 1.4+,
Docker with Compose, `jq`, `curl`, `openssl`, and the OpenBao CLI `bao` 2.7.1 (for example
`mise use -g openbao@2.7.1`, or a binary from the OpenBao GitHub releases).

```bash
cd server && bun install && bun test && bunx tsc --noEmit
cd ../cli && bun install && bun test && bunx tsc --noEmit && bun run build

# Whole system locally: Postgres + OpenBao in Docker, init, configure with a test key,
# then push / run / pull through the real CLI, back up, restore into a fresh database,
# and read the secrets back from the restored instance.
cd ../server && bash test/e2e/container.sh && bash test/e2e/full.sh
```

The e2e scripts clean up their containers and volumes, even when they fail.

## Deploy your own

See **[docs/deploy.md](docs/deploy.md)**. In short, you need:

- A Cloudflare account on Workers Paid ($5/month).
- A domain on Cloudflare.
- A free Zero Trust organization with an identity provider (for example GitHub).
- A free Neon project.
- A password manager for the seal key.

Then fill in `server/secrets.env`, run `cf deploy`, initialize OpenBao once, and optionally
turn on GitHub Actions auto-deploy and the web UI's GitHub sign-in.

## Security model

**What protects you:**
- Access sits in front of everything.
- The Worker rejects any request without a valid owner Access JWT before it can wake the container.
- OpenBao only issues tokens to the owner's email.
- The root token is revoked after setup.
- The local `proxy` binds to 127.0.0.1 only and rejects foreign `Host` headers.

**Where the keys live:**
- The seal key and Neon URL are Worker secrets, never committed and never given to CI.
  Deploys without `--secrets-file` keep the existing secrets.
- A copy of the seal key and the recovery key belongs in your password manager, outside Cloudflare.

**What's exposed if something leaks:**
- Neon alone, or a leaked backup alone, gives only ciphertext.

**Accepted risk:**
- Someone who takes over your Cloudflare account could read the seal key and the database
  URL, so they could decrypt or delete everything. For a personal dev-secrets store that's
  accepted. Keep 2FA on the Cloudflare account.

## Cost

On top of a Workers Paid plan you already have:

| Item | Usage | Cost |
|---|---|---|
| Container (`lite`, 256 MiB) | sleeps when idle; a few hours a day | ~$0, within the included 25 GiB-hours |
| Container (if it ran 24/7) | | about $1.75/month + CPU |
| Worker + Durable Object requests | one person | ~$0 |
| Neon | free plan: 1 GB, 100 compute-hours/month, suspends after 5 min idle | $0 |
| R2 backups | a few KB a day | $0 (free tier) |
| Cloudflare Access | up to 50 users | $0 |
| GitHub Actions (private repo) | a deploy takes under a minute | $0 (free minutes) |

## Status and limits

- **`cf` is in beta**, and Wrangler is still used for `npx wrangler tail` (live logs).
- **Single owner.** Adding people means extra Access policies, OpenBao roles and policies.
- **Linux x64 CLI build** by default.
- **Backups aren't alerted on.** Check the R2 bucket now and then and run the restore drill
  occasionally (see the runbook).

## Docs

- [docs/deploy.md](docs/deploy.md): deploy your own instance.
- [docs/runbook.md](docs/runbook.md): day-to-day operation of the flashblaze.dev instance
  (backups, restore drill, root token recovery, redeploys).
- [Design spec](docs/superpowers/specs/2026-10-19-openbao-cf-design.md) and
  [implementation plan](docs/superpowers/plans/2026-10-19-openbao-cf.md): the why behind each decision.
