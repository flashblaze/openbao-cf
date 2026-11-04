# Runbook

Day-to-day operation of a deployed openbao-cf instance. Setting one up is in
[deploy.md](deploy.md).

Examples use `bao.example.com` and `<team>.cloudflareaccess.com`; substitute your own.

**Tip:** keep your own instance's values (account ID, hostname, team domain, database region,
which password-manager item holds the keys) in `docs/runbook.local.md`, which is gitignored.

## Where things live

| Thing | Name / location |
|---|---|
| Worker | `openbao-cf` on your custom domain; `workers.dev` and preview URLs off |
| Container app | `openbao` (`lite`, max 1 instance, sleeps after 10 min idle), pinned by `BAO_REGIONS` |
| Database | Neon project (direct, non-pooled host, `sslmode=verify-full`); table `openbao_kv_store` |
| Backups | R2 bucket `openbao-cf-backups`, `backups/YYYY-MM-DD.ndjson`, daily 03:17 UTC, 30 days kept |
| Access app (API + CLI) | self-hosted app on your hostname: your login method + your email |
| Access app (UI sign-in) | SaaS OIDC app, redirect `https://bao.example.com/ui/vault/auth/oidc/oidc/callback` |
| Worker secrets | `server/secrets.env` (gitignored): `BAO_SEAL_KEY`, `NEON_DATABASE_URL`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `OWNER_EMAIL` |
| Off-Cloudflare keys | your password manager: seal key and recovery key. Without the seal key no backup can be decrypted. |
| CI | GitHub Actions: Test, Deploy (`server/**` on `main`), Release (`v*` tags) |
| CLI builds | GitHub Releases, `secrets-<os>-<arch>` + `SHA256SUMS`; installed at `~/.local/bin/secrets` |

## Daily use

```bash
secrets login --server https://bao.example.com   # once per machine (prints a token: run in your own terminal)
cd <project>; secrets init                       # once per repo/app: writes .secrets.json (e.g. myrepo/api)
secrets push            # upload ./.dev.vars (shows key names, asks to confirm)
secrets run -- wrangler dev
secrets pull            # write .dev.vars instead (refuses to overwrite without --force)
secrets push --env staging && secrets run --env staging -- wrangler dev --env staging
secrets envs            # list environments (* = default, "dev" unless .secrets.json sets "defaultEnv")
```

- `run` refuses while any `.dev.vars` or `.dev.vars.<env>` exists, because Wrangler then ignores injected env.
- For apps that read `.env` (Vite, Astro), use `secrets run -- <dev command>`. They read the process
  environment, and process values win over `.env` files.
- Secrets pushed with a CLI older than environments live at `secret/<project>`. Run `secrets migrate` once in those
  projects; `run`, `pull`, `push` and `envs` point you to it.
- The first command after a quiet spell wakes the container: expect a few seconds.
- Web UI: `https://bao.example.com/ui` → method **OIDC**, role blank → **Sign in**.

## Admin

Every admin command goes through the local proxy, which adds the Access token:

```bash
cd server
secrets proxy -- bao status                 # unauthenticated endpoints
secrets proxy --login -- bao secrets list   # as owner (1h token from your Access login)
npx wrangler tail openbao-cf                # live Worker + container logs (cf can't tail yet)
```

If `bao` isn't on PATH: `mise use -g openbao@2.7.1`, or prefix with `mise exec openbao@2.7.1 --`.

## Deploy / redeploy

```bash
cd server
export CLOUDFLARE_ACCOUNT_ID=<account id> BAO_HOSTNAME=bao.example.com BAO_REGIONS=<region, e.g. APAC>
bunx cf deploy --secrets-file secrets.env --containers-rollout immediate
```

- `BAO_HOSTNAME` must be exported for any `cf` command run inside `server/`, because `cloudflare.config.ts` reads it.
- **`BAO_REGIONS` pins the container** to Cloudflare regions near you and your database. The choices are
  `ENAM`, `WNAM`, `EEUR`, `WEUR`, `APAC`, `SAM`, `ME`, `OC` and `AFR`. Without it, Cloudflare picks the location,
  and it can land on another continent.
