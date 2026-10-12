# Local hybrid: God's Eye View and World Monitor

This fork combines God's Eye View's globe and live layers with a local World
Monitor service. The Intelligence panel and MCP expose country headlines,
country risk context, and a news digest. A Bifrost or other local
OpenAI-compatible loopback gateway supplies text reasoning and globe tool calls.
The gateway can run local models or forward text to an explicitly configured
remote provider such as OpenRouter.

The integrations use HTTP between the applications. World Monitor source is
not copied into this MIT repository. Preserve World Monitor's AGPL license and
both projects' source/data notices in any distribution. Data provider terms
still apply. Neither an LLM key nor this integration grants feed subscriptions.

## Configure text inference

Use Node 24.14 or later within Node 24, or supported Node 26. Install the locked
dependencies with `npm ci`. Put the following configuration in an ignored,
owner-readable `.env.local` file:

```dotenv
GEV_HYBRID_ENABLED=true
GEV_LLM_PROVIDER=bifrost
GEV_LLM_BASE_URL=http://127.0.0.1:4043/openai/v1
GEV_LLM_MODEL=openrouter/openrouter/free
GEV_LLM_API_KEY_FILE=/absolute/path/to/virtual-key.json
GEV_LLM_API_KEY_FIELD=virtual_key.value
```

Use the actual model identifier from your gateway. The configured URL is an
OpenAI base URL; the server appends `/chat/completions`. The gateway must listen
on localhost, 127.0.0.1, or ::1. Use your configured HTTP or HTTPS scheme.
HTTPS certificate verification remains enabled.

