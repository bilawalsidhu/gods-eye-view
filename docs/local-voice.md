# Local voice on Apple Silicon

God's Eye View can run the complete voice loop on an Apple Silicon Mac through
[LocalAI](https://localai.io/): voice activity detection, transcription, the
tool-calling language model, and speech synthesis. The browser uses the same 28
GEV tools and WebRTC session flow as the OpenAI provider.

The bundled profile was verified with LocalAI 4.9.0 and MLX-LM 0.31.3. It uses:

| Stage | Model | Purpose |
| --- | --- | --- |
| VAD | Silero VAD | Detect speech boundaries |
| STT | Parakeet Realtime EOU 120M | Transcribe speech and detect end of utterance |
| LLM | MiniCPM5-2B MLX 4-bit | Choose tools and write the reply |
| TTS | Kokoro 82M (`af_heart`) | Produce assistant speech |

## Install

Install LocalAI, then run the repository setup command:

```sh
brew install localai
npm run voice:local:setup
```

The setup downloads the required model and backend artifacts into
`~/.local/share/localai`, copies the versioned pipeline files from
`config/localai/models`, and applies two narrow compatibility fixes required by
the verified versions. Downloads can take several minutes. The original
patched files are retained beside them with a `.gev-backup` suffix.

Verify an existing installation without downloading or changing anything:

```sh
npm run voice:local:check
```

Start GEV normally and click **CLOUD** beside the mic to select **LOCAL**. The
dev server starts LocalAI on demand, waits for all four stages to load, and
stops the child process when the server exits. The first start is much slower
than later sessions because every model must enter memory.

## Configuration

These optional environment values change the defaults:

```dotenv
GEV_VOICE_PROVIDER=local
GEV_LOCAL_REALTIME_URL=http://localhost:8080/v1/realtime/calls
GEV_LOCAL_REALTIME_MODEL=gpt-realtime
GEV_LOCAL_AI_BIN=local-ai
GEV_LOCAL_AI_HOME=/absolute/path/to/localai
```

`GEV_VOICE_PROVIDER` sets the initial provider for a new browser profile. The
mic panel selection is stored in the browser and takes precedence. A remote
`GEV_LOCAL_REALTIME_URL` is supported, but GEV will never try to start or stop a
process on that host.

The included pipeline disables MiniCPM thinking, retains four conversation
items, and preloads the full stack before the microphone connects. Tool calls
remain structured events; the MiniCPM `<function>` markup is withheld from the
text passed to Kokoro so it cannot be spoken.

## Compatibility files

LocalAI 4.9.0's MLX backend only forwarded `enable_thinking=true` and streamed
raw MiniCPM function markup before converting it into a tool call. MLX-LM
0.31.3 also lacked MiniCPM5 parser registration. The setup command patches
those exact source shapes and stops with an error when the installed source is
not compatible, rather than modifying an unknown version.

The two small compatibility modules under `config/localai/compat` follow the
MIT-licensed [LocalAI MLX backend](https://github.com/mudler/LocalAI/tree/v4.9.0/backend/python/mlx)
and [MLX-LM tool parser](https://github.com/ml-explore/mlx-lm/tree/main/mlx_lm/tool_parsers)
interfaces. They can be removed from this repository once released versions of
both projects provide the same behavior.

Live session events are written to `.gev-logs/realtime-conversations.jsonl`.
Set `GEV_VOICE_LOG=0` to hide the compact voice trace in the dev-server output.
