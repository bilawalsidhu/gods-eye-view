#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sudo apt-get update
sudo apt-get install -y curl ffmpeg python3 python3-venv python3-pip
if ! command -v ollama >/dev/null 2>&1; then curl -fsSL https://ollama.com/install.sh | sh; fi
python3 -m venv "$ROOT_DIR/.venv-local"
"$ROOT_DIR/.venv-local/bin/pip" install --upgrade pip faster-whisper piper-tts websockets
# Prefer CPU wheels in WSLs without CUDA.  Install Silero without dependency
# resolution so pip cannot silently pull a multi-gigabyte CUDA torch bundle.
"$ROOT_DIR/.venv-local/bin/pip" install torch torchaudio --index-url https://download.pytorch.org/whl/cpu || true
"$ROOT_DIR/.venv-local/bin/pip" install --no-deps silero-vad || true
set -a; [ -f "$ROOT_DIR/.env" ] && . "$ROOT_DIR/.env"; set +a
OLLAMA_PID=''
if ! curl -fsS "${OLLAMA_BASE_URL:-http://localhost:11434}/api/tags" >/dev/null 2>&1; then
  ollama serve >/tmp/gev-ollama.log 2>&1 & OLLAMA_PID=$!
  trap '[ -z "$OLLAMA_PID" ] || kill "$OLLAMA_PID" 2>/dev/null || true' EXIT
  for _ in $(seq 1 30); do curl -fsS "${OLLAMA_BASE_URL:-http://localhost:11434}/api/tags" >/dev/null 2>&1 && break; sleep 1; done
fi
for model in "${OLLAMA_HUD_MODEL:-qwen2.5:3b}" "${OLLAMA_VOICE_MODEL:-qwen2.5:7b}" "${OLLAMA_VISION_MODEL:-llama3.2-vision}"; do ollama pull "$model"; done
npm install
if command -v piper >/dev/null 2>&1 || [ -x "$ROOT_DIR/.venv-local/bin/piper" ]; then
  mkdir -p "$ROOT_DIR/.local/voices"
  "$ROOT_DIR/.venv-local/bin/python" -m piper.download_voices --data-dir "$ROOT_DIR/.local/voices" "${TTS_VOICE:-en_US-lessac-medium}" || true
  if [ -f "$ROOT_DIR/.local/voices/${TTS_VOICE:-en_US-lessac-medium}.onnx" ]; then export PIPER_MODEL="$ROOT_DIR/.local/voices/${TTS_VOICE:-en_US-lessac-medium}.onnx"; fi
fi
echo "WSL2 local AI dependencies installed. CPU fallback is supported; Ollama uses NVIDIA automatically when WSL exposes it."
