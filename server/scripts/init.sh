#!/usr/bin/env bash
# One-time operator init. Prints the JSON (root token, recovery key) to stdout only.
set -euo pipefail
: "${BAO_ADDR:?set BAO_ADDR}"
command -v bao >/dev/null 2>&1 || PATH="$(dirname "$(mise which bao)"):$PATH"
exec bao operator init -recovery-shares=1 -recovery-threshold=1 -format=json