For this Bifrost example, the first `openrouter/` selects
[Bifrost's OpenRouter provider](https://docs.getbifrost.ai/providers/supported-providers/openrouter);
the upstream model ID is exactly `openrouter/free`. Configure that provider's OpenRouter credential inside Bifrost and allow the exact model on the
virtual key. The app receives only the Bifrost virtual key. Adding a provider key
to an environment file alone does not configure Bifrost or its allowlist.
Keep gateway fallback routes disabled for this profile; do not replace the model
with `openrouter/auto` or a paid model. Requests and tool results leave the machine
when the gateway uses OpenRouter.

OpenRouter's [free router](https://openrouter.ai/docs/guides/routing/routers/free-router)
selects from available free models and filters for request capabilities such as
tool calling. Availability can vary; this does not promise a particular model.
Chat responses preserve the gateway's returned `model`, while `/api/local-model/status` reports the
configured gateway route. Verify real text and tool-call/result continuation
against the current service; a successful text reply alone does not verify tools.
[Provider limits](https://openrouter.ai/docs/api_reference/limits) still apply.
Rate limits produce HTTP 429, and quota or temporary upstream unavailability
produces a visible error. Numeric `Retry-After` guidance is bounded to one day.
The adapter does not retry or change providers/models on failure and never sends
raw upstream error bodies to the browser.

To use local inference instead, set `GEV_LLM_MODEL` to a configured local model's
gateway identifier. The gateway endpoint and credential handling stay the same.

For another OpenAI-compatible local service, select `generic`. Bifrost uses
`x-bf-vk`; generic uses Bearer authentication. Instead of a JSON file, a process
environment variable or `.env.local` can supply `GEV_LLM_API_KEY`.

The file must be readable by the account running the app. Do not change a
different account's credential permissions just to start this application.
The app never sends the key, filename, or provider URL to browser code.

Any explicit `GEV_LLM_PROVIDER` selects the loopback text gateway. Invalid
configuration fails visibly. It does not fall back to OpenAI. In this profile
the HUD uses the configured model, and Realtime token/OAuth-login routes are
disabled.

Optionally set `GEV_LLM_HUD_MODEL=your-provider/your-small-local-model` for a
separate model to generate the HUD's five-word summaries. It uses the same
gateway and credential; leave it empty to use `GEV_LLM_MODEL`. Chat and globe
tool calls always use `GEV_LLM_MODEL`. These choices are server configuration,
not browser request parameters. Leave the HUD override empty to keep chat and
HUD on the same free route. HUD output is capped at 128 tokens, so choose a
model that can produce a short answer without a lengthy reasoning preamble.

Set `GEV_LLM_HUD_MIN_INTERVAL_MS=300000` to space automatic HUD attempts by at
least five minutes, including after provider errors, timeouts, and forced view
refreshes. The immediate telemetry summary remains available between requests.
The default is `0` to retain existing local-model behavior; accepted values are
bounded to one day. Restart the dev server or rebuild after changing it. This is
per-page pacing, not an account quota: reloads, other tabs, World Monitor, and
other gateway clients have independent request lifetimes.

The assistant panel identifies the actual returned model on each answer, and
the HUD API includes its returned `model` for verification. Provider errors stay
visible in the assistant panel instead of being replaced by generic advice.

Within this God's Eye View server, requests to the same gateway run one at a
time, with at most four chats waiting. A chat interrupts an active HUD summary;
HUD requests skip while the gateway is busy and keep the immediate telemetry
fallback. Chat requests have a 180-second deadline including queue time; HUD
requests have 60 seconds. This scheduling does not cover World Monitor or other
processes that use the gateway, and stopping remote inference depends on the
provider honoring cancellation.

## Start the hybrid

Use a local World Monitor checkout with the local-model gateway changes.
The companion contribution is
[World Monitor #9101](https://github.com/koala73/worldmonitor/pull/9101).
Install its dependencies and compile its backend with its documented build:

```sh
# In the World Monitor checkout:
node scripts/build-sidecar-handlers.mjs

# In this checkout:
npm run hybrid -- --world-monitor-root /absolute/path/to/worldmonitor
```

The launcher starts an isolated World Monitor sidecar on an available loopback
port, then serves the globe at `http://127.0.0.1:4173`. It verifies that World
Monitor cloud fallback is disabled. `--port 4174` selects another globe port.
Ctrl+C stops only the processes created by that launch.

Transport and operator keys are generated for that launch and remain in child
process memory. Both applications receive the same model gateway configuration.
The World Monitor child has legacy cloud-model credentials cleared for this
profile. The launch does not modify either checkout's saved credentials.

World Monitor news acquisition needs its native-sidecar rate-budget fix for
`list-feed-digest`. Without that fix, a backend without Redis returns 503.
Risk, advisories, and sanctions need their own populated caches. A running
service does not establish that those data sets exist or are current.

For an existing local World Monitor service, use `npm run dev` with:

```dotenv
WORLD_MONITOR_API_BASE=http://127.0.0.1:46123
WORLD_MONITOR_LOCAL_TOKEN_FILE=/absolute/path/to/local-transport-token.txt
WORLD_MONITOR_API_KEY_FILE=/absolute/path/to/operator-key.txt
```

These credential files contain plain text. Direct environment values are also
supported. The transport token and operator key have different purposes; do
not substitute a hosted subscription key for a local sidecar token.
Only a configured local address can receive credentials; redirects are refused.

## Local agents

The combined MCP endpoint is `http://127.0.0.1:4173/mcp`. It keeps the existing
God's Eye View tools and globe resources, then adds:

- `world_monitor_country_headlines`: cached country headlines with source dates.
- `world_monitor_country_brief`: deterministic headline and risk context.
- `world_monitor_feed_digest`: acquire/read the World Monitor news digest.

Call the digest before country headlines when the news cache is empty. Every
result distinguishes retrieval time from source time and reports coverage.
An unavailable feed is not evidence that nothing happened.
The Intelligence panel's **Refresh news** button acquires feeds and reloads
the selected country without requiring a model or agent.

For clients that use stdio:

```json
{
  "mcpServers": {
    "gods-eye-view-hybrid": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/gods-eye-view/server/mcp/stdio.js",
        "--api-base",
        "http://127.0.0.1:4173"
      ]
    }
  }
}
```

The app must already be running. HTTP MCP accepts direct same-host requests;
it refuses reverse proxies, forwarding headers, cross-origin browsers, and
launcher sharing. Containers need an explicit deployment design, not a relaxed
local gate. Build the existing MCP Apps globe resource with `npm run build:panel`
for clients that render MCP Apps. Ordinary tool clients still receive view links.

## What this implementation covers

The globe retains upstream public cameras, aircraft, satellites, hazards,
weather, and optional credentialed feed support. The hybrid adds a native
country Intelligence panel and local text/tool session. Local agents can query
both applications through one MCP server. The panel sends selected country
context and actual tool results to the configured model, with bounded history.

This adapter sends text only. Microphone transcription, speech synthesis,
continuous voice interruption, image understanding, and embeddings remain
unconfigured capabilities. These require additional, explicitly configured
services or adapters; selecting a text route does not enable them. This build
does not claim all World Monitor Pro features or universal OSINT coverage. It does not import every
World Monitor panel or provide missing commercial data.

Third-party feed credentials still belong to individual providers. Traffic
motion is simulated from aggregate flow; it does not identify individual cars.
Camera and aircraft coverage varies by source and region. Preserve those
limitations in downstream agent answers.

## Verification

Run the repository's unit, tracking, build, formatting, and package boundary
checks. With the hybrid running, `npm run qa:hybrid` checks the panel in a real
browser. Set `PUPPETEER_EXECUTABLE_PATH` if using an already installed Chrome.
Set `QA_LIVE_LOCAL_MODEL=1` to additionally exercise a real configured-model/tool
round trip. This opt-in run acquires public news and consumes inference;
it requires the configured gateway and World Monitor service.
