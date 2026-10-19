# Shared helpers for e2e scripts. Source from the server/ directory.
command -v bao >/dev/null 2>&1 || PATH="$(dirname "$(mise which bao)"):$PATH"
TMP=$(mktemp -d)
cleanup() {
  docker compose --profile restore down -v >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

export BAO_ADDR=http://127.0.0.1:8200
fail() { echo "FAIL: $*" >&2; exit 1; }

# wait_health <port> <code> [cap seconds]
wait_health() {
  local port=$1 want=$2 cap=${3:-180} t0=$SECONDS got
  while :; do
    got=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/v1/sys/health" || true)
    [ "$got" = "$want" ] && break
    [ $((SECONDS - t0)) -lt "$cap" ] || { docker compose logs openbao | tail -30; fail "port $port health never reached $want in ${cap}s"; }
    sleep 1
  done
  echo "health $want on :$port after $((SECONDS - t0))s"
}

stack_up() {
  echo "== up"
  export BAO_SEAL_KEY
  BAO_SEAL_KEY=$(openssl rand -hex 32)
  docker compose up -d --build --wait postgres openbao
  echo "== wait for 501 (uninitialized)"
  wait_health 8200 501 180
}

init_and_configure() {
  echo "== init"
  ROOT=$(bash scripts/init.sh | jq -r .root_token)
  export ROOT
  [ -n "$ROOT" ] && [ "$ROOT" != null ] || fail "empty root token"
  echo "== configure (twice)"
  bun test/e2e/jwt.ts keygen "$TMP"
  local i
  for i in 1 2; do
    BAO_TOKEN=$ROOT JWT_PUBKEY_FILE="$TMP/public.pem" JWT_ISSUER=https://test.cloudflareaccess.com \
      ACCESS_AUD=test-aud OWNER_EMAIL=owner@example.com bash scripts/configure.sh >/dev/null
  done
}

owner_jwt() { bun test/e2e/jwt.ts sign "$TMP" owner@example.com; }
