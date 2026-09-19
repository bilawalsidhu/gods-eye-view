# Creation log — OnDemand Spatial registration surfaces, 2026-09-19

Every request and response below was made in this run (UTC timestamps). The OnDemand API key is masked as `<MASKED>` everywhere; no other secret was involved. Companion raw evidence (masked) lives in `docs/registration/creation-evidence-2026-09-19/`.

## 0. Outcome in one paragraph

The session key authenticated against the docs API, the public REST API and the OnDemand MCP server, and the pre-flight checks passed (marketplace holds no equivalent tool; the account holds zero plugins). The `earthquake_search` REST tool could **not** be created: the only create surface — MCP `plugin_v1_plugin_create` / undocumented `POST https://api.on-demand.io/plugin/v1` — accepted the request shape but failed server-side on all six variants (`isError:true`, empty message; REST 500, empty body). Consequently no agent could be created with the tool attached, no skill surface exists (dashboard-only), and the workflow `6aace534859f7b0abb53d99a` was read but not modified (nothing to attach). The route itself was verified (200, 17 events ≥ M4.5 in the last 24 h) and one end-to-end chat query ran successfully but — with no tool attached — the model answered that no earthquake tool is available. Ready-to-paste material for the dashboard is in `READY_TO_PASTE.md`.

## 1. Credentials and environment (names only)

