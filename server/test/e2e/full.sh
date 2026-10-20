#!/usr/bin/env bash
# Full local flow: CLI push/run/pull (+ environments, legacy migrate) against OpenBao, backup, restore drill, read from the restore.
set -euo pipefail
cd "$(dirname "$0")/../.."
source test/e2e/lib.sh

stack_up
init_and_configure

echo "== build CLI"
REPO=$(cd .. && pwd)
(cd ../cli && bun run build >/dev/null)
SECRETS="$REPO/dist/secrets"

echo "== project and config"
PROJ="$TMP/proj"; mkdir -p "$PROJ" "$TMP/xdg/secrets"
echo '{"project":"demo"}' > "$PROJ/.secrets.json"
echo '{"server":"http://127.0.0.1:8200"}' > "$TMP/xdg/secrets/config.json"
cat > "$PROJ/.dev.vars" <<'VARS'
PLAIN=hello
QUOTED="has # hash and 'single' quotes"
MULTI="line one
line two # not a comment
line three"
VARS
cp "$PROJ/.dev.vars" "$TMP/orig.dev.vars"
export XDG_CONFIG_HOME="$TMP/xdg"
SECRETS_ACCESS_JWT=$(owner_jwt)
export SECRETS_ACCESS_JWT
EXPECT_MULTI=$'line one\nline two # not a comment\nline three'

echo "== push"
cd "$PROJ"
"$SECRETS" push --yes
rm .dev.vars

echo "== run"
OUT=$("$SECRETS" run -- sh -c 'printf %s "$MULTI"')
[ "$OUT" = "$EXPECT_MULTI" ] || fail "run MULTI mismatch: $OUT"

echo "== pull"
"$SECRETS" pull
(cd "$REPO/cli" && bun -e '
  import { parseDevVars } from "./src/dotenv.ts";
  import { readFileSync } from "node:fs";
  const a = parseDevVars(readFileSync(process.argv[1], "utf8"));
  const b = parseDevVars(readFileSync(process.argv[2], "utf8"));
  if (JSON.stringify(Object.entries(a).sort()) !== JSON.stringify(Object.entries(b).sort())) { console.error("pull mismatch", a, b); process.exit(1); }
' "$TMP/orig.dev.vars" "$PROJ/.dev.vars")

echo "== environments"
printf 'PLAIN=staging-value\n' > .dev.vars.staging
"$SECRETS" push --yes --env staging
rm .dev.vars .dev.vars.staging   # run refuses while any .dev.vars* exists
OUT=$("$SECRETS" run --env staging -- sh -c 'printf %s "$PLAIN"')
[ "$OUT" = staging-value ] || fail "run --env staging got: $OUT"
OUT=$("$SECRETS" run -- sh -c 'printf %s "$PLAIN"')
[ "$OUT" = hello ] || fail "run (default env) got: $OUT"
[ "$("$SECRETS" envs)" = $'* dev\n  staging' ] || fail "envs output: $("$SECRETS" envs)"

echo "== migrate pre-environment data (real OpenBao)"
LEG="$TMP/legacy"; mkdir -p "$LEG"
echo '{"project":"legacyproj"}' > "$LEG/.secrets.json"
curl -sf -H "X-Vault-Token: $ROOT" -X POST http://127.0.0.1:8200/v1/secret/data/legacyproj \
  -d '{"data":{"OLD":"v1","OTHER":"v2"}}' >/dev/null
cd "$LEG"
if "$SECRETS" run -- true 2>"$TMP/leg.err"; then fail "run should refuse with legacy-only data"; fi
grep -q "secrets migrate" "$TMP/leg.err" || fail "missing legacy hint: $(cat "$TMP/leg.err")"
"$SECRETS" migrate --yes
code=$(curl -s -o /dev/null -w '%{http_code}' -H "X-Vault-Token: $ROOT" http://127.0.0.1:8200/v1/secret/data/legacyproj)
[ "$code" = 404 ] || fail "legacy secret still present (HTTP $code)"
# Deleting secret/legacyproj must leave secret/legacyproj/dev intact.
MIG=$(curl -sf -H "X-Vault-Token: $ROOT" http://127.0.0.1:8200/v1/secret/data/legacyproj/dev | jq -cS .data.data)
[ "$MIG" = '{"OLD":"v1","OTHER":"v2"}' ] || fail "migrated data mismatch: $MIG"
OUT=$("$SECRETS" run -- sh -c 'printf %s "$OLD"')
[ "$OUT" = v1 ] || fail "run after migrate got: $OUT"

echo "== nested project via init (real OpenBao)"
mkdir -p "$TMP/acme/apps/api" && git -C "$TMP/acme" init -q
cd "$TMP/acme/apps/api"
"$SECRETS" init 2>/dev/null
[ "$(jq -r .project .secrets.json)" = acme/api ] || fail "init suggested: $(cat .secrets.json)"
printf 'NESTED=yes\n' > .dev.vars
"$SECRETS" push --yes
rm .dev.vars
OUT=$("$SECRETS" run -- sh -c 'printf %s "$NESTED"')
[ "$OUT" = yes ] || fail "nested run got: $OUT"
[ "$("$SECRETS" envs)" = "* dev" ] || fail "nested envs: $("$SECRETS" envs)"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "X-Vault-Token: $ROOT" http://127.0.0.1:8200/v1/secret/data/acme/api/dev)
[ "$code" = 200 ] || fail "nested secret not at secret/acme/api/dev (HTTP $code)"
cd "$REPO/server"

echo "== backup + restore drill"
bun scripts/backup-local.ts postgres://bao:bao@127.0.0.1:55432/bao "$TMP/b.ndjson"
[ -s "$TMP/b.ndjson" ] || fail "empty backup"
bash scripts/restore-drill.sh "$TMP/b.ndjson"
if bun scripts/restore.ts "$TMP/b.ndjson" postgres://bao:bao@127.0.0.1:55432/bao_restore 2>"$TMP/again.err"; then
  fail "second restore should exit 1"
fi
grep -q "target table is not empty" "$TMP/again.err" || fail "missing not-empty message"

echo "== read from restore"
RJWT=$(owner_jwt)
RTOKEN=$(curl -sf -X POST http://127.0.0.1:8201/v1/auth/jwt/login \
  -d "$(jq -nc --arg jwt "$RJWT" '{role:"owner",jwt:$jwt}')" | jq -r .auth.client_token)
DATA=$(curl -sf -H "X-Vault-Token: $RTOKEN" http://127.0.0.1:8201/v1/secret/data/demo/dev | jq -c .data.data)
[ "$(jq -r .MULTI <<<"$DATA")" = "$EXPECT_MULTI" ] || fail "restored MULTI mismatch"
[ "$(jq -r .QUOTED <<<"$DATA")" = "has # hash and 'single' quotes" ] || fail "restored QUOTED mismatch"
[ "$(jq -r .PLAIN <<<"$DATA")" = hello ] || fail "restored PLAIN mismatch"
STG=$(curl -sf -H "X-Vault-Token: $RTOKEN" http://127.0.0.1:8201/v1/secret/data/demo/staging | jq -r .data.data.PLAIN)
[ "$STG" = staging-value ] || fail "restored staging mismatch"
echo "PASS"
