#!/usr/bin/env bash
# Idempotent OpenBao setup: KV v2, JWT auth, owner policy, owner role.
# Env: BAO_ADDR BAO_TOKEN OWNER_EMAIL ACCESS_AUD, plus either
#   ACCESS_TEAM_DOMAIN (https://<team>.cloudflareaccess.com, no trailing slash)
#   or JWT_PUBKEY_FILE + JWT_ISSUER (tests).
set -euo pipefail
: "${BAO_ADDR:?}" "${BAO_TOKEN:?}" "${OWNER_EMAIL:?}" "${ACCESS_AUD:?}"
command -v bao >/dev/null 2>&1 || PATH="$(dirname "$(mise which bao)"):$PATH"
here=$(cd "$(dirname "$0")" && pwd)

if [ -n "${ACCESS_TEAM_DOMAIN:-}" ]; then
  jwt_args=("jwks_url=${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs" "bound_issuer=${ACCESS_TEAM_DOMAIN}")
elif [ -n "${JWT_PUBKEY_FILE:-}" ] && [ -n "${JWT_ISSUER:-}" ]; then
  jwt_args=("jwt_validation_pubkeys=@${JWT_PUBKEY_FILE}" "bound_issuer=${JWT_ISSUER}")
else
  echo "set ACCESS_TEAM_DOMAIN, or JWT_PUBKEY_FILE and JWT_ISSUER" >&2
  exit 1
fi

if ! bao secrets list -format=json | jq -e 'has("secret/")' >/dev/null; then
  bao secrets enable -path=secret -version=2 kv
fi
if ! bao auth list -format=json | jq -e 'has("jwt/")' >/dev/null; then
  bao auth enable jwt
fi
# Audit is declarative in container/config.hcl (OpenBao rejects API audit enable).
bao audit list -format=json | jq -e 'has("stdout/")' >/dev/null \
  || echo "warning: audit device 'stdout' not present (see container/config.hcl)" >&2

bao write auth/jwt/config "${jwt_args[@]}"
bao policy write owner "$here/../policies/owner.hcl"
jq -nc --arg aud "$ACCESS_AUD" --arg email "$OWNER_EMAIL" '{
  role_type: "jwt", user_claim: "email", bound_audiences: [$aud],
  bound_claims: {email: $email}, token_policies: ["owner"], token_ttl: "1h"
}' | bao write auth/jwt/role/owner -
echo "configured" >&2
