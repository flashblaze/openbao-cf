#!/usr/bin/env bash
# Container integration test: boot, init, configure, JWT login, restart auto-unseal.
set -euo pipefail
cd "$(dirname "$0")/../.."

command -v bao >/dev/null 2>&1 || PATH="$(dirname "$(mise which bao)"):$PATH"
TMP=$(mktemp -d)
cleanup() { docker compose down -v >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

export BAO_ADDR=http://127.0.0.1:8200
export BAO_SEAL_KEY
BAO_SEAL_KEY=$(openssl rand -hex 32)
fail() { echo "FAIL: $*" >&2; exit 1; }
health() { curl -s -o /dev/null -w '%{http_code}' "$BAO_ADDR/v1/sys/health" || true; }
wait_health() { # code, cap seconds
  local want=$1 cap=$2 t0=$SECONDS
  until [ "$(health)" = "$want" ]; do
    [ $((SECONDS - t0)) -lt "$cap" ] || { docker compose logs openbao | tail -30; fail "health never reached $want in ${cap}s"; }
    sleep 1
  done
  echo "health $want after $((SECONDS - t0))s"
}

echo "== 1. up"
docker compose up -d --build --wait postgres openbao
echo "== 2. wait for 501 (uninitialized)"
wait_health 501 180

echo "== 3. init"
ROOT=$(bash scripts/init.sh | jq -r .root_token)
[ -n "$ROOT" ] && [ "$ROOT" != null ] || fail "empty root token"

echo "== 4. configure (twice)"
bun test/e2e/jwt.ts keygen "$TMP"
for i in 1 2; do
  BAO_TOKEN=$ROOT JWT_PUBKEY_FILE="$TMP/public.pem" JWT_ISSUER=https://test.cloudflareaccess.com \
    ACCESS_AUD=test-aud OWNER_EMAIL=owner@example.com bash scripts/configure.sh >/dev/null
done

echo "== 5. owner login"
login() {
  curl -s -o "$TMP/login.json" -w '%{http_code}' -X POST "$BAO_ADDR/v1/auth/jwt/login" \
    -d "$(jq -nc --arg jwt "$1" '{role:"owner",jwt:$jwt}')"
}
OWNER_JWT=$(bun test/e2e/jwt.ts sign "$TMP" owner@example.com)
[ "$(login "$OWNER_JWT")" = 200 ] || fail "owner login not 200"
jq -e '.auth.policies | index("owner")' "$TMP/login.json" >/dev/null || fail "owner policy missing"
TOKEN=$(jq -r .auth.client_token "$TMP/login.json")

echo "== 6. kv write/read"
curl -sf -X POST -H "X-Vault-Token: $TOKEN" "$BAO_ADDR/v1/secret/data/demo" -d '{"data":{"API_KEY":"abc"}}' >/dev/null
read_demo() { curl -sf -H "X-Vault-Token: $TOKEN" "$BAO_ADDR/v1/secret/data/demo" | jq -r .data.data.API_KEY; }
[ "$(read_demo)" = abc ] || fail "kv read mismatch"

echo "== 7. other email rejected"
CODE=$(login "$(bun test/e2e/jwt.ts sign "$TMP" someone@example.com)")
[ "$CODE" != 200 ] || fail "someone@example.com logged in"
echo "rejected with $CODE"

echo "== 8. restart, auto-unseal"
docker compose restart openbao
wait_health 200 180
[ "$(read_demo)" = abc ] || fail "kv read after restart mismatch"

echo "== 9. logs and memory"
docker compose logs openbao | grep -vE '^openbao-1  \| \{' | grep -E 'Auto Seal|Storage:' | head -5 || true
docker stats --no-stream --format '{{.MemUsage}}' "$(docker compose ps -q openbao)"
echo "PASS"
