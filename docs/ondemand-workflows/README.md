# OnDemand Agents Flow Builder — `OnDemand Spatial Advanced Workflow` (v1)

Gate 6 (blueprint rules 22–23, 46–48). This directory holds the definition, the
live export, the verification record and the selftest baseline of the principal
OnDemand Spatial workflow on the OnDemand **Agents Flow Builder**. Every endpoint,
header, body field and node type used here comes from
`docs/ONDEMAND_API_CURRENT.md` §7 (the live-docs audit); nothing undocumented was
sent to the API.

## Rename (2026-09-18) — display name only, v1 frozen

| Item | Value |
| ---- | ----- |
| Old display name | `GodsEye Advanced Spatial Workflow` (the name at creation, 2026-09-18T07:16:04.335Z) |
| New display name | **`OnDemand Spatial Advanced Workflow`** |
| How | live, via the documented `PATCH https://api.on-demand.io/automation/api/workflow/6aace534859f7b0abb53d99a/name` (contract §7.1 "Update name") → **HTTP 200** at **2026-09-18T10:41:47.809Z** |
| Re-read | `GET /automation/api/workflow/{id}` → **HTTP 200** at **2026-09-18T10:41:48.119Z** returning name `OnDemand Spatial Advanced Workflow`, `isActive: true`, `lastModifiedAtInMilliseconds: 1789715764702` (identical to before the rename), 9 nodes |
| Unchanged | workflow id `6aace534859f7b0abb53d99a`; version label **v1** (`flowVersion` `"1"`); the trigger, the nine nodes and their prompts |
| Export file | renamed `gods-eye-advanced-v1.json` → **`ondemand-spatial-advanced-v1.json`** and refreshed from that GET: `_export.rename` records the PATCH (endpoint, UTC, HTTP status, from/to), `_export.exportedAtUtc` is the re-read time and `_export.firstExportedAtUtc` keeps the original **2026-09-18T07:19:44.067Z** |
| Frozen prompts | the node prompts inside the export still self-describe as the **"God's Eye pipeline"** and the `structured_response` task prompt still emits `runMeta.workflow` = `"GodsEye Advanced Spatial Workflow"`, because the v1 definition is frozen — a prompt edit would be a **v2** definition, which this rebrand deliberately does **not** create. Consumers validating a v1 run must accept that recorded string. |
| Env var | the repo's version label is read from `ONDEMAND_SPATIAL_FLOW_VERSION` (canonical) with `GODS_EYE_FLOW_VERSION` as the accepted alias, resolved **alias-first** (alias → canonical → default `'1'`) so the value already provisioned on the Vercel project (env id `usC3wgbut65gTkaR`) keeps winning; `/api/ondemand/health` reports `config.flowVersion.source` (the env NAME that resolved) plus `resolvedVia: alias\|canonical\|default`, `canonical`, `alias` |

## Status (2026-09-18)

