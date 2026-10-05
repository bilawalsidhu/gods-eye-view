#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# A lighter CCTV testing preset; startup, credentials, and LAN warnings belong
# to the normal launcher. Explicit environment overrides remain supported.
export CCTV_SOURCES_FILE="${CCTV_SOURCES_FILE:-config/cctv_sources.austin.json}"
export CCTV_PREFER_AUSTIN="${CCTV_PREFER_AUSTIN:-1}"
export CCTV_AUSTIN_MAX_SOURCES="${CCTV_AUSTIN_MAX_SOURCES:-36}"
export CCTV_MAX_SOURCES="${CCTV_MAX_SOURCES:-48}"

exec bash "$ROOT_DIR/scripts/dev-fresh.sh"
