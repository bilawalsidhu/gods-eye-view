# GEV COMMAND — the typed agent

GEV COMMAND is a second transport for the agent voice already drives. It takes
typed commands, runs the same 30 app actions through the same action runner,
and reaches any OpenAI-compatible `/v1/chat/completions` endpoint — OpenAI,
OpenRouter, or a local Ollama.

Voice is untouched. The two transports run side by side and share the
operating manual, the tool schemas and the action runner.

## Why typing as well as speaking

Voice is excellent and expensive. Audio tokens dominate the bill, an open mic
bills for silence, and the Realtime API has no open-source equivalent speaking
its WebRTC protocol with native speech-to-speech plus tool calling.

Typing removes all three at once: the same agent, the same tools, roughly two
orders of magnitude cheaper, and reachable by back ends that will never
implement Realtime — including a model on the operator's own GPU.

| | Per typed command |
|---|---|
| `gpt-5-nano` | ~$0.0002 |
| `gpt-5-mini` | ~$0.0008 |
| Ollama | free |

against roughly $0.10–$0.30 per minute of open-mic voice. The console shows the
estimate for the selected model before you type, computed from the real prompt
prefix (see [Cost](#cost)).

## Using it

The **GEV COMMAND** chip sits in the bottom-left corner, below the map
attribution. It opens a non-modal dialog, so the globe stays interactive while
a command runs — the point of typing one is watching it happen. Escape or the ×
closes it.

The window is **draggable by its header and resizable from every edge**, and
remembers where it was left. Double-press the header to forget that and return
it to its default placement, the same gesture the app's other floating panels
use to snap back. On first open it sits on the left, clear of the rail above it
and the map attribution below it — the credit line is a licence condition, not
decoration, so the default placement never covers it.

Pick a provider and a model, type a command, press SEND:

```
> zoom out to full planet view
  zoom_to_globe · ok
  Globe view.
```

The transcript shows each tool call and whether it reported `ok`, which is the
same signal the model reads before it confirms anything.

Nothing is requested until you open the console: an install with no provider
configured should not spend a request to find that out.

## Configuration

No new variable is required. With none of them set the console offers OpenAI
and uses `OPENAI_API_KEY`, the same credential voice uses.

| Variable | Effect |
|---|---|
| `GEV_AGENT_PROVIDER` | Provider selected on first open (`openai`, `openrouter`, `ollama`). Unrecognised values fall back to `openai`. |
| `GEV_AGENT_MODEL` | Default model for every provider. |
| `GEV_AGENT_MODEL_<PROVIDER>` | Default model for one provider, e.g. `GEV_AGENT_MODEL_OLLAMA`. |
| `GEV_AGENT_MODELS` | Comma-separated allowlist of model ids a request may run. |
| `GEV_AGENT_MODELS_<PROVIDER>` | The same allowlist for one provider. |
| `OPENROUTER_API_KEY` | Enables OpenRouter. |
| `OPENROUTER_BASE_URL` | Overrides OpenRouter's base URL. |
| `OLLAMA_BASE_URL` | Where the Ollama daemon is, default `http://localhost:11434/v1`. |
| `GEV_RATELIMIT_AGENT_PER_MIN` | Per-IP cap on the agent endpoints, default 60. Exactly `0` disables it. |

OpenAI's base URL is deliberately not overridable: the only values that can
repoint a request are the ones named above.

## Local models

Ollama needs no credential, which makes it the one provider that works on a
fresh checkout with nothing configured:

```bash
docker run -d --gpus all -p 11434:11434 \
  -e OLLAMA_CONTEXT_LENGTH=16384 --name gev-ollama ollama/ollama
docker exec gev-ollama ollama pull qwen3:4b
```

`OLLAMA_CONTEXT_LENGTH` is not optional. The stock runtime window is 4096
tokens, and this app's prompt prefix is around 12,000 — see
[Two silent failures](#two-silent-failures).

The model picker lists only models that can actually do the job: Ollama reports
tool support and context length through its native `/api/show`, so a model
without the `tools` capability or with a window under 16,384 tokens is withheld
with its reason. A daemon too old to report either gets the benefit of the
doubt rather than losing the model from the list.

## Architecture

```
src/agent/
├── conversation.js   # transcript sanitizing, bounded history, bounded results
├── cost.js           # per-command estimate and its formatting
├── consoleBox.js     # the window: drag, resize, clamping, persistence
├── agentLoop.js      # the client-side tool loop
└── agentConsole.js   # the dialog

server/providers/agent/
├── registry.js       # providers, model policy, capability gating
├── instructions.js   # voice's manual, adapted for a typed channel
├── toolSchema.js     # Realtime → chat reshape, JSON Schema validation
├── diagnostics.js    # silent-failure detection
├── prefix.js         # derived prompt-prefix size
├── upstream.js       # provider HTTP, injectable fetch
├── rate-limit.js     # the per-IP cap
└── routes.js         # the three handlers
```

Credentials stay server-side; the browser executes the tools because they drive
its own viewer. That splits one logical turn into a loop: the console asks the
server, runs whatever tool calls come back through
`voiceCommands.runner` — the same runner voice and the view installer use — and
asks again, until the model answers with prose.

Endpoints, all gated against cross-site browser requests and sharing one
per-IP throttle:

- `GET /api/agent/config` — providers, defaults, tool count, prefix size
- `GET /api/agent/models` — the capability-gated listing for one provider
- `POST /api/agent/command` — one model turn, tool calls validated before return

### The server decides what runs

The console picks from a listing this server produced, but the server resolves
what a request actually runs, the way `resolveVoiceModel` does for voice: a
model id that is malformed, over-long or outside the operator's allowlist
degrades to the configured default instead of reaching the upstream verbatim.
The response echoes `X-GEV-Agent-Model`, plus `X-GEV-Agent-Model-Fallback` when
a substitution happened.

The operating manual and the tool list are likewise server-side. A `system`
message arriving from the client is discarded.

### Malformed tool calls are corrected server-side

Ollama's compatible endpoint does not accept `tool_choice`, so a bad tool call
cannot be prevented — only caught and handed back. A rejected call is answered
with its own validation error so the model can restate it, twice, before the
turn gives up and says so. None of that reaches the browser.

### The manual is voice's manual

`server/providers/agent/instructions.js` reads the directive list from
`server/providers/openai/instructions.js` and rewrites only the four lines that
describe the channel. Keeping a second copy would let the two drift, and every
drift is a behaviour difference nobody chose. A rewrite is matched by its
opening words and the match is asserted, so rewording a voice directive fails a
test instead of quietly leaving "speak your confirmation" in the typed prompt.

## Two silent failures

Both were found on real hardware. Both return **HTTP 200** with a plausible
answer, so neither surfaces as an error.

**Truncated tool prefix.** The app sends about 12,000 tokens of instructions
and schemas. Ollama's stock context is 4096, which silently cuts the tool list;
the model then writes a `<function-call>` block as prose and picks the wrong
tool. The registry's context gate cannot catch it, because `/api/show` reports
the model's *architectural* context, not the runtime window the daemon
allocated. It is detected from the returned prompt token count instead, with
the remedy named.

**Reasoning overflow.** A reasoning model spends its whole output budget
thinking and returns empty content with `finish_reason: "length"`. Raising the
ceiling does not help, so the remedy is a different model and the message says
so.

Both are reported as **warnings on a 200**, never as refusals. The prefix size
is a character-count heuristic compared against another provider's tokenizer,
so it can be wrong in both directions; a turn that produced a valid tool call is
a working turn whatever the arithmetic says. Warnings appear in the transcript
with their remedy attached.

## Cost

The per-command estimate models the loop the app actually runs: the fixed
prefix resent on each of two round trips, billed at the cached rate once warm,
plus the command and the answer. The prefix size is **derived** from the real
instruction string and the real tool schemas
(`server/providers/agent/prefix.js`), not written down, so it cannot go stale
when a directive is edited or a tool is added.

OpenRouter publishes per-token prices, so its models carry a real figure.
OpenAI's `/v1/models` publishes none, so those models show nothing rather than
implying a command is free. Ollama is free.

## Bounds

| Bound | Value | Why |
|---|---|---|
| Request body | 512 KB | The console trims its own history well inside this, so reaching it means one exchange is enormous. |
| Client history budget | 448 KB | Below the server cap, so a long session trims itself instead of failing every command at once. |
| History messages | 40 | A trim never splits an assistant tool call from its results. |
| Tool result | 6,000 chars | Bounded by shedding the largest non-essential fields, so the result is always valid JSON — never a prefix cut mid-object. |
| Tool rounds | 8 | A runaway guard, not a limit on multi-tool turns. |
| Completion wait | 120 s hosted, 300 s local | A local daemon pays for a cold model load before its first token. |

## Testing

```bash
npm test
npm run build
npm run test:track           # needs the dev server
node scripts/qa-agent-console.mjs --url http://localhost:4173
```

The gate drives the real console in the real app and carries one typed command
through to a state change it reads back from the viewer. Add `--offline` to
check the chrome and the endpoints without a configured provider, and
`--provider openai` to use the server's OpenAI key instead of Ollama.