| Item                     | Value                                                                                                                                                                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow name            | `OnDemand Spatial Advanced Workflow` (created as `GodsEye Advanced Spatial Workflow`; display name renamed live at 2026-09-18T10:41:47.809Z — see "Rename" above) |
| Workflow id (real)       | `6aace534859f7b0abb53d99a` (company `6692b763e851d28a036ab30e`)                                                                                                                                                                                                                                         |
| Version                  | **1** — the repo's own label (`ONDEMAND_SPATIAL_FLOW_VERSION`, alias `GODS_EYE_FLOW_VERSION` resolved alias-first / `FLOW_DEFAULTS.flowVersion`); the API has **no version field** (§7.3 "Versioning: NOT FOUND IN LIVE DOCS"); unchanged by the rename |
| Created via              | **API** — `POST https://api.on-demand.io/automation/api/workflow/` (§7.1, header `apikey`) → **HTTP 201** `{"id":"6aace534859f7b0abb53d99a"}` at **2026-09-18T07:16:04.335Z** (395 ms)                                                                                                                  |
| Activated via            | `POST /automation/api/workflow/6aace534859f7b0abb53d99a/activate` (§7.1) → **HTTP 200** at **2026-09-18T07:16:14.101Z**; `GET /workflow/{id}` at 07:16:14.336Z → `isActive: true`                                                                                                                       |
| Verified via             | `POST /workflow/{id}/execute` → **HTTP 200** `{"executionID":"6aace54bbb6a9a7035f431fc"}` at **2026-09-18T07:16:26.986Z**; polled `GET /execution/{id}` + `GET /execution/{id}/logs` (78 calls, all 200); final status **`success`**, total **163,104 ms**, time-to-first-log **657 ms** (first log event 07:16:27.311Z, `starting workflow execution`); node outputs read via `GET /execution/{id}/node/outputs` (200) |
| StructuredResponse       | **valid** — exactly `message, entities, actions, evidence, sources, suggestedNextActions, runMeta`; 6 actions, all among the 28 MapAction names: `fly_to_location, track_entity, set_layer_visibility, annotate_map, analyst_query, frame_overhead`                                                    |
| Export                   | `ondemand-spatial-advanced-v1.json` (formerly `gods-eye-advanced-v1.json`) — the documented **`GET /workflow/{id}`** object (first export 200 at 2026-09-18T07:19:44.067Z; refreshed after the rename, 200 at 2026-09-18T10:41:48.119Z) with credential-like fields stripped, plus the re-import `createBody`. A "Get Code"/export endpoint is **NOT FOUND IN LIVE DOCS** (§7.3), so the documented read endpoint is the export |
| Selftest (step 8)        | `GET /api/ondemand/selftest` on the sandbox emulator → **9 passed / 0 failed / 1 skipped** (only step 4 — the account has no agents); step 8 executed this workflow (execution `6aace8f487fc428d7c18a1f3`, time-to-first-log 298 ms) — see `contract-baseline.json`                                     |
| Config defaults          | `server/ondemand/config.js` `FLOW_DEFAULTS = { spatialFlowId: '6aace534859f7b0abb53d99a', flowVersion: '1' }` (re-exported by `api/ondemand/_config.js`, documented in `.env.example`)                                                                                                                  |

## How it was created (documented surfaces only)

1. `node scripts/ondemand-workflow.mjs build` renders the create-body from
   `server/ondemand/workflow-definition.js` (pure function; unit-tested to emit
   only the §7.2 `CreateWorkflowRequest` vocabulary).
2. **First attempt** included a dedicated Input node of the documented type
   `inputText` (`nodes[].type` enum `llm | inputText | advancedVoiceMode |
   approvalGate`, §7.2) with no configuration object — the OpenAPI schema
   documents none for it. The API rejected it: `POST /workflow/` → **HTTP 400**
   `{"message":"input: text config missing","errorCode":"invalid_request"}` at
   **2026-09-18T07:15:04.217Z**. The required text configuration is not part of
   the documented schema, so it was **not invented**; the Input stage is the
   trigger itself (see "Node mapping").
3. **Second attempt** (9 `llm` nodes, `webhook` trigger, `delivery: []`,
   `enableMemory: false`) → **HTTP 201** at 2026-09-18T07:16:04.335Z.
4. Activate → 200; execute → 200; poll status/logs; read node outputs; export.

All calls carried only the documented `apikey` header, read from the
`ONDEMAND_API_KEY` process environment variable (never written to any file;
redacted as `****` everywhere).

## Node mapping

The required stage chain and its mapping onto **documented** Builder node types.
`LLMMeta` (§7.2) is exactly `{ fulfillmentPrompt, prompt, model, plugins[] }`, so
every stage that has no documented node type is implemented as an `llm` node
with an explicit system prompt (`fulfillmentPrompt`) and a strict JSON-output
task prompt (`prompt`). There is **no documented reasoning-effort field on an
`llm` node** (`reasoningMode` exists only on `advancedVoiceMode`), so a tier's
effort is expressed through the tier's `endpointId` (`model`) and prompt
brevity; the intended effort is recorded in the "tier" column.

