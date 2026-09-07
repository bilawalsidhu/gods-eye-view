#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VITE_PORT="${PORT:-4173}"
BFF_PORT="${BFF_PORT:-3000}"
HOST="${HOST:-localhost}"

if ! command -v npm >/dev/null 2>&1; then
  echo "error: npm not found"
  exit 1
fi

read_dotenv_value() {
  node scripts/read-dotenv-value.mjs "$1"
}

# Vite loads its own dotenv files, but the sibling BFF process does not. Export
# only the current server-owned configuration, preserving explicit shell values.
CONFIG_VARS=(
  AZURE_CLIENT_ID AZURE_TENANT_ID AZURE_FEDERATED_TOKEN_FILE
  AZURE_MAPS_ENDPOINT AZURE_MAPS_CLIENT_ID
  FOUNDRY_ENDPOINT FOUNDRY_REALTIME_DEPLOYMENT FOUNDRY_HUD_DEPLOYMENT
  AISSTREAM_API_KEY AISSTREAM_BOUNDING_BOXES AISSTREAM_MESSAGE_TYPES
  FIRMS_MAP_KEY TOMTOM_API_KEY
  OPENSKY_AUTH_MODE OPENSKY_CLIENT_ID OPENSKY_CLIENT_SECRET OPENSKY_CREDENTIALS_FILE
  APPLICATIONINSIGHTS_CONNECTION_STRING
)
for name in "${CONFIG_VARS[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    value="$(read_dotenv_value "$name")"
    [[ -n "$value" ]] && export "$name=$value"
  fi
done

case "$HOST" in
  localhost|127.0.0.1|::1)
    echo "Local-only mode"
    ;;
  *)
    echo "!! WARNING: HOST=${HOST} exposes the development BFF and its configured provider access."
    echo "!! Use only on a trusted network. Deployed environments require Entra whole-app authentication."
    ;;
esac

echo "Vite: http://localhost:${VITE_PORT}"
echo "BFF:  http://localhost:${BFF_PORT}"
echo "Azure: DefaultAzureCredential (run 'az login' for local development)"
[[ -n "${AZURE_MAPS_CLIENT_ID:-}" ]] \
  && echo "Maps: Azure Maps configured; OSM remains the fail-safe" \
  || echo "Maps: OSM fallback (set AZURE_MAPS_CLIENT_ID for Azure Maps)"
[[ -n "${FOUNDRY_ENDPOINT:-}" && -n "${FOUNDRY_REALTIME_DEPLOYMENT:-}" && -n "${FOUNDRY_HUD_DEPLOYMENT:-}" ]] \
  && echo "Voice: Microsoft Foundry deployments configured" \
  || echo "Voice: disabled until all Foundry settings are configured"

rm -rf node_modules/.vite
HOST="$HOST" PORT="$VITE_PORT" BFF_PORT="$BFF_PORT" npm run dev
