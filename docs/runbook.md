# openbao-cf runbook

Self-hosted OpenBao on Cloudflare Containers at `https://bao.flashblaze.dev`, behind
Cloudflare Access, used for local dev secrets through the `secrets` CLI.

## Where things live

| Thing | Name / location |
|---|---|
| Worker | `openbao-cf` (custom domain `bao.flashblaze.dev`; `workers.dev` and preview URLs off) |
| Container app | `openbao` (`lite`, max 1 instance, sleeps after 10 min idle) |
| Database | Neon project (direct, non-pooled host, `sslmode=verify-full`); table `openbao_kv_store` |
| Backups | R2 bucket `openbao-cf-backups`, `backups/YYYY-MM-DD.ndjson`, daily 03:17 UTC, 30 days kept |
| Access app (API + CLI) | self-hosted `openbao` on `bao.flashblaze.dev`: GitHub login + owner email, 24h session |
| Access app (UI sign-in) | SaaS OIDC `Openbao UI`, redirect `https://bao.flashblaze.dev/ui/vault/auth/oidc/oidc/callback` |
| Worker secrets | `server/secrets.env` (gitignored): `BAO_SEAL_KEY`, `NEON_DATABASE_URL`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `OWNER_EMAIL` |
| Off-Cloudflare keys | Bitwarden item `openbao-cf`: seal key, recovery key. Without the seal key no backup can be decrypted. |

Cloudflare account ID: `bfa55805fd87330adc70a36c2fc285f2` (export as `CLOUDFLARE_ACCOUNT_ID` for `cf`).

## Daily use

```bash
secrets login --server https://bao.flashblaze.dev   # once per machine (prints a token: run in your own terminal)
cd <project with .secrets.json>                     # {"project":"<name>"}
secrets push            # upload ./.dev.vars (shows key names, asks to confirm)
secrets run -- wrangler dev
secrets pull            # write .dev.vars instead (refuses to overwrite without --force)
```

- `run` refuses while any `.dev.vars` or `.dev.vars.<env>` exists, because Wrangler then ignores injected env.
- The first command after a quiet spell wakes the container: expect about 10 s.
- Web UI: `https://bao.flashblaze.dev/ui` → method **OIDC**, role blank → **Sign in** (GitHub popup).

## Admin

Every admin command goes through the local proxy, which adds the Access token:

```bash
cd ~/Work/openbao-cf/server
secrets proxy -- bao status                 # unauthenticated endpoints
secrets proxy --login -- bao secrets list   # as owner (1h token from your Access login)
npx wrangler tail openbao-cf                # live Worker + container logs (cf can't tail yet)
```

If `bao` isn't on PATH: `mise use -g openbao@2.7.1`, or prefix with `mise exec openbao@2.7.1 --`.

## Deploy / redeploy

```bash
cd ~/Work/openbao-cf/server
export CLOUDFLARE_ACCOUNT_ID=bfa55805fd87330adc70a36c2fc285f2 BAO_HOSTNAME=bao.flashblaze.dev
bunx cf deploy --secrets-file secrets.env --containers-rollout immediate
```

- `BAO_HOSTNAME` must be exported for any `cf` command run inside `server/`, because `cloudflare.config.ts` reads it.
- `secrets.env` values: `ACCESS_TEAM_DOMAIN` has no trailing slash, and `OWNER_EMAIL` must match the Access token's `email` claim exactly.
- After a deploy, the container restarts and OpenBao unseals itself (static seal). The first request can take 10–20 s.

### Auto-deploy (GitHub Actions)

- Repo: `flashblaze/openbao-cf` (private).
- `Test` runs the server and CLI tests on every push.
- `Deploy` runs on pushes to `main` that touch `server/**`, or on demand from the Actions tab. It tests, runs `cf deploy`, then checks that Access still guards the hostname.
- CI holds only the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets and the `BAO_HOSTNAME` variable.
- Worker secrets stay on the Worker. `cf deploy` without `--secrets-file` keeps them (tested 2026-10-19).
- To change a Worker secret, deploy locally with `--secrets-file` as above.