| #   | Required stage             | Node key (`nodes[].key`)  | Documented type / kind    | `model` (tier — `server/ondemand/config.js` TIER_DEFAULTS)              | App module / file it mirrors                                                                                                                      | Output (JSON)                                                                    |
| --- | -------------------------- | ------------------------- | ------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 0   | Input                      | _(trigger)_               | `trigger.type: "webhook"` | —                                                                       | client → `POST <webhook url>` `{"payload": {...}}` (§7.2 nodes guide); `api/ondemand/workflow.js` `action=execute` for the body-less API trigger  | trigger node output = the payload (API trigger: `""`)                            |
| 1   | Session Context            | `session_context`         | `llm` / `source`          | `predefined-gpt-5.6-luna` (ASK, `low`)                                  | `server/ondemand/session-service.js`, `server/ondemand/sessions-store.js`, `api/ondemand/sessions.js`                                            | `{mode, session, query, rawSpatialContext, capabilityCatalogue, investigation}`  |
| 2   | Spatial Context Builder    | `spatial_context_builder` | `llm` / `intermediate`    | `predefined-gpt-5.6-luna` (ASK)                                         | `src/ui/context*.js`, `src/app/stateChannel.js` (the §13 spatial-context producer), `src/layers/*/evidence.js`                                   | `{…, spatialContext (15 §13 fields), derived, contextWarnings}`                  |
| 3   | Intent Classifier          | `intent_classifier`       | `llm` / `intermediate`    | `predefined-gpt-5.6-luna` (ASK, **`low`** — the reasoning tier)         | `api/ondemand/chat.js` tier selection, `tierDefaults()` in `server/ondemand/config.js`                                                            | `{intent, confidence, tier, focus, needsExternalData, rationale, state}`         |
| 4   | Capability Resolver        | `capability_resolver`     | `llm` / `intermediate`    | `predefined-gpt-5.6-luna` (ASK)                                         | `src/registry/capabilities.json`, `docs/ondemand-workflows/tools/earthquake_search.json`, `server/serverless/earthquakes-route.js`               | `{selectedCapabilityIds, calls[{capabilityId, ondemandTool, route, params}], unmetNeeds, …}` |
| 5   | Planner                    | `planner`                 | `llm` / `intermediate`    | `predefined-claude-sonnet-5` (INVESTIGATE)                              | `server/providers/openai/instructions.js` (analyst plan conventions), `src/voice/commands.js`                                                     | `{plan{steps, candidateFindings, assumptions, unknowns}, …}`                     |
| 6   | Verification               | `verification`            | `llm` / `intermediate`    | `predefined-claude-sonnet-5` (INVESTIGATE; DEEP not expressible — see below) | `docs/audit/media-grounding-verification.md` (provenance rules), `src/layers/flights/evidence.js`, `src/layers/vessels/evidence.js`          | `{findings[{status verified\|unverified\|rejected}], evidence[], unknowns, …}`   |
| 7   | Spatial Action Planner     | `spatial_action_planner`  | `llm` / `intermediate`    | `predefined-claude-sonnet-5` (INVESTIGATE)                              | **`src/voice/actionSchemas.js`** (`GEV_ACTION_SCHEMAS`, the 28 MapAction names + parameter schemas — embedded as a digest in the prompt), `src/voice/commands.js` | `{actions[{name ∈ 28, params, reason, findingIds}], suggestedNextActions, …}`    |
| 8   | Synthesis                  | `synthesis`               | `llm` / `intermediate`    | `config.fulfillmentEndpointId` (default `predefined-gpt-5.6-luna`)      | `api/ondemand/chat.js` (fulfillment stage), `server/ondemand/sse.js`                                                                             | `{message, entities, …}`                                                         |
| 9   | StructuredResponse output  | `structured_response`     | `llm` / `sink`            | `predefined-gpt-5.6-luna` (ASK)                                         | client contract consumed by the OnDemand Spatial UI (`src/voice/session.js` action dispatch); validated by `validateStructuredResponse()`                | exactly `{message, entities, actions, evidence, sources, suggestedNextActions, runMeta}` |

