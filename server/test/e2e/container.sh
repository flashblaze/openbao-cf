#!/usr/bin/env bash
# Container integration test: boot, init, configure, JWT login, restart auto-unseal.
set -euo pipefail
cd "$(dirname "$0")/../.."

source test/e2e/lib.sh

stack_up
init_and_configure

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
wait_health 8200 200 180
[ "$(read_demo)" = abc ] || fail "kv read after restart mismatch"

echo "== 9. logs and memory"
docker compose logs openbao | grep -vE '^openbao-1  \| \{' | grep -E 'Auto Seal|Storage:' | head -5 || true
docker stats --no-stream --format '{{.MemUsage}}' "$(docker compose ps -q openbao)"
echo "PASS"
