#!/usr/bin/env bash
# Full local flow: CLI push/run/pull against OpenBao, backup, restore drill, read from the restore.
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
DATA=$(curl -sf -H "X-Vault-Token: $RTOKEN" http://127.0.0.1:8201/v1/secret/data/demo | jq -c .data.data)
[ "$(jq -r .MULTI <<<"$DATA")" = "$EXPECT_MULTI" ] || fail "restored MULTI mismatch"
[ "$(jq -r .QUOTED <<<"$DATA")" = "has # hash and 'single' quotes" ] || fail "restored QUOTED mismatch"
[ "$(jq -r .PLAIN <<<"$DATA")" = hello ] || fail "restored PLAIN mismatch"
echo "PASS"