Each node's `prompt` references its direct upstream output with the
`{<nodeKey>}` placeholder and the first node reads the trigger payload with
`{trigger}`. These placeholders are **prompt text, not API fields**; they are
not in the public docs but were live-observed (2026-09-18T07:10–07:16Z, via the
documented `GET /workflow/{id}`) in this account's existing dashboard-built
workflows (`{llm-1}`, `{in-0}`…, `{trigger}`), and the node outputs of the
verification run confirm they resolve (every node consumed the previous node's
JSON; the `trigger` node output of an API-triggered execution is `""`).

### Tiers vs. nodes

| Tier (TIER_DEFAULTS)                                 | Used by                                                                 | Note                                                                                                                                                   |
| ---------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ASK = `predefined-gpt-5.6-luna` + `reasoningMode: low` | session_context, spatial_context_builder, **intent_classifier**, capability_resolver, structured_response | `low` cannot be sent per node (no such `LLMMeta` field); the ASK model is used and the prompts demand terse classification                             |
| INVESTIGATE = `predefined-claude-sonnet-5` + `low`   | planner, verification, spatial_action_planner                           | the reasoning-heavy stages                                                                                                                             |
| DEEP = `predefined-claude-sonnet-5` + `high`         | _(not expressible)_                                                     | DEEP differs from INVESTIGATE only by `reasoningMode: high`, which an `llm` node cannot carry (§7.2); the same model is used at the INVESTIGATE setting |
| Fulfillment endpoint (`ONDEMAND_FULFILLMENT_ENDPOINT_ID`, default ASK winner) | synthesis                                                  | the node builds the analyst-facing message                                                                                                             |

## Input contract

The trigger payload (`{"payload": {...}}` on the webhook trigger) is:

```json
{
  "query": "What is unusual around this airport?",
  "spatialContext": { "camera": {}, "viewport": {}, "center": {}, "altitude": 0, "zoom": 0, "viewScale": "", "mapStack": "", "visibleBounds": {}, "activeLayers": [], "selectedEntity": null, "trackedEntity": null, "visibleEntities": [], "timeline": {}, "investigation": null, "userAction": "query" },
  "capabilityCatalogue": [ { "id": "earthquake.search", "ondemand_tool": "earthquake_search", "route": "/api/sources/earthquakes", "params": ["starttime", "…"] } ],
  "session": { "sessionId": null, "externalUserId": null, "locale": null, "tier": null, "priorTurns": [] },
  "investigation": null
}
```

When the run is started through the documented **API trigger**
(`POST /workflow/{id}/execute`, which "has no request body defined in the spec",
§7.1) the payload is empty; the `session_context` node then switches to
**SELFTEST mode** and uses the embedded fixture — the Abu Dhabi International
Airport (OMAA) viewport at 24.433 N 54.651 E, altitude 12,500 m, zoom 12.4,
`activeLayers` `flights` + `earthquakes` + `ais-live-vessels`, five sample
entities (three aircraft incl. one squawking 7700, two vessels), `timeline`
live, `investigation` null, `userAction` `query`, plus a one-entry capability
catalogue (`earthquake_search`) and the query above
(`selftestFixture()` in `server/ondemand/workflow-definition.js`). `runMeta.mode`
reports `"selftest"` for such runs and `"live"` for payload-driven runs.

## Output contract — StructuredResponse

