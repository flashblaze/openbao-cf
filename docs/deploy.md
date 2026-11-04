# Deploy your own

This sets up your own `bao.<your-domain>` from scratch. It takes about an hour, most of it
clicking through dashboards. Replace `example.com` with your domain throughout.

Two rules that matter for security:
- **Order:** create the Access application *before* the first deploy, so OpenBao is never
  reachable without it, not even before it's initialized.
- **Keys stay out of chat and logs:** run the steps that print keys (`init.sh`,
  `secrets login`) in your own terminal, not through an AI agent or a CI log, and put the
  output straight into your password manager.

## Before you start

- **Cloudflare:** an account on **Workers Paid** (Containers need it), with your domain active on it.
- **Zero Trust:** a Cloudflare Zero Trust organization (the free plan is fine) with at least
  one identity provider, for example GitHub.
- **Neon:** an account (the free plan is fine).
- **On your machine:**
  - Bun 1.4+, Docker, `jq`, `curl`, `openssl`.
  - `cloudflared`.
  - [`cf`](https://developers.cloudflare.com/cf/) (Node 22.18+), signed in with `cf auth login`.
  - `bao` 2.7.1.
- **A password manager** for the seal key and the recovery key.

```bash
git clone <this repo> && cd openbao-cf
(cd server && bun install && bun test) && (cd cli && bun install && bun test && bun run build)
install -m 0755 dist/secrets ~/.local/bin/secrets   # or a release build, see the README
```

## 1. Database (Neon)

1. Create a Neon project. Then **Connect**, choose your branch, database and role, and turn
   **Connection pooling off**.
2. Copy the connection string, then change its parameters:
   - Keep the direct host (no `-pooler` in the host name).
   - Replace `sslmode=require` with `sslmode=verify-full`, so the server certificate is checked.
   - Remove `channel_binding=require`.

   It should look like
   `postgresql://<user>:<password>@ep-xxxx.<region>.aws.neon.tech/neondb?sslmode=verify-full`.

OpenBao creates its own tables on first start.

## 2. Cloudflare Access application

In Zero Trust go to **Access controls → Applications → Create new application → Self-hosted**.

- **Domain:** `bao.example.com`
- **Session duration:** 24h
- **Policy:** Allow. Include your login method (for example GitHub), and **Require** email = your email.

Note two values:
- **Team domain:** `https://<team>.cloudflareaccess.com`, shown in Zero Trust settings or as
  `auth_domain` in `cf zero-trust organization get`.
- **Application Audience (AUD) tag:** in the application's **Configure → Additional settings**,
  or `aud` in `cf zero-trust access applications get <app-id>`.

## 3. Worker secrets

```bash
cd server
cp secrets.env.example secrets.env && chmod 600 secrets.env   # gitignored
openssl rand -hex 32                                          # → BAO_SEAL_KEY
```

| Variable | Value |
|---|---|
| `BAO_SEAL_KEY` | the 64 hex characters you just generated. **Save it in your password manager now.** Without it no backup can ever be decrypted. |
| `NEON_DATABASE_URL` | the edited URL from step 1 |
| `ACCESS_TEAM_DOMAIN` | `https://<team>.cloudflareaccess.com`, with **no trailing slash** |
| `ACCESS_AUD` | the AUD tag |
| `OWNER_EMAIL` | your email, **exactly** as your identity provider reports it (OpenBao's match is case-sensitive) |

Optional check, **only before the first deploy**: boot OpenBao locally against Neon. Health
should return 501 (not initialized). Never run this once the deployed instance is using the
database: two OpenBao servers on one database without HA can corrupt each other's state.

```bash
docker build -t openbao-cf-local ./container
docker run --rm -d --name bao-check -p 127.0.0.1:18200:8200 \
  --env-file <(sed -n 's/^NEON_DATABASE_URL=/BAO_PG_CONNECTION_URL=/p; /^BAO_SEAL_KEY=/p' secrets.env) \
  openbao-cf-local
sleep 5; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18200/v1/sys/health   # 501
docker rm -f bao-check
```

## 4. Deploy

```bash
export CLOUDFLARE_ACCOUNT_ID=<your account id> BAO_HOSTNAME=bao.example.com BAO_REGIONS=APAC   # region nearest you and Neon
bunx cf deploy --secrets-file secrets.env --containers-rollout immediate
```

This creates:
- the Worker `openbao-cf` on the custom domain, with `workers.dev` and preview URLs off;
- the container application `openbao`;
- the R2 bucket `openbao-cf-backups`;
- the daily backup cron.

Any `cf` command run inside `server/` needs `BAO_HOSTNAME` set, because `cloudflare.config.ts` reads it.

**Set `BAO_REGIONS`** to the Cloudflare region nearest you and your Neon database. The choices are
`ENAM`, `WNAM`, `EEUR`, `WEUR`, `APAC`, `SAM`, `ME`, `OC` and `AFR`; a comma list is allowed. Unpinned,
Cloudflare picks the location, which can be another continent: every request and query then pays that
round trip.

Check that only Access gets through:

```bash
curl -sI https://bao.example.com/v1/sys/health | head -1   # 302 → <team>.cloudflareaccess.com
cf workers secrets list --script-name openbao-cf            # the five names
```

## 5. Sign in and initialize (in your own terminal)

```bash
secrets login --server https://bao.example.com   # browser login; cloudflared prints a token
secrets proxy -- bao status                      # Initialized: false

secrets proxy -- bash scripts/init.sh            # prints recovery key + root token ONCE
```

Put `recovery_keys_b64[0]` and `root_token` in your password manager, then clear the terminal.

```bash
read -rsp 'Root token: ' BAO_TOKEN && echo && export BAO_TOKEN
OWNER_EMAIL=you@example.com ACCESS_TEAM_DOMAIN=https://<team>.cloudflareaccess.com \
ACCESS_AUD=<aud> secrets proxy -- bash scripts/configure.sh
secrets proxy --login -- bao token lookup        # policies [default owner]
secrets proxy -- bao token revoke -self          # retire the root token
unset BAO_TOKEN
```

`configure.sh` sets up:
- KV v2 at `secret/`;
- the JWT auth method that trusts your Access tokens;
- the `owner` policy and role.

It's safe to re-run.

## 6. Optional: web UI with GitHub sign-in

1. In Zero Trust, create **Access controls → Applications → SaaS application**:
   - **Name:** a custom name such as "OpenBao UI".
   - **Protocol:** **OIDC**.
   - **Scopes:** `openid email profile`.
   - **Redirect URL:** `https://bao.example.com/ui/vault/auth/oidc/oidc/callback`
   - **Policy:** the same as step 2. Turn on instant authentication if you use a single identity provider.
2. Then run:

   ```bash
   OIDC_CLIENT_ID=<client id> OIDC_CLIENT_SECRET=<client secret> OWNER_EMAIL=you@example.com \
   BAO_HOSTNAME=bao.example.com ACCESS_TEAM_DOMAIN=https://<team>.cloudflareaccess.com \
     secrets proxy --login -- bash scripts/configure-oidc.sh
   ```

3. To sign in, open `https://bao.example.com/ui`, choose **OIDC**, leave the role blank, and
   click **Sign in**.

## 7. Optional: auto-deploy from GitHub

The workflows in `.github/workflows/` test every push and deploy `server/` changes on `main`.
CI never holds your Worker secrets, because `cf deploy` without `--secrets-file` keeps them.

1. **Create an account API token** with these permissions:
   - **Account:** Workers Scripts Edit, Containers Edit, Workers R2 Storage Edit, Account Settings Read.
   - **Zone:** Workers Routes Edit, scoped to your domain.
2. **Store it in the repo:**
   ```bash
   gh secret set CLOUDFLARE_API_TOKEN          # paste at the hidden prompt
   gh secret set CLOUDFLARE_ACCOUNT_ID --body <account id>
   gh variable set BAO_HOSTNAME --body bao.example.com
   gh variable set BAO_REGIONS --body APAC
   ```
3. **Push to `main`, or run "Deploy" from the Actions tab.** The workflow ends by checking that
   the hostname still redirects to Access.

To change a Worker secret later, deploy from your machine with `--secrets-file`, as in step 4.

The same repo also has a `Release` workflow. Pushing a `v*` tag (`git tag v0.1.0 && git push
origin v0.1.0`) builds `secrets` for Linux and macOS and attaches the builds to a GitHub
Release. It needs no extra secrets, because it uses the workflow's own token.

## 8. Use it

```bash
cd my-worker
secrets init && git add .secrets.json   # suggests the name; monorepo apps get <repo>/<app>
secrets push                 # from the machine that has .dev.vars
rm .dev.vars                 # `run` refuses while a .dev.vars exists (Wrangler would ignore the injected env)
secrets run -- wrangler dev

# Other environments: push .dev.vars.staging, then pick it per command
secrets push --env staging   # reads .dev.vars.staging
secrets run --env staging -- wrangler dev --env staging
secrets envs                 # * dev / staging
```

## 9. Backups

After the first 03:17 UTC run, check the bucket, then do one restore drill so you know
recovery works (the runbook's "Backups" section has the full commands):

```bash
cf r2 objects list --bucket-name openbao-cf-backups --prefix backups/
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| OpenBao logs show it can't reach Postgres | Pooled URL (`-pooler` in the host) or `channel_binding=require`. Use the direct host and `sslmode=verify-full`. |
| JWT login says the issuer doesn't match | `ACCESS_TEAM_DOMAIN` has a trailing slash. Fix it in `secrets.env` and `configure.sh`, then redeploy and re-run. |
| Login works in the browser but `secrets` says "Access session missing or expired" | The browser and the CLI log in separately. Run `secrets login`. |
| `cf` fails with "BAO_HOSTNAME is required" | You ran `cf` inside `server/` without exporting `BAO_HOSTNAME`. |
| OpenBao rejects your login for the `owner` role | `OWNER_EMAIL` doesn't exactly match your token's `email` claim (case matters). |
| First command after a break takes about 10 s | The container is waking up. That's expected; it sleeps after 10 idle minutes. |
| Everything is slow, even warm requests | Check where the container runs (`cf containers applications instances list --application-id <app id>`). If it's far from you or Neon, set `BAO_REGIONS` and redeploy. |
| Container out of memory | Change `instanceType` in `cloudflare.config.ts` from `lite` to `basic` and redeploy. OpenBao idles at about 20 MiB. |
