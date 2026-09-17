#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
set -a; [ -f "$ROOT_DIR/.env" ] && . "$ROOT_DIR/.env"; set +a
export AI_PROVIDER=ollama HOST="${HOST:-localhost}" PORT="${PORT:-4173}"
export PIPER_MODEL="${PIPER_MODEL:-$ROOT_DIR/.local/voices/${TTS_VOICE:-en_US-lessac-medium}.onnx}"
if ! pgrep -x ollama >/dev/null 2>&1; then ollama serve >/tmp/gev-ollama.log 2>&1 & fi
exec npm run dev -- --host "$HOST"
