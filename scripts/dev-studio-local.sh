#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VARS_FILE="$ROOT/apps/worker/.dev.vars"

if [[ ! -f "$VARS_FILE" ]]; then
  echo "Missing $VARS_FILE. Copy apps/worker/.dev.vars.example to .dev.vars first." >&2
  exit 1
fi

# HubSpot's local app-backend proxy signs hubspot.fetch() requests with
# process.env.CLIENT_SECRET. It must match the worker's HUBSPOT_CLIENT_SECRET
# or local signature verification will fail.
set -a
# shellcheck disable=SC1090
source "$VARS_FILE"
set +a
export CLIENT_SECRET="${HUBSPOT_CLIENT_SECRET:-}"

if [[ -z "$CLIENT_SECRET" ]]; then
  echo "HUBSPOT_CLIENT_SECRET is empty in $VARS_FILE; local proxy signatures will fail." >&2
  exit 1
fi

cd "$ROOT/apps/studio-app"
exec hs project dev