- `secrets.env`: `ACCESS_TEAM_DOMAIN` has no trailing slash, and `OWNER_EMAIL` must match the Access token's `email` claim exactly.
- After a deploy, the container restarts and OpenBao unseals itself (static seal). The first request can take 10–20 s.
- To see where the container runs: `cf containers applications instances list --application-id <app id>`.

### Auto-deploy (GitHub Actions)

- **`Test`** runs the server and CLI tests on every push and pull request. It uses no secrets.
- **`Deploy`** runs on pushes to `main` that touch `server/**`, or on demand from the Actions tab. It tests, runs
  `cf deploy`, then checks that Access still guards the hostname. The hostname is masked in logs, which matters
  for a public repo.
- **What CI holds:** the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets, plus the `BAO_HOSTNAME` and
  `BAO_REGIONS` variables.
- **Worker secrets stay on the Worker.** `cf deploy` without `--secrets-file` keeps them. To change one, deploy
  locally with `--secrets-file` as above.

### Releasing the CLI

```bash
git tag v1.2.3 && git push origin v1.2.3
```

That one push does all of this:
- **Runs the `Release` workflow:** it runs the CLI tests, then builds `secrets` for `linux-x64`,
  `linux-arm64`, `darwin-arm64` and `darwin-x64` with the tag baked in (`secrets --version`).
- **Publishes a GitHub Release:** the binaries, a `SHA256SUMS` file, and generated notes.

To update a machine:

```bash
gh release download -R <owner>/<repo> -p secrets-linux-x64 -O ~/.local/bin/secrets --clobber \
  && chmod +x ~/.local/bin/secrets && secrets --version
```

## Root token, if you ever need one

The root token is revoked after setup. To mint a new one from the recovery key:

```bash
secrets proxy -- bao operator generate-root -init          # note the nonce and OTP
secrets proxy -- bao operator generate-root -nonce=<nonce> # paste the recovery key when prompted
bao operator generate-root -decode=<encoded token> -otp=<otp>
```

Revoke it again when you're done.

## Backups

Check that the nightly backup ran. This is the only monitoring; there is no alert:

```bash
cf r2 objects list --bucket-name openbao-cf-backups --prefix backups/
```

Restore drill (do one after the first real backup, then occasionally):

```bash
cf r2 objects get backups/<YYYY-MM-DD>.ndjson --bucket-name openbao-cf-backups > /tmp/b.ndjson
cd server
read -rsp 'Seal key: ' K && echo && BAO_SEAL_KEY=$K bash scripts/restore-drill.sh /tmp/b.ndjson; unset K
# Restored OpenBao is at http://127.0.0.1:8201 with production config. Log in with your Access token:
J=$(cf access token https://bao.example.com)
T=$(curl -s -X POST -d "{\"role\":\"owner\",\"jwt\":\"$J\"}" http://127.0.0.1:8201/v1/auth/jwt/login | jq -r .auth.client_token)
curl -s -H "X-Vault-Token: $T" http://127.0.0.1:8201/v1/secret/data/<project>/<env> | jq '.data.data | keys'
BAO_SEAL_KEY=unused docker compose --profile restore down -v && rm /tmp/b.ndjson
```

If the Cloudflare account is lost, dump straight from Neon instead and run the same drill:
`bun scripts/backup-local.ts "$NEON_URL" /tmp/b.ndjson`.

## Lessons from a real deployment

- **Placement decides speed.** One instance landed in US East while its owner and database were in Asia.
  Every request and every database query crossed about 230 ms of round trip, and warm requests took 1.7–4 s.
  - **Fix:** pinning it with `BAO_REGIONS` cut warm requests to well under a second, and the UI's start page from
    7.8 s to about 1 s.
  - The `lite` instance size was never the bottleneck: OpenBao serves its 2.3 MB UI bundle in milliseconds at that size.
- **Neon's Connect dialog defaults to the pooled host** (`-pooler`). OpenBao uses the direct host. Drop
  `channel_binding=require` and use `sslmode=verify-full`.
- **A browser visit to the hostname doesn't log the CLI in.** `secrets login` is separate (it caches a token via
  `cloudflared`).
- **Never run a second OpenBao against the live database** (for example a local container for testing). Two servers
  on one database without HA can corrupt each other's state.
