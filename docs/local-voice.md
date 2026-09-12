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
`config/localai/models`, and applies the narrow compatibility fixes the
verified versions still need. It also downloads the language model itself, so a
first LOCAL session starts what is already on disk instead of fetching 1.3 GB
behind a spinner. Expect about 5.5 GB in `~/.local/share/localai` and several
minutes on a fast connection. The original patched files are retained beside
them with a `.gev-backup` suffix.

Verify an existing installation without downloading or changing anything:

```sh
npm run voice:local:check
```

Start GEV normally and click **CLOUD** beside the mic to select **LOCAL**. The
dev server starts LocalAI on demand, waits for all four stages to load, and
stops the child process when the server exits. The first start is much slower
than later sessions because every model must enter memory.

The mic panel reports what the warm-up is actually doing — `Starting local
backend`, `Downloading model weights… 412 MB so far`, then `Loading speech,
language and voice models`. Two outcomes are distinct on purpose:

- **needs setup** names the command to run (`brew install localai`, then `npm
  run voice:local:setup`) instead of reporting a missing pipeline id.
- **unavailable** means the warm-up stopped moving: a download with no new bytes
  for 45s, or a load that never finished. A download that keeps arriving is
  never cut off by the clock, so a slow connection no longer fails and then
  mysteriously works on the next click.

## Swapping a stage

The pipeline file decides what gets installed, so choosing different models is a
YAML edit. Point a stage at another model, put that model's config beside it,
and re-run setup:

```sh
$EDITOR config/localai/models/gpt-realtime.yaml   # llm: qwen3-4b-mlx
$EDITOR config/localai/models/qwen3-4b-mlx.yaml   # backend, parameters, template
npm run voice:local:setup
```

Setup reads the stages, installs the backend each config names, pulls the stages
that resolve to LocalAI gallery models, and downloads Hugging Face weights for
configs whose `parameters.model` is a repo id such as `openbmb/MiniCPM5-2B-MLX`.
`npm run voice:local:check` verifies exactly those pieces. The MiniCPM tool
parser patch and the Apple Silicon requirement apply only while a stage runs on
the `mlx` backend.

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

The thinking fix is now upstream in LocalAI
([#11962](https://github.com/mudler/LocalAI/pull/11962), released after 4.9.0),
so setup skips that patch when the installed backend already honors
`enable_thinking=false`.

The two small compatibility modules under `config/localai/compat` follow the
MIT-licensed [LocalAI MLX backend](https://github.com/mudler/LocalAI/tree/v4.9.0/backend/python/mlx)
and [MLX-LM tool parser](https://github.com/ml-explore/mlx-lm/tree/main/mlx_lm/tool_parsers)
interfaces. They can be removed from this repository once released versions of
both projects provide the same behavior.

Live session events are written to `.gev-logs/realtime-conversations.jsonl`.
Set `GEV_VOICE_LOG=0` to hide the compact voice trace in the dev-server output.