Exactly seven keys: `message` (3–8 plain sentences), `entities[]`, `actions[]`
(each `{name, params, reason, findingIds}` with `name` restricted to the 28
MapAction names below and `params` restricted to that action's parameter keys),
`evidence[]` (`{findingId, entityId, field, value, sourceLayer}`), `sources[]`
(`{id, kind: in_view|capability, label, status: used|planned_not_executed}`),
`suggestedNextActions[]`, `runMeta` (`workflow, flowVersion, mode, intent, tier,
confidence, selectedCapabilityIds, unknowns, nodeChain, generatedAtUtc`).

The 28 MapAction names (read from `src/voice/actionSchemas.js`):
`fly_to_location, select_nearest_aircraft, adjust_camera_zoom, zoom_to_globe,
set_layer_visibility, show_data_layers_menu, set_panel_open, set_context_mode,
control_cockpit, set_visual_style, get_entity_context, get_current_view_state,
set_hud, set_detection, set_map_stack, set_post_processing, control_scene,
control_cctv, control_radio, track_entity, stop_tracking, frame_overhead,
annotate_map, clear_annotations, move_camera, fly_route, analyst_query,
next_iss_pass`.

## Limitations (all with the documentation evidence)

| Topic                                  | Finding                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stream-logs endpoint                   | **NOT FOUND IN LIVE DOCS** (§7.1: "only the polling `GET …/logs` exists"). Verification and selftest poll `GET /execution/{id}` + `GET /execution/{id}/logs`; time-to-first-log = first poll that returned ≥1 log entry, minus the execute call time. `api/ondemand/workflow.js?action=stream-logs` keeps answering 501.                                                                                                       |
| "Get Code" / export                    | **NOT FOUND IN LIVE DOCS** (§7.3). `ondemand-spatial-advanced-v1.json` is the documented `GET /workflow/{id}` object; `POST /workflow/upload/config` (multipart `file`) is the only documented import-by-file surface and its file format is not documented, so re-import uses `POST /workflow/` with `createBody` instead.                                                                                                        |
| Versioning                             | **NOT FOUND IN LIVE DOCS** (§7.3) — `flowVersion` is the repo's label (1).                                                                                                                                                                                                                                                                                                                                             |
| Execute request body                   | None documented (§7.1) → API-triggered runs are SELFTEST-mode runs; live payloads go through the webhook trigger.                                                                                                                                                                                                                                                                                                       |
| Webhook trigger URL                    | Generated by the platform and shown on the workflow canvas only; `GET /workflow/{id}` returns `trigger.webhook = {auth:{username:"",password:""}}` without a URL (live, 2026-09-18T07:16:13Z). Read it from the dashboard (`https://app.on-demand.io/agents` → this workflow → trigger node) and POST `{"payload": {...}}` to it (§7.2 / nodes guide).                                                                     |
| `inputText` node                       | Rejected live with 400 `input: text config missing` (2026-09-18T07:15:04Z) because its text configuration is undocumented → not used.                                                                                                                                                                                                                                                                                  |
| Per-node reasoning effort              | No `LLMMeta` field (§7.2) → expressed through the tier's model; DEEP (`high`) is not expressible on an `llm` node.                                                                                                                                                                                                                                                                                                      |
| Delivery                               | `delivery: []` (no email/slack/webhook/phone channel is wanted for an API-consumed workflow); the run log ends with `delivery stage not found; ending execution` and the result is read from `GET /execution/{id}/node/outputs` → `outputs.structured_response.value`.                                                                                                                                                  |
| Latency                                | The 9-node chain took 163 s end to end (per-node 7.6–34.3 s; the three Sonnet-5 nodes 26–34 s each). Suitable for INVESTIGATE/DEEP requests started from the UI; ASK requests keep using `/api/ondemand/chat`. The selftest therefore reports the documented asynchronous `executing` status after its 12 s polling window rather than waiting for completion.                                                             |
| Agents / plugins on nodes              | `llm.plugins: []` — the account exposes no agent ids (`GET /plugin/v1/list` → total 0, 2026-09-18T07:09:37Z). Once the `earthquake_search` REST agent exists (dashboard-only, see `docs/audit/dashboard-registration-pack.md`), add `{ "id": "<pluginId>" }` to the `capability_resolver` and `planner` nodes and re-run `update`.                                                                                        |

## Files

| File                                    | Purpose                                                                                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ondemand-spatial-advanced-v1.json`     | Live export (`workflow` = documented GET object, secrets stripped) + `createBody` (re-import body) + `_export` provenance (UTC, HTTP status, and the `rename` block for the 2026-09-18 display-name PATCH); renamed from `gods-eye-advanced-v1.json` |
| `verification-2026-09-18.json`          | Verification record: every HTTP call (status, ms, UTC), the 29-event log sequence, per-node timings, the final StructuredResponse and its validation result   |
| `contract-baseline.json`                | Selftest baseline (updated in place; previous runs in `history[]`)                                                                                            |
| `tools/earthquake_search.json`          | Tool definition of the `earthquake_search` capability (Gate 3)                                                                                                |
| `tools/earthquake_search.openapi.json`  | OpenAPI 3.0.3 document for registering `/api/sources/earthquakes` as a REST agent in the dashboard                                                            |
| `../../server/ondemand/workflow-definition.js` | The builder (source of truth for the prompts) — `server/ondemand/workflow-definition.test.mjs` asserts the export equals the current build                |
| `../../scripts/ondemand-workflow.mjs`   | Operator CLI (build/create/get/list/activate/deactivate/update/export/execute/status/logs/outputs/executions/verify)                                          |

## Re-import steps (another company / a fresh account)

Prerequisite: `export ONDEMAND_API_KEY=…` in the shell only (never in a file).

```bash
# 1. Render the body from the code (or use "createBody" from ondemand-spatial-advanced-v1.json)
node scripts/ondemand-workflow.mjs build > /tmp/ondemand-spatial-create-body.json

# 2. Create — documented POST /automation/api/workflow/ (§7.1) → 201 {"id": "<newId>"}
node scripts/ondemand-workflow.mjs create
#    equivalent curl:
#    curl -sS -X POST "https://api.on-demand.io/automation/api/workflow/" \
#      -H "apikey: $ONDEMAND_API_KEY" -H "Content-Type: application/json" \
#      --data @/tmp/ondemand-spatial-create-body.json

# 3. Activate — documented POST /workflow/{id}/activate → 200
node scripts/ondemand-workflow.mjs activate <newId>

# 4. Verify — execute (no body) + poll status/logs + validate the StructuredResponse
node scripts/ondemand-workflow.mjs verify <newId> --report docs/ondemand-workflows/verification-$(date -u +%F).json

# 5. Export the documented GET object for the repo
node scripts/ondemand-workflow.mjs export <newId> docs/ondemand-workflows/ondemand-spatial-advanced-v1.json
```

Then paste `<newId>` into: `server/ondemand/config.js` `FLOW_DEFAULTS.spatialFlowId`
(re-exported by `api/ondemand/_config.js`), `.env.example`
`ONDEMAND_SPATIAL_FLOW_ID`, `src/registry/capabilities.json`
`ondemand.workflow.id`, and bump `FLOW_DEFAULTS.flowVersion` /
`WORKFLOW_VERSION` if the definition changed. `npm run test:ondemand` fails
until the export and the defaults agree. To change prompts in place use
`node scripts/ondemand-workflow.mjs update <id>` (documented `PATCH
/workflow/{id}`), then re-export.

## Operating it

| Need                          | Direct (documented API)                                                            | Through the app's same-origin proxy (`api/ondemand/workflow.js`)                                   |
| ----------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Start a run (no payload)      | `POST /automation/api/workflow/{id}/execute` → `{executionID}`                     | `POST /api/ondemand/workflow?action=execute` (uses `ONDEMAND_SPATIAL_FLOW_ID` / FLOW_DEFAULTS)     |
| Start a run with a payload    | `POST <webhook url from the dashboard>` body `{"payload": {...}}`                  | — (not proxied; the URL is dashboard-only)                                                         |
| Status                        | `GET /automation/api/execution/{executionID}`                                      | `GET /api/ondemand/workflow?action=status&executionId=…`                                           |
| Logs (polling)                | `GET /automation/api/execution/{executionID}/logs`                                 | `GET /api/ondemand/workflow?action=logs&executionId=…`                                             |
| Result                        | `GET /automation/api/execution/{executionID}/node/outputs` → `outputs.structured_response.value` (JSON text) | `GET /api/ondemand/workflow?action=outputs&executionId=…`                                |
| Runs of the workflow          | `GET /automation/api/execution/list?workflowID={id}`                               | `GET /api/ondemand/workflow?action=list&workflowId={id}`                                           |

## Verification record (2026-09-18, key redacted `****`)

| Call                                                       | HTTP | UTC                      | Result                                                                                       |
| ---------------------------------------------------------- | ---- | ------------------------ | -------------------------------------------------------------------------------------------- |
| `POST /workflow/` (attempt 1, with `inputText` node)       | 400  | 2026-09-18T07:15:04.217Z | `input: text config missing` — dropped the node rather than inventing its config             |
| `POST /workflow/` (attempt 2)                              | 201  | 2026-09-18T07:16:04.335Z | `{"id":"6aace534859f7b0abb53d99a"}`                                                          |
| `GET /workflow/6aace534859f7b0abb53d99a`                   | 200  | 2026-09-18T07:16:13.646Z | 9 nodes, `isActive:false`, `delivery:null`, `enableMemory:false`                             |
| `POST /workflow/{id}/activate`                             | 200  | 2026-09-18T07:16:14.101Z | body `null`; GET at 07:16:14.336Z → `isActive:true`                                          |
| `POST /workflow/{id}/execute`                              | 200  | 2026-09-18T07:16:26.986Z | `{"executionID":"6aace54bbb6a9a7035f431fc"}`                                                 |
| `GET /execution/{id}` × 38 + `GET /execution/{id}/logs` × 38 | 200 | 07:16:27.330Z → 07:19:09.879Z | status `executing` → `success`; 29 log events; time-to-first-log 657 ms                   |
| `GET /execution/{id}/node/outputs`                         | 200  | 2026-09-18T07:19:10.090Z | outputs for all 9 nodes (+ `trigger` = `""`); `structured_response` parsed and validated      |
| `GET /workflow/{id}` (export)                              | 200  | 2026-09-18T07:19:44.067Z | written to `gods-eye-advanced-v1.json` (the file has since been renamed `ondemand-spatial-advanced-v1.json`) |
| `PATCH /workflow/{id}/name` (rename, display name only)    | 200  | 2026-09-18T10:41:47.809Z | `GodsEye Advanced Spatial Workflow` → `OnDemand Spatial Advanced Workflow`; id, v1, trigger, nodes and prompts unchanged |
| `GET /workflow/{id}` (re-export after rename)              | 200  | 2026-09-18T10:41:48.119Z | name `OnDemand Spatial Advanced Workflow`, `isActive:true`, `lastModifiedAtInMilliseconds` 1789715764702 (identical), 9 nodes → `ondemand-spatial-advanced-v1.json` |

Per-node execution time (ms): session_context 7,579 · spatial_context_builder
8,492 · intent_classifier 8,908 · capability_resolver 12,157 · planner 26,201 ·
verification 27,478 · spatial_action_planner 34,319 · synthesis 19,876 ·
structured_response 11,165. Log event sequence per node: `all dependencies
satisfied, proceeding to task execution` → `triggering next task execution` →
`node task executed successfully in N milliseconds`, framed by `starting
workflow execution` and `delivery stage not found; ending execution`.

The final message of that run began: _"The clearest verified anomaly is aircraft
SWR9DE (icao24:4b1a0c), airborne at altitude 3350 m, speed 240 kts, and squawking
7700 …"_ and correctly reported the planned `earthquake.search` call as
`planned_not_executed` (the workflow has no attached agent to perform it — see
"Agents / plugins on nodes" above).