## First-time setup (done 2026-10-19, kept for rebuilds)

Order matters: create the Access app before the first deploy, so OpenBao is never exposed.

1. Fill in `server/secrets.env`. Generate the seal key with `openssl rand -hex 32` and save it to Bitwarden first.
2. Deploy (above).
3. In your own terminal, so the keys stay out of logs:
   ```bash
   secrets proxy -- bash scripts/init.sh            # save recovery key + root token in Bitwarden
   read -rsp 'Root token: ' BAO_TOKEN && echo && export BAO_TOKEN
   OWNER_EMAIL=… ACCESS_TEAM_DOMAIN=https://flashblaze.cloudflareaccess.com ACCESS_AUD=… \
     secrets proxy -- bash scripts/configure.sh
   secrets proxy --login -- bao token lookup        # policies [default owner]
   secrets proxy -- bao token revoke -self && unset BAO_TOKEN
   ```
4. UI sign-in. Create the SaaS OIDC Access app, then:
   ```bash
   OIDC_CLIENT_ID=… OIDC_CLIENT_SECRET=… OWNER_EMAIL=… BAO_HOSTNAME=bao.flashblaze.dev \
   ACCESS_TEAM_DOMAIN=https://flashblaze.cloudflareaccess.com \
     secrets proxy --login -- bash scripts/configure-oidc.sh
   ```

## Root token, if you ever need one

The root token is revoked. To mint a new one from the recovery key in Bitwarden:

```bash
secrets proxy -- bao operator generate-root -init          # note the nonce and OTP
secrets proxy -- bao operator generate-root -nonce=<nonce> # paste the recovery key when prompted
bao operator generate-root -decode=<encoded token> -otp=<otp>
```

Revoke it again when you're done.

## Backups

Check that the nightly backup ran. This is the only monitoring; there is no alert:

```bash
cd ~ && cf r2 objects list --bucket-name openbao-cf-backups --prefix backups/
```

Restore drill (do one after the first real backup, then occasionally):

```bash
cd ~ && cf r2 objects get backups/<YYYY-MM-DD>.ndjson --bucket-name openbao-cf-backups > /tmp/b.ndjson
cd ~/Work/openbao-cf/server
read -rsp 'Seal key: ' K && echo && BAO_SEAL_KEY=$K bash scripts/restore-drill.sh /tmp/b.ndjson; unset K
# Restored OpenBao is at http://127.0.0.1:8201 with production config. Log in with your Access token:
J=$(cf access token https://bao.flashblaze.dev)
T=$(curl -s -X POST -d "{\"role\":\"owner\",\"jwt\":\"$J\"}" http://127.0.0.1:8201/v1/auth/jwt/login | jq -r .auth.client_token)
curl -s -H "X-Vault-Token: $T" http://127.0.0.1:8201/v1/secret/data/<project> | jq '.data.data | keys'
BAO_SEAL_KEY=unused docker compose --profile restore down -v && rm /tmp/b.ndjson
```

If the Cloudflare account is lost, dump straight from Neon instead and run the same drill:
`bun scripts/backup-local.ts "$NEON_URL" /tmp/b.ndjson`.

## Gotchas found during deploy

- Neon's **Connect** dialog defaults to the pooled host (`-pooler`). OpenBao uses the direct host. Drop `channel_binding=require` and use `sslmode=verify-full`.
- A browser visit to `bao.flashblaze.dev` doesn't log the CLI in. `secrets login` is separate (it caches a token via `cloudflared`).
- Bun's local proxy used to drop requests after 10 s during cold starts; fixed in `2838668`.

## Deployment log

- 2026-10-19: first deploy, init and configure. UI with GitHub sign-in added. Cold start measured at about 8–9 s through the CLI. Root token revoked (owner confirmed). GitHub Actions auto-deploy set up; first CI deploy succeeded with Worker secrets kept.
