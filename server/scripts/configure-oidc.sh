#!/usr/bin/env bash
# Idempotent: browser sign-in for the OpenBao web UI via a Cloudflare Access
# "SaaS / OIDC" application. Run through `secrets proxy --login` so BAO_TOKEN is
# an owner token (the owner policy can manage auth methods).
# Env: BAO_ADDR BAO_TOKEN OWNER_EMAIL BAO_HOSTNAME
#      ACCESS_TEAM_DOMAIN (https://<team>.cloudflareaccess.com, no trailing slash)
#      OIDC_CLIENT_ID OIDC_CLIENT_SECRET (from the Access SaaS app)
set -euo pipefail
: "${BAO_ADDR:?}" "${BAO_TOKEN:?}" "${OWNER_EMAIL:?}" "${BAO_HOSTNAME:?}"
: "${ACCESS_TEAM_DOMAIN:?}" "${OIDC_CLIENT_ID:?}" "${OIDC_CLIENT_SECRET:?}"
command -v bao >/dev/null 2>&1 || PATH="$(dirname "$(mise which bao)"):$PATH"

team=${ACCESS_TEAM_DOMAIN%/}

if ! bao auth list -format=json | jq -e 'has("oidc/")' >/dev/null; then
  bao auth enable oidc
fi
# Show the OIDC tab on the UI login page.
bao auth tune -listing-visibility=unauth oidc/

# The client secret goes over stdin, never argv.
jq -nc --arg url "$team/cdn-cgi/access/sso/oidc/$OIDC_CLIENT_ID" \
  --arg id "$OIDC_CLIENT_ID" --arg secret "$OIDC_CLIENT_SECRET" '{
  oidc_discovery_url: $url, oidc_client_id: $id, oidc_client_secret: $secret,
  default_role: "owner"
}' | bao write auth/oidc/config -

jq -nc --arg email "$OWNER_EMAIL" \
  --arg redirect "https://$BAO_HOSTNAME/ui/vault/auth/oidc/oidc/callback" '{
  role_type: "oidc", user_claim: "email", oidc_scopes: ["email"],
  bound_claims: {email: $email}, allowed_redirect_uris: [$redirect],
  token_policies: ["owner"], token_ttl: "1h"
}' | bao write auth/oidc/role/owner -
echo "oidc configured" >&2
