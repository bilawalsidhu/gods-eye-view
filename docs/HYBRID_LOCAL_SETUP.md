# Local hybrid: God's Eye View and World Monitor

This fork combines God's Eye View's globe and live layers with a local World
Monitor service. The Intelligence panel and MCP expose country headlines,
country risk context, and a news digest. A Bifrost or other local
OpenAI-compatible gateway supplies text reasoning and globe tool calls.

The integrations use HTTP between the applications. World Monitor source is
not copied into this MIT repository. Preserve World Monitor's AGPL license and
both projects' source/data notices in any distribution. Data provider terms
still apply. Neither an LLM key nor this integration grants feed subscriptions.

## Configure local inference

Use Node 24.14 or later within Node 24, or supported Node 26. Install the locked
dependencies with `npm ci`. Put the following configuration in an ignored,
owner-readable `.env.local` file:

```dotenv
GEV_HYBRID_ENABLED=true
GEV_LLM_PROVIDER=bifrost
GEV_LLM_BASE_URL=http://127.0.0.1:4043/openai/v1
GEV_LLM_MODEL=your-provider/your-local-model
GEV_LLM_API_KEY_FILE=/absolute/path/to/virtual-key.json
GEV_LLM_API_KEY_FIELD=virtual_key.value
```

Use the actual model identifier from your gateway. The configured URL is an
OpenAI base URL; the server appends `/chat/completions`. The gateway must listen
on localhost, 127.0.0.1, or ::1. Use your configured HTTP or HTTPS scheme.
HTTPS certificate verification remains enabled.

For another OpenAI-compatible local service, select `generic`. Bifrost uses
`x-bf-vk`; generic uses Bearer authentication. Instead of a JSON file, a process
environment variable or `.env.local` can supply `GEV_LLM_API_KEY`.

The file must be readable by the account running the app. Do not change a
different account's credential permissions just to start this application.
The app never sends the key, filename, or provider URL to browser code.

Any explicit `GEV_LLM_PROVIDER` selects local inference. Invalid configuration
fails visibly. It does not fall back to OpenAI. In this profile the HUD uses
the local model, and Realtime token/OAuth-login routes are disabled.

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
process memory. Both applications receive the same local model configuration.
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
        "--api-base", "http://127.0.0.1:4173"
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
context and actual tool results to the local model, with bounded history.

Local microphone transcription, speech synthesis, continuous voice interruption,
and image understanding are not supplied by Chat Completions. These require
separate local speech/vision services. This build does not claim all World
Monitor Pro features or universal OSINT coverage. It does not import every
World Monitor panel or provide missing commercial data.

Third-party feed credentials still belong to individual providers. Traffic
motion is simulated from aggregate flow; it does not identify individual cars.
Camera and aircraft coverage varies by source and region. Preserve those
limitations in downstream agent answers.

## Verification

Run the repository's unit, tracking, build, formatting, and package boundary
checks. With the hybrid running, `npm run qa:hybrid` checks the panel in a real
browser. Set `PUPPETEER_EXECUTABLE_PATH` if using an already installed Chrome.
Set `QA_LIVE_LOCAL_MODEL=1` to additionally exercise a real local-model/tool
round trip. This opt-in run acquires public news and consumes local inference;
it requires the configured gateway and World Monitor service.