| Check | Result | UTC |
|---|---|---|
| `ON_DEMAND_API_KEY` (the step-3 runtime credential; the task's `ONDEMAND_API_KEY` alias is not set) | PRESENT (32 chars, masked) — `GET https://gateway.on-demand.io/config/v1/public/docs/categories` → 200 | 2026-09-19T11:29:33Z |
| `ON_DEMAND_BASE_URL` | PRESENT → `https://gateway.on-demand.io` (docs API host; the operations' own `servers[].url` are `https://api.on-demand.io…`) | 11:29:03Z |
| `ONDEMAND_SPATIAL_WORKFLOW_ID` | **MISSING in the environment** — resolved to `6aace534859f7b0abb53d99a` from `.env.example` (line 339) / the registration pack, and verified live (§6) | 11:29:03Z |
| `ONDEMAND_SELFTEST_TOKEN` | MISSING (not needed here) | 11:29:03Z |
| Platform `ondemand mcp` extension key (baked into the extension URL) | rejected: `{"errorCode":"unauthenticated","message":"Invalid API Key"}` on `config_v1_public_get_endpoints` | 11:29Z |
| Direct MCP connection with the session key (`https://mcp-server-prd.on-demand.io/mcp?apikey=<MASKED>`) | `initialize` 200 → `chat-proxy-mcp` 2.0.0; `tools/list` 200 → 57 tools | 11:33:28Z |
| `GITHUB_TOKEN`, `VERCEL_TOKEN`/`VERCEL_TEAM_ID`/`VERCEL_PROJECT_ID` | PRESENT (GitHub token used only by the github skill push; Vercel values unused) | — |

No credential request is needed: the required scope (docs, chat, plugin list, workflow read, MCP) is present. The plugin-create failure is a server-side 500, not an authentication or scope error (an unauthenticated call to the same host returns 401 `No API key header`; a scope problem would surface as 401/403, not 500).

## 2. Base URL resolution for the tool

Rule applied: production URL of Vercel project `ondemand-eand-spatial` if `GET <url>/api/sources/earthquakes` → 200, else the sandbox.

| Step | Result | UTC |
|---|---|---|
| `vercel ls` / `vercel project ls` | exit **126** — `vercel: BLOCKED by platform policy — the Vercel CLI is not available in this environment.` | 11:29:57Z |
| `.vercel/project.json` | absent from the repo clone | 11:29:57Z |
| Production aliases per the repo's audit records (`docs/audit/deployment-verification.md`, `closeout-2026-09-19.md`): `ondemand-eand-spatial.vercel.app`, `…-schoolhack-web-team.vercel.app`, `…-git-main-schoolhack-web-team.vercel.app` (production target `dpl_7CAo…` is BLOCKED on the Git-author check) | probed below | — |

| URL probed | HTTP | UTC |
|---|---|---|
| `https://ondemand-eand-spatial.vercel.app/api/sources/earthquakes` | 404 DEPLOYMENT_NOT_FOUND | 2026-09-19T11:29:57Z |
| `https://ondemand-eand-spatial-schoolhack-web-team.vercel.app/api/sources/earthquakes` | 404 DEPLOYMENT_NOT_FOUND | 2026-09-19T11:29:57Z |
| `https://ondemand-eand-spatial-git-main-schoolhack-web-team.vercel.app/api/sources/earthquakes` | 404 DEPLOYMENT_NOT_FOUND | 2026-09-19T11:29:57Z |
| `https://ondemand-eand-spatial-j8s1kk2zd-schoolhack-web-team.vercel.app/api/sources/earthquakes` | 200 (USGS, count 3 with minmagnitude=4.5&limit=3) | 2026-09-19T11:29:58Z |
| `https://sb-1np4tjtbq20v.vercel.run/api/sources/earthquakes` | 200 (USGS, count 3 with minmagnitude=4.5&limit=3) | 2026-09-19T11:29:59Z |

**Decision:** no production URL answered 200 → **base URL = `https://sb-1np4tjtbq20v.vercel.run`** (200 at 11:29:59Z). This sandbox **expires 2026-09-19T11:47:35Z**; the tool's `servers[0].url` **must be re-pointed after the CLI redeploy of commit `1b9e9a8`** to the project's production URL. Until then the durable READY preview `https://ondemand-eand-spatial-j8s1kk2zd-schoolhack-web-team.vercel.app` (deployment of `0677f16`; the earthquakes route is unchanged at the tip) also answered 200 at 11:29:58Z and 11:40:27Z and is the practical substitute recorded in `READY_TO_PASTE.md`.

## 3. MCP connection and discover-first

| UTC | Call | HTTP | Result |
|---|---|---|---|
| 2026-09-19T11:33:28.014Z | `initialize` | 200 | ok |
| 2026-09-19T11:33:28.112Z | `notifications/initialized` | 202 | ok |
| 2026-09-19T11:33:28.380Z | `tools/list` | 200 | session established, 57 tools |
| 2026-09-19T11:36:07.939Z | `tools/call public_v1_suggest_plugins` (query: *search recent earthquakes from USGS by time window, magnitude range and geographic area (circle or bbox) for the OnDemand Spatial map*, limit 8) | 200 | marketplace suggestions only — Planet Satellite Imagery, NASA FIRMS Fire Detector, YouTube Data API v3 - Captions, YouTube Data API v3 - Captions, Internet, GPT Search, X Search Agent, Universe Explorer; none is an `earthquake_search` against the OnDemand Spatial deployment → creation justified |
| 2026-09-19T11:36:08.172Z | `GET https://api.on-demand.io/plugin/v1/list?page=1&limit=50` (documented list) | 200 | `data.total = 0` — the account holds no plugins, so no duplicate exists |
| 2026-09-19T11:37:07.111Z | `GET https://api.on-demand.io/plugin/v1/list?page=1&limit=50` (documented list) | 200 | `data.total = 0` — the account holds no plugins, so no duplicate exists |
| 2026-09-19T11:39:50.332Z | `GET https://api.on-demand.io/plugin/v1/list?page=1&limit=50` (documented list) | 200 | `data.total = 0` — the account holds no plugins, so no duplicate exists |

## 4. Create `earthquake_search` — six attempts, none succeeded

Payload common to all attempts (masked/abridged): `name: earthquake_search`, `description:` the pack's description (*Search recent/historical earthquakes from USGS by time window, magnitude range and geographic area (circle or bbox). Returns observed events with UTC time, magnitude, depth, location, tsunami flag and USGS URL.*), `logoUrl: https://ondemand-eand-spatial-j8s1kk2zd-schoolhack-web-team.vercel.app/logo.svg` (200 image/svg+xml; the pack supplies no logo and the field is required), `type: chat`, `source: external`, `conversationStarters:` the pack's two starters, `action.schema:` the exact `docs/ondemand-workflows/tools/earthquake_search.openapi.json` with `servers[0].url` set to the chosen base URL — 11,311 bytes, sha256 `0943ff7df4617e1eaedaaa68feb0dae69baffebebdfd0671f6586bee008f5f92` (the identical JSON is reproduced in `READY_TO_PASTE.md` §1).

| # | UTC | Channel | Variant | Response |
|---|---|---|---|---|
| 1 | 2026-09-19T11:36:14.363Z | MCP `tools/call plugin_v1_plugin_create` (HTTP 200) | identifier `rest`, category `Research`, status `private`, `action = {authentication:{type:none}, fields:[], schema:<object>}` | `isError:true` — `json: cannot unmarshal object into Go struct field PluginAction.action.schema of type string` (schema must be a string) |
| 2 | 2026-09-19T11:36:18.449Z | MCP `tools/call plugin_v1_plugin_create` (HTTP 200) | identifier `rest`, category `Research`, status `private`, `action = {authentication:{type:none}, fields:[], schema:<JSON string>}` | `isError:true`, **empty** message (`content[0].text == ""`) |
| 3 | 2026-09-19T11:36:44.349Z | MCP `tools/call plugin_v1_plugin_create` (HTTP 200) | identifier `rest`, category `Research`, status `private`, `action = {schema:<JSON string>}` only | `isError:true`, **empty** message (`content[0].text == ""`) |
| 4 | 2026-09-19T11:37:06.838Z | MCP `tools/call plugin_v1_plugin_create` (HTTP 200) | identifier `rest`, category `data_and_analytics` (slug form seen on live marketplace plugins), no `status`, `action = {schema:<string>}` | `isError:true`, **empty** message (`content[0].text == ""`) |
| 5 | 2026-09-19T11:39:49.845Z | MCP `tools/call plugin_v1_plugin_create` (HTTP 200) | identifier `rest_api` (the identifier live REST plugins carry), category `Research`, `action = {schema:<string>}` | `isError:true`, **empty** message (`content[0].text == ""`) |
| 6 | 2026-09-19T11:39:50.135Z | MCP `tools/call plugin_v1_plugin_create` (HTTP 200) | identifier `rest_api`, category `data_and_analytics`, `action = {schema:<string>}` | `isError:true`, **empty** message (`content[0].text == ""`) |
| 7 | 2026-09-19T11:37:45.536Z | REST probe `POST https://api.on-demand.io/plugin/v1` (same body as #2) | undocumented endpoint behind the MCP tool | **500**, empty body |
| 8 | 2026-09-19T11:38:31.851Z | REST diagnostic `POST /plugin/v1` with `{}` | — | 400 — `CreatePluginRequest.Name/Identifier/Description/LogoUrl/Type/Source/Category … required` (endpoint validates input) |
| 9 | 2026-09-19T11:39:20.735Z | REST diagnostic `POST /plugin/v1` with an invalid identifier, no `action` | — | **500**, empty body (so the 500 is not caused by the schema payload) |

Post-checks: `GET /plugin/v1/list` → 200, `data.total = 0` at 11:37:07Z and 11:39:50Z — **nothing was created**, no clean-up needed. Attempts were stopped at this point (anti-loop cap; two distinct error classes exhausted).

Capability probe (nothing persisted): MCP `public_v1_plugin_ai_generated_tool_create` with `isAutoSave:false` and a natural-language description of the route → **HTTP 520** (Cloudflare *origin returned an unknown error*) at 11:38:32Z. It was not retried and never run with `isAutoSave:true`, because it would not honour the pack's exact OpenAPI definition.

## 5. Agent and skills

- **`OnDemand Spatial Intelligence Agent` (system prompt + attached `earthquake_search` + nine skills):** no API or MCP operation accepts a system prompt or an agent→tool/skill attachment (`plugin_v1_plugin_create` has no such field; the 40 documented operations have none; `tools/list` exposes no skill tool). Not created. Dashboard path and verbatim values: `READY_TO_PASTE.md` §3 and §4.
- **Nine skills:** no create/list/attach surface exists in the docs API, the public docs, the MCP tool list or the labelled probes (`POST /skills` 404, `POST /skills/v1/skills` 404, `POST /plugin/v1/skills` 404, `POST /automation/api/skills` 404, `GET /skills` 404, `GET /plugin/v1/skills` 400 *Agent plugin not found*). Not created. Verbatim SKILL.md bodies: `READY_TO_PASTE.md` §2.

## 6. Workflow `6aace534859f7b0abb53d99a` — read, not modified

`GET https://api.on-demand.io/automation/api/workflow/6aace534859f7b0abb53d99a` → **200** at 2026-09-19T11:40:28.203Z: name `OnDemand Spatial Advanced Workflow`, `isActive: True`, `enableMemory: False`, trigger `webhook` → `['session_context']`, 9 nodes (all `type: llm`), no `plugins` on any node, `lastModifiedAtInMilliseconds = 1789715764702`.

| Node key | kind | model | plugins | nextNodeKeys |
|---|---|---|---|---|
| `session_context` | source | `predefined-gpt-5.6-luna` | None | ['spatial_context_builder'] |
| `spatial_context_builder` | intermediate | `predefined-gpt-5.6-luna` | None | ['intent_classifier'] |
| `intent_classifier` | intermediate | `predefined-gpt-5.6-luna` | None | ['capability_resolver'] |
| `capability_resolver` | intermediate | `predefined-gpt-5.6-luna` | None | ['planner'] |
| `planner` | intermediate | `predefined-claude-sonnet-5` | None | ['verification'] |
| `verification` | intermediate | `predefined-claude-sonnet-5` | None | ['spatial_action_planner'] |
| `spatial_action_planner` | intermediate | `predefined-claude-sonnet-5` | None | ['synthesis'] |
| `synthesis` | intermediate | `predefined-gpt-5.6-luna` | None | ['structured_response'] |
| `structured_response` | sink | `predefined-gpt-5.6-luna` | None | None |

**Attach step:** not performed — there is no `earthquake_search` pluginId to add to `nodes[].llm.plugins`. **Before/after diff: none (no write was issued; `PATCH /workflow/{id}` / MCP `automation_api_workflow_update` were not called). Activation state untouched (`isActive: true`).** The full GET body is saved as `creation-evidence-2026-09-19/workflow_6aace534859f7b0abb53d99a_before.json`. When a pluginId exists, the documented attach is `PATCH https://api.on-demand.io/automation/api/workflow/6aace534859f7b0abb53d99a` with the same `trigger`/`nodes`/`delivery` and `{"id": "<pluginId>"}` appended to `llm.plugins` of `capability_resolver` (and, if desired, `verification`) — the repo wrapper is `node scripts/ondemand-workflow.mjs update 6aace534859f7b0abb53d99a` (pack §5(E)).

## 7. Tool test / validate

The platform's *Test and validate* runs against a created plugin; with none created it could not run. The route itself was tested with the exact parameters the end-to-end query needs:

| UTC | Request | HTTP | Result |
|---|---|---|---|
| 2026-09-19T11:40:27.012Z | `GET https://sb-1np4tjtbq20v.vercel.run/api/sources/earthquakes?starttime=2026-09-18T11%3A40%3A27Z&endtime=2026-09-19T11%3A40%3A27Z&minmagnitude=4.5&orderby=time&limit=50` | 200 | source `USGS`, **count 17**, first events: us7000tiiz M4.8 2026-09-19T10:31:17.071Z 18 km SW of Mongar, Bhutan; us7000tiis M5 2026-09-19T09:59:59.264Z South Sandwich Islands region; us7000tiim M4.8 2026-09-19T09:34:04.394Z 268 km NNW of Kuril’sk, Russia |
| 2026-09-19T11:40:27.217Z | `GET https://ondemand-eand-spatial-j8s1kk2zd-schoolhack-web-team.vercel.app/api/sources/earthquakes?starttime=2026-09-18T11%3A40%3A27Z&endtime=2026-09-19T11%3A40%3A27Z&minmagnitude=4.5&orderby=time&limit=50` | 200 | source `USGS`, **count 17**, first events: us7000tiiz M4.8 2026-09-19T10:31:17.071Z 18 km SW of Mongar, Bhutan; us7000tiis M5 2026-09-19T09:59:59.264Z South Sandwich Islands region; us7000tiim M4.8 2026-09-19T09:34:04.394Z 268 km NNW of Kuril’sk, Russia |

## 8. End-to-end chat (documented Chat API, session key)

Session created and one query submitted with the earthquake question. Because no tool exists, `agentIds`/`pluginIds` could not be set; the model was asked to say so if no tool is attached.

### 8.1 create_session — 2026-09-19T11:40:52.219Z

Request:
```json
{
 "method": "POST",
 "url": "https://api.on-demand.io/chat/v1/sessions",
 "headers": {
  "apikey": "<MASKED>",
  "Content-Type": "application/json"
 },
 "body": {
  "externalUserId": "ondemand-spatial-recheck-2026-09-19"
 }
}
```
Response (HTTP 201):
```json
{
 "message": "Chat session created successfully",
 "data": {
  "id": "6aae74c46f9b84bf0f592378",
  "companyId": "6692b763e851d28a036ab30e",
  "externalUserId": "ondemand-spatial-recheck-2026-09-19",
  "agentIds": [],
  "pluginIds": [],
  "contextMetadata": [],
  "title": "",
  "status": "draft",
  "createdBy": "6692b763e851d28a036ab30f",
  "createdAt": "2026-09-19T11:40:52.392533116Z",
  "updatedAt": "2026-09-19T11:40:52.392533116Z",
  "liveSettings": {
   "enabled": false,
   "mode": "on-events",
   "destinations": {
    "email": {
     "enabled": false
    },
    "slack": {
     "enabled": false
    }
   }
  }
 }
}
```

### 8.2 submit_query — 2026-09-19T11:40:52.407Z

Request:
```json
{
 "method": "POST",
 "url": "https://api.on-demand.io/chat/v1/sessions/6aae74c46f9b84bf0f592378/query",
 "headers": {
  "apikey": "<MASKED>",
  "Content-Type": "application/json"
 },
 "body": {
  "endpointId": null,
  "query": "List the earthquakes above M4.5 in the last 24 hours (use the earthquake_search tool if it is available to you; otherwise say plainly that no earthquake tool is attached to this session).",
  "responseMode": "sync",
  "reasoningEffort": "low"
 }
}
```
Response (HTTP 400):
```json
{
 "message": "endpointId is required",
 "errorCode": "invalid_request"
}
```

### 8.3 submit_query (retry with endpointId) — 2026-09-19T11:41:10.692Z

Request:
```json
{
 "method": "POST",
 "url": "https://api.on-demand.io/chat/v1/sessions/6aae74c46f9b84bf0f592378/query",
 "headers": {
  "apikey": "<MASKED>",
  "Content-Type": "application/json"
 },
 "body": {
  "endpointId": null,
  "query": "List the earthquakes above M4.5 in the last 24 hours (use the earthquake_search tool if it is available to you; otherwise say plainly that no earthquake tool is attached to this session).",
  "responseMode": "sync",
  "reasoningEffort": "low"
 }
}
```
Response (HTTP 400):
```json
{
 "message": "endpointId is required",
 "errorCode": "invalid_request"
}
```

### 8.4 submit_query (with endpointId) — 2026-09-19T11:41:32.236Z

Request:
```json
{
 "method": "POST",
 "url": "https://api.on-demand.io/chat/v1/sessions/6aae74c46f9b84bf0f592378/query",
 "headers": {
  "apikey": "<MASKED>",
  "Content-Type": "application/json"
 },
 "body": {
  "endpointId": "predefined-gemini-2.5-flash",
  "query": "List the earthquakes above M4.5 in the last 24 hours (use the earthquake_search tool if it is available to you; otherwise say plainly that no earthquake tool is attached to this session).",
  "responseMode": "sync",
  "reasoningEffort": "low"
 }
}
```
Response (HTTP 400):
```json
{
 "message": "endpointId predefined-gemini-2.5-flash is not active",
 "errorCode": "invalid_request"
}
```

### 8.5 submit_query (active endpointId) — 2026-09-19T11:41:54.095Z

Request:
```json
{
 "method": "POST",
 "url": "https://api.on-demand.io/chat/v1/sessions/6aae74c46f9b84bf0f592378/query",
 "headers": {
  "apikey": "<MASKED>",
  "Content-Type": "application/json"
 },
 "body": {
  "endpointId": "predefined-gpt-5.6-luna",
  "query": "List the earthquakes above M4.5 in the last 24 hours (use the earthquake_search tool if it is available to you; otherwise say plainly that no earthquake tool is attached to this session).",
  "responseMode": "sync",
  "reasoningEffort": "low"
 }
}
```
Response (HTTP 200):
```json
{
 "message": "Chat query submitted successfully",
 "data": {
  "sessionId": "6aae74c46f9b84bf0f592378",
  "messageId": "6aae750287dd0db069eb8983",
  "answer": "No earthquake search tool is attached to this session, so I can\u2019t reliably list earthquakes above M4.5 from the last 24 hours.",
  "metrics": {
   "inputTokens": 1040,
   "outputTokens": 66,
   "totalTokens": 1106,
   "ragTimeSec": 0.63,
   "fulfillmentTimeSec": 1.78,
   "totalTimeSec": 2.41
  },
  "status": "completed"
 }
}
```

Notes: the two `endpointId is required` responses are this client's own mistake (the endpoint id field in `config_v1_public_get_endpoints` is `endpoint_id`, not `id`), disclosed rather than hidden; `predefined-gemini-2.5-flash` is listed but *not active* for this account; `predefined-gpt-5.6-luna` (the model the workflow's own nodes use) completed. **`tool_invoked: false`** — the answer states no earthquake tool is attached.

## 9. What did not complete

1. `earthquake_search` plugin creation (server-side 500 on the only create surface) → therefore no `tool_id`, no platform test/validate, no agent with the tool attached, no workflow attach, no tool-invoking chat.
2. `OnDemand Spatial Intelligence Agent` and the nine skills — no API/MCP surface exists (dashboard-only, see `READY_TO_PASTE.md`).
3. Vercel production URL — `vercel` CLI is blocked in this environment and the production aliases return 404; the sandbox base URL expires 2026-09-19T11:47:35Z.
