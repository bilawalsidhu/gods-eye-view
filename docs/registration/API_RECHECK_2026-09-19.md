# OnDemand public API re-check — 2026-09-19 (creation surfaces)

Read live on **2026-09-19** between 11:29Z and 11:42Z (UTC) against the 2026-09-17 baseline `docs/ONDEMAND_API_CURRENT.md` (re-validated 2026-09-18, §18) and the step-2 findings of this session (agent/plugin/skill creation judged dashboard-only; nine skills + `earthquake_search` OpenAPI authored outside the API). **Nothing below is from memory**: every row cites a fetch or call made in this pass with its HTTP status and UTC timestamp. Scope is restricted to the four surfaces the task named — plugin/tool creation, REST API Agent creation, skill creation/attachment, workflow creation/attachment — plus the MCP server, because it is the one channel that exposes a create operation.

Sources used in this pass (all fetched live; full per-URL tables in §4):

1. **Keyed docs API** — `GET https://gateway.on-demand.io/config/v1/public/docs/categories` (200, 2026-09-19T11:31:53Z) and the 40 per-operation OpenAPI references `…/docs/reference/api/<slug>` (41/41 HTTP 200, 2026-09-19T11:31:53Z–2026-09-19T11:32:14Z). 6 services, 40 operations; keyword scan of all 40 specs: `skill` 0, `tool` 0, `mcp` 0 occurrences; `plugin` only as `pluginIds` (chat) and `nodes[].llm.plugins[]` (workflow).
2. **Public docs site** — 63 URLs on docs.on-demand.io / api.on-demand.io / gateway.on-demand.io / app.on-demand.io fetched unauthenticated (44 × 200; `llms-full.txt`, `sitemap.xml`, `/api-reference*` → 404; two ReadMe 429 rate-limit responses, then 1 req/2 s). All 40 documentation pages that also appear in the 2026-09-17 baseline table are **byte-identical** to the baseline (e.g. `agent-skills.md` 13,394 B, `rest-based-plugins.md` 8,993 B, `post_workflow.md` 11,222 B).
3. **OnDemand MCP server** — `https://mcp-server-prd.on-demand.io/mcp` (streamable-HTTP). Not documented on the public site (llms.txt has no MCP entry; `/docs/mcp.md`, `/docs/mcp-server.md` → 404). It is the endpoint this platform's own `ondemand mcp` extension is configured with, so it was connected to directly with the session `ON_DEMAND_API_KEY` (`?apikey=` query, value masked everywhere): `initialize` HTTP 200 at 2026-09-19T11:33:28.014Z → `chat-proxy-mcp` v2.0.0, protocol 2025-03-26, capabilities logging+tools; `tools/list` HTTP 200 at 2026-09-19T11:33:28.380Z → **57 tools** (full list with input schemas in §3). The key baked into the platform's extension config is rejected (`{"errorCode":"unauthenticated","message":"Invalid API Key"}` from `config_v1_public_get_endpoints` via the extension at 11:29Z), which is why the session key was used for the direct connection.
4. **Labelled probes** of undocumented-but-plausible endpoints under the documented base URL (§4.4) — recorded as observations only, never as documentation.

## 1. Verdict table (restricted to the four surfaces + MCP)

Verdict = documentation status vs the 2026-09-17 baseline (**CONFIRMED / CHANGED / NEW / RETIRED**) + creatability (**API_CREATABLE / MCP_CREATABLE / DASHBOARD_ONLY**) as actually observed today.

| # | Surface | Verdict | Endpoint or MCP tool | HTTP method | HTTP status observed | UTC fetch timestamp | Doc URL |
|---|---|---|---|---|---|---|---|
| 1 | Plugin / tool creation from an OpenAPI schema (REST tool) — **documented surface** | **CONFIRMED · DASHBOARD_ONLY** — page byte-identical to baseline; creation = My Agents → Create Agents → paste/import OpenAPI schema → configure → Test and validate | dashboard `https://app.on-demand.io/rag-agents/my-agents` (no REST/MCP operation documented) | — | 200 (doc page) | 2026-09-19T11:34:28Z | https://docs.on-demand.io/docs/rest-based-plugins.md · https://docs.on-demand.io/docs/open-api-schema.md |
| 2 | Plugin / tool creation — **undocumented surface observed live** | **NEW · not usable (MCP_CREATABLE in schema only)** — MCP tool `plugin_v1_plugin_create` exists (7 required fields; `action.schema` must be a JSON **string** — attempt 1 with an object was rejected `json: cannot unmarshal object into Go struct field PluginAction.action.schema of type string`), but every well-formed create (6 variants: identifier `rest`/`rest_api`, category `Research`/`data_and_analytics`, with/without `status`/`authentication`/`fields`) returned `isError:true` with an **empty** message; the REST endpoint behind it, `POST https://api.on-demand.io/plugin/v1`, validates the same 7 fields (400 `CreatePluginRequest.Name … required`) and then answers **500 with an empty body**. Nothing was created (`GET /plugin/v1/list` total 0 before and after). | MCP `plugin_v1_plugin_create` @ `https://mcp-server-prd.on-demand.io/mcp` · REST `POST https://api.on-demand.io/plugin/v1` (probe) | MCP tools/call · POST | MCP: HTTP 200 / `isError:true` (×6) · REST: 400 (validation, empty body probe) · 500 (full payload) | 2026-09-19T11:36:14.363Z → 2026-09-19T11:39:50.135Z · REST 400 2026-09-19T11:38:31.851Z · 500 2026-09-19T11:37:45.536Z | not documented anywhere fetched (tools/list is the only source) |
| 3 | REST API Agent creation (the docs' *Agents* = the API's *plugins*; `llms.txt` maps *Agents API* → `/docs/plugin-api.md`) | **CONFIRMED · DASHBOARD_ONLY** — same click path as row 1; the only documented agent/plugin REST operation is read-only `GET /plugin/v1/list` (200, `data.total = 0` for this account at 11:36:07Z and 11:39:50Z) | `GET https://api.on-demand.io/plugin/v1/list` (list only) | GET | 200 (list) · doc page 200 | 11:36:07Z (list) · 2026-09-19T11:34:22Z (doc) | https://docs.on-demand.io/docs/plugin-api.md · https://docs.on-demand.io/docs/rest-based-plugins.md |
| 4 | Agent with a system prompt + attached REST tool (the pack's *OnDemand Spatial Intelligence Agent*) | **CONFIRMED · DASHBOARD_ONLY** — no API/MCP field carries a system prompt or an agent→tool attachment; the documented attach points are per-request (`pluginIds`/`agentIds` on Create Chat Session and Submit Query — both exercised today: session 201, query 200) | `POST https://api.on-demand.io/chat/v1/sessions` · `POST …/chat/v1/sessions/{sessionId}/query` (attach-at-runtime only) | POST | 201 (session) · 200 (query, `status: completed`) | 11:40:52Z · 11:41:54Z | https://docs.on-demand.io/reference/createchatsession.md · https://docs.on-demand.io/reference/submitquery.md |
| 5 | Skill creation (SKILL.md / zip) | **CONFIRMED · DASHBOARD_ONLY** — `agent-skills.md` byte-identical to baseline ("In your dashboard, open **Skills** and click **Create Skill**"); no skills operation in the 40 keyed specs, no MCP tool, and every probe (`POST /skills`, `/skills/v1/skills`, `/plugin/v1/skills`, `/automation/api/skills`, `GET /skills`) → 404 (`GET /plugin/v1/skills` → 400 `Agent plugin not found`, i.e. a plugin-id route, not a skills API) | dashboard `Skills → Create Skill` (no REST/MCP operation) | — | 200 (doc page) · probes 404/400 | 2026-09-19T11:32:24Z · probes 11:37:47Z–11:37:49Z | https://docs.on-demand.io/docs/agent-skills.md |
| 6 | Skill attachment to an agent | **CONFIRMED · DASHBOARD_ONLY** — "Add the skill to an agent or a Playground session"; no endpoint or MCP tool | dashboard (agent editor / Playground) | — | 200 (doc page) | 2026-09-19T11:32:24Z | https://docs.on-demand.io/docs/agent-skills.md |
| 7 | Workflow creation (Agents Flow Builder) | **CONFIRMED · API_CREATABLE** — documented in the keyed reference and on the site (byte-identical); also exposed as MCP tool `automation_api_workflow_create`. Not exercised today (the existing workflow was reused). | `POST https://api.on-demand.io/automation/api/workflow/` · MCP `automation_api_workflow_create` | POST | 200 (keyed spec) · 200 (site page) | 2026-09-19T11:32:06Z · 2026-09-19T11:32:30Z | https://docs.on-demand.io/reference/post_workflow.md · https://docs.on-demand.io/docs/workflow-api.md |
| 8 | Workflow tool/plugin attachment (agents on LLM / voice nodes) | **CONFIRMED · API_CREATABLE** — `nodes[].llm.plugins[{id}]` (schema `Plugin` in LLMMeta/AdvancedVoiceModeMeta) via `PATCH /workflow/{id}` or MCP `automation_api_workflow_update`; the live workflow `6aace534859f7b0abb53d99a` was read (200, active, 9 LLM nodes, `plugins` unset on all) and **left untouched** because no `earthquake_search` pluginId exists to attach (row 2) | `PATCH https://api.on-demand.io/automation/api/workflow/{id}` · `GET …/workflow/{id}` · MCP `automation_api_workflow_update` / `automation_api_workflow_get_by_id` | PATCH / GET | GET 200 (live workflow) · 200 (keyed spec) · 200 (site page) | 11:40:28Z (GET) · 2026-09-19T11:32:08Z · 2026-09-19T11:34:44Z | https://docs.on-demand.io/reference/patch_workflow-id.md · https://docs.on-demand.io/docs/workflow-nodes.md |
| 9 | Workflow activate / deactivate / execute / logs | **CONFIRMED · API** — `POST /workflow/{id}/activate|deactivate|execute`, `GET /execution/{executionID}/logs` (plain JSON array — **no streaming transport is documented**, same as baseline §7.3). Not exercised today (workflow already active; nothing to attach). | `POST …/workflow/{id}/activate` · `…/deactivate` · `…/execute` · `GET …/execution/{executionID}/logs` (+ MCP `automation_api_workflow_activate/deactivate/execute`, `automation_api_execution_get_logs`) | POST / GET | 200 · 200 · 200 (keyed specs) | 2026-09-19T11:32:09Z · 2026-09-19T11:32:10Z · 2026-09-19T11:32:03Z | https://docs.on-demand.io/reference/post_workflow-id-activate.md · https://docs.on-demand.io/reference/post_workflow-id-execute.md · https://docs.on-demand.io/reference/get_execution-executionid-logs.md |
| 10 | OnDemand MCP server | **NEW (vs baseline: no mention) · undocumented** — reachable and authenticating with the session key; 57 tools incl. create/update for workflows, chat sessions/queries, plugin create/configuration, AI-generated tool, serverless apps; **no skill tool, no agent-prompt tool**. `public_v1_plugin_ai_generated_tool_create` (draft probe, `isAutoSave:false`) → HTTP 520 (Cloudflare: origin error). | `https://mcp-server-prd.on-demand.io/mcp` (streamable-HTTP; `?apikey=<MASKED>`) | JSON-RPC POST (`initialize`, `tools/list`, `tools/call`) | initialize 200 · tools/list 200 · ai-generated-tool 520 | 2026-09-19T11:33:28.014Z · 2026-09-19T11:33:28.380Z · 11:38:32Z | not documented (llms.txt has no MCP entry; `/docs/mcp.md` 404 at 11:35:30Z) |

**RETIRED:** none of the baseline's operations for these surfaces disappeared — all 19 Agents Flow Builder operations, the 7 Chat operations and `GET /plugin/v1/list` are still present and byte-identical where a page comparison was possible.

**CHANGED:** no documentation change detected for these surfaces (40/40 comparable pages byte-identical to 2026-09-17/18). The only *behavioural* novelty is row 2 — an undocumented create surface that currently fails server-side.

### Cross-check against the step-2 findings

| Step-2 statement | Today |
|---|---|
| Agent / plugin / skill creation is dashboard-only | **Holds** for the documented API (rows 1, 3, 5, 6). Refinement: an undocumented MCP tool + `POST /plugin/v1` create surface exists but returned 500 on every attempt (row 2), so the practical answer is unchanged. |
| Nine skills + `earthquake_search` OpenAPI were authored outside the API | **Still required** — no skill API/MCP tool exists; the plugin create surface failed. Ready-to-paste material: `docs/registration/READY_TO_PASTE.md`. |
| Workflow `6aace534859f7b0abb53d99a` exists and is driven over the documented API | **Confirmed live** — `GET /automation/api/workflow/6aace534859f7b0abb53d99a` → 200, `isActive: true`, 9 `llm` nodes (`session_context → … → structured_response`), no plugins attached (11:40:28Z). |
| Env var `ONDEMAND_SPATIAL_WORKFLOW_ID` | **Not set in this workspace's environment**; the value `6aace534859f7b0abb53d99a` comes from `.env.example` line 339 and the registration pack and was verified live as above. |

## 2. Keyed docs API — every operation documented today (40)

| Service | Title | Slug | Method | Path | servers[].url | Fetch status | UTC |
|---|---|---|---|---|---|---|---|
| Media API | Fetch Media | `fetchmedia` | GET | `/media/v1/public/file` | `https://api.on-demand.io` | 200 | 2026-09-19T11:31:54Z |
| Media API | Create Media URL | `createmediaurl` | POST | `/media/v1/public/file` | `https://api.on-demand.io` | 200 | 2026-09-19T11:31:54Z |
| Media API | Delete Media | `deletemedia` | DELETE | `/media/v1/public/file/{fileId}` | `https://api.on-demand.io` | 200 | 2026-09-19T11:31:55Z |
| Services API | Convert audio to text | `convertaudiototext` | POST | `/execute/speech_to_text` | `https://api.on-demand.io/services/v1/public/service` | 200 | 2026-09-19T11:31:55Z |
| Services API | Convert text to audio | `converttexttoaudio` | POST | `/execute/text_to_speech` | `https://api.on-demand.io/services/v1/public/service` | 200 | 2026-09-19T11:31:56Z |
| Services API | Translate text to another language | `translatetext` | POST | `/execute/language_translation` | `https://api.on-demand.io/services/v1/public/service` | 200 | 2026-09-19T11:31:57Z |
| MQTT User Management API | Create a new MQTT user | `createmqttuser` | POST | `/config/v1/public/mqtt_user` | `https://gateway-dev.on-demand.io` | 200 | 2026-09-19T11:31:57Z |
| MQTT User Management API | Delete an MQTT user | `deletemqttuser` | DELETE | `/config/v1/public/mqtt_user/{userId}` | `https://gateway-dev.on-demand.io` | 200 | 2026-09-19T11:31:58Z |
| Projects Management API | Create a new project | `post_public-projects` | POST | `/public/projects` | `https://api.on-demand.io/chat/v1` | 200 | 2026-09-19T11:31:58Z |
| Projects Management API | List projects | `get_public-projects` | GET | `/public/projects` | `https://api.on-demand.io/chat/v1` | 200 | 2026-09-19T11:31:59Z |
| Projects Management API | Get project by ID | `get_public-projects-projectid` | GET | `/public/projects/{projectId}` | `https://api.on-demand.io/chat/v1` | 200 | 2026-09-19T11:31:59Z |
| Projects Management API | Update project | `patch_public-projects-projectid` | PATCH | `/public/projects/{projectId}` | `https://api.on-demand.io/chat/v1` | 200 | 2026-09-19T11:32:00Z |
| Projects Management API | Delete project | `delete_public-projects-projectid` | DELETE | `/public/projects/{projectId}` | `https://api.on-demand.io/chat/v1` | 200 | 2026-09-19T11:32:00Z |
| Projects Management API | Get sessions by project ID | `get_public-sessions` | GET | `/public/sessions` | `https://api.on-demand.io/chat/v1` | 200 | 2026-09-19T11:32:01Z |
| Agents Flow Builder API | Approve an approval gate node | `post_approvalgate-executionid-approval-nodekey-approve` | POST | `/approvalgate/{executionID}/approval/{nodeKey}/approve` | `https://api.on-demand.io/automation/api` | 200 | 2026-09-19T11:32:01Z |
| Agents Flow Builder API | Reject an approval gate node | `post_approvalgate-executionid-approval-nodekey-reject` | POST | `/approvalgate/{executionID}/approval/{nodeKey}/reject` | `https://api.on-demand.io/automation/api` | 200 | 2026-09-19T11:32:02Z |
| Agents Flow Builder API | Get execution by ID | `get_execution-executionid` | GET | `/execution/{executionID}` | `https://api.on-demand.io/automation/api` | 200 | 2026-09-19T11:32:02Z |
| Agents Flow Builder API | Get email delivery status for workflow executions. | `get_execution-executionid-delivery-track-email` | GET | `/execution/{executionID}/delivery/track/email` | `https://api.on-demand.io/automation/api` | 200 | 2026-09-19T11:32:03Z |
| Agents Flow Builder API | Get execution logs | `get_execution-executionid-logs` | GET | `/execution/{executionID}/logs` | `https://api.on-demand.io/automation/api` | 200 | 2026-09-19T11:32:03Z |
| Agents Flow Builder API | Get execution node outputs | `get_execution-executionid-node-outputs` | GET | `/execution/{executionID}/node/outputs` | `https://api.on-demand.io/automation/api` | 200 | 2026-09-19T11:32:04Z |
| Agents Flow Builder API | Report a problem with an execution | `post_execution-executionid-report-problem` | POST | `/execution/{executionID}/report-problem` | `https://api.on-demand.io/automation/api` | 200 | 2026-09-19T11:32:04Z |
| Agents Flow Builder API | Get voice mode transcripts for an execution | `get_execution-executionid-transcript` | GET | `/execution/{executionID}/transcript` | `https://api.on-demand.io/automation/api` | 200 | 2026-09-19T11:32:05Z |
| Agents Flow Builder API | List executions | `get_execution-list` | GET | `/execution/list` | `https://api.on-demand.io/automation/api` | 200 | 2026-09-19T11:32:05Z |
| Agents Flow Builder API | Create a new workflow | `post_workflow` | POST | `/workflow/` | `https://api.on-demand.io/automation/api` | 200 | 2026-09-19T11:32:06Z |
| Agents Flow Builder API | List workflows | `get_workflow` | GET | `/workflow/` | `https://api.on-demand.io/automation/api` | 200 | 2026-09-19T11:32:07Z |
| Agents Flow Builder API | Get workflow by ID | `get_workflow-id` | GET | `/workflow/{id}` | `https://api.on-demand.io/automation/api` | 200 | 2026-09-19T11:32:07Z |
| Agents Flow Builder API | Update workflow | `patch_workflow-id` | PATCH | `/workflow/{id}` | `https://api.on-demand.io/automation/api` | 200 | 2026-09-19T11:32:08Z |
| Agents Flow Builder API | Delete workflow | `delete_workflow-id` | DELETE | `/workflow/{id}` | `https://api.on-demand.io/automation/api` | 200 | 2026-09-19T11:32:08Z |
| Agents Flow Builder API | Activate workflow | `post_workflow-id-activate` | POST | `/workflow/{id}/activate` | `https://api.on-demand.io/automation/api` | 200 | 2026-09-19T11:32:09Z |
| Agents Flow Builder API | Deactivate workflow | `post_workflow-id-deactivate` | POST | `/workflow/{id}/deactivate` | `https://api.on-demand.io/automation/api` | 200 | 2026-09-19T11:32:09Z |
| Agents Flow Builder API | Execute workflow | `post_workflow-id-execute` | POST | `/workflow/{id}/execute` | `https://api.on-demand.io/automation/api` | 200 | 2026-09-19T11:32:10Z |
| Agents Flow Builder API | Update workflow name | `patch_workflow-id-name` | PATCH | `/workflow/{id}/name` | `https://api.on-demand.io/automation/api` | 200 | 2026-09-19T11:32:10Z |
| Agents Flow Builder API | Upload workflow configuration | `post_workflow-upload-config` | POST | `/workflow/upload/config` | `https://api.on-demand.io/automation/api` | 200 | 2026-09-19T11:32:11Z |
| Chat API | Create Chat Session | `createchatsession` | POST | `/chat/v1/sessions` | `https://api.on-demand.io` | 200 | 2026-09-19T11:32:11Z |
| Chat API | Get Chat Sessions | `getchatsessions` | GET | `/chat/v1/sessions` | `https://api.on-demand.io` | 200 | 2026-09-19T11:32:12Z |
| Chat API | Get Chat Session | `getchatsession` | GET | `/chat/v1/sessions/{sessionId}` | `https://api.on-demand.io` | 200 | 2026-09-19T11:32:12Z |
| Chat API | Get Chat Messages | `getchatmessages` | GET | `/chat/v1/sessions/{sessionId}/messages` | `https://api.on-demand.io` | 200 | 2026-09-19T11:32:13Z |
| Chat API | Get Chat Message | `getchatmessage` | GET | `/chat/v1/sessions/{sessionId}/messages/{messageId}` | `https://api.on-demand.io` | 200 | 2026-09-19T11:32:13Z |
| Chat API | Submit Query | `submitquery` | POST | `/chat/v1/sessions/{sessionId}/query` | `https://api.on-demand.io` | 200 | 2026-09-19T11:32:14Z |
| Chat API | Update Live Session Settings | `updatelivesessionsettings` | PUT | `/chat/v1/sessions/{sessionId}/live-settings` | `https://api.on-demand.io` | 200 | 2026-09-19T11:32:14Z |

Keyword scan over the 40 specs: `plugin` 84 hits (all `pluginIds` / `plugins[].id` attach fields), `agent` 45 (`agentIds`, `executedAgents`), `skill` 0, `tool` 0, `mcp` 0, `createagent` 0.

## 3. MCP server — tools enumerated (57) with input schemas

Server `chat-proxy-mcp` 2.0.0 · protocol 2025-03-26 · URL `https://mcp-server-prd.on-demand.io/mcp?apikey=<MASKED>` · enumerated 2026-09-19T11:33:28.462Z. Required arguments in **bold**; full JSON schemas are in the creation log's companion file `docs/registration/creation-evidence-2026-09-19/mcp_tools_list.json`.

| # | Tool | Required | All input properties | Description |
|---|---|---|---|---|
| 1 | `automation_api_execution_cancel` | **executionId** | executionId, timeoutMs | Cancels a running workflow execution. |
| 2 | `automation_api_execution_get_by_id` | **executionId** | executionId, timeoutMs | Retrieves an execution by ID including status and timing. |
| 3 | `automation_api_execution_get_email_delivery_stats` | **executionId** | executionId, timeoutMs | Returns email delivery statistics for a workflow execution. |
| 4 | `automation_api_execution_get_logs` | **executionId** | executionId, timeoutMs | Retrieves execution logs for a workflow execution. |
| 5 | `automation_api_execution_get_node_outputs` | **executionId** | executionId, timeoutMs | Retrieves node outputs for a workflow execution. |
| 6 | `automation_api_execution_get_transcript` | **executionId** | executionId, timeoutMs | Retrieves voice mode transcripts for a workflow execution. |
| 7 | `automation_api_execution_list` | **workflowId** | workflowId, afterId, timeoutMs | Lists executions for a workflow. |
| 8 | `automation_api_execution_list_email_delivery_tracking` | **executionId** | executionId, afterId, limit, status, timeoutMs | Lists email delivery tracking records for a workflow execution. |
| 9 | `automation_api_execution_report_problem` | **executionId**, **type**, **message** | executionId, type, message, timeoutMs | Reports a problem with a workflow execution. |
| 10 | `automation_api_voice_agent_activate` | **voiceAgentId** | voiceAgentId, timeoutMs | Activates a voice agent. |
| 11 | `automation_api_voice_agent_deactivate` | **voiceAgentId** | voiceAgentId, timeoutMs | Deactivates a voice agent. |
| 12 | `automation_api_voice_agent_get_by_id` | **voiceAgentId** | voiceAgentId, timeoutMs | Retrieves a voice agent by ID including config and phone number. |
| 13 | `automation_api_voice_agent_list` | — | name, isActive, afterId, resultCount, timeoutMs | Lists voice agents with optional filters (name, active status). |
| 14 | `automation_api_voice_agent_update` | **voiceAgentId**, **name**, **config** | voiceAgentId, name, config, timeoutMs | Updates a voice agent name and configuration. |
| 15 | `automation_api_voice_call_get_by_execution_id` | **executionId** | executionId, timeoutMs | Retrieves a voice call record for a workflow execution. |
| 16 | `automation_api_workflow_activate` | **workflowId** | workflowId, timeoutMs | Activates a workflow and sets up its trigger. |
| 17 | `automation_api_workflow_create` | **name**, **trigger**, **nodes**, **delivery** | name, externalUserID, trigger, nodes, delivery, contextMetadata, enableMemory, timeoutMs | Creates a new workflow with trigger, nodes, and delivery configuration. |
| 18 | `automation_api_workflow_deactivate` | **workflowId** | workflowId, timeoutMs | Deactivates a workflow and removes its trigger. |
| 19 | `automation_api_workflow_delete` | **workflowId** | workflowId, timeoutMs | Deletes a workflow by ID. |
| 20 | `automation_api_workflow_execute` | **workflowId** | workflowId, toPhoneNumber, timeoutMs | Executes an active workflow. Returns an execution ID. Optionally pass toPhoneNumber for voice workflows. |
| 21 | `automation_api_workflow_get_by_id` | **workflowId** | workflowId, timeoutMs | Retrieves a workflow by ID including trigger, nodes, and delivery configuration. |
| 22 | `automation_api_workflow_list` | — | after, limit, keyword, isActive, isPublished, externalUserID, timeoutMs | Lists workflows with optional filters (keyword, active status, published status, external user ID). |
| 23 | `automation_api_workflow_set_context_metadata` | **workflowId**, **contextMetadata** | workflowId, contextMetadata, timeoutMs | Updates the context metadata of a workflow. |
| 24 | `automation_api_workflow_set_name` | **workflowId**, **name** | workflowId, name, timeoutMs | Updates the name of a workflow. |
| 25 | `automation_api_workflow_stats` | — | externalUserID, timeoutMs | Returns workflow statistics (total, active, published) for the company. |
| 26 | `automation_api_workflow_update` | **workflowId**, **trigger**, **nodes**, **delivery** | workflowId, trigger, nodes, delivery, contextMetadata, enableMemory, timeoutMs | Updates an existing workflow's trigger, nodes, and delivery configuration. |
| 27 | `chat_v1_message_get_by_id` | **sessionId**, **messageId** | sessionId, messageId, timeoutMs | Get message by ID. |
| 28 | `chat_v1_messages_get_all` | **sessionId** | sessionId, externalUserId, sort, cursor, limit, timeoutMs | Get all messages of a session. |
| 29 | `chat_v1_session_get_by_id` | **sessionId** | sessionId, timeoutMs | Get a session by ID. |
| 30 | `chat_v1_session_submit_query` | **sessionId**, **query**, **endpointId**, **responseMode** | sessionId, query, endpointId, responseMode, reasoningMode, reasoningEffort, agentIds, modelConfigs, timeoutMs | Submits a query to an agent. |
| 31 | `chat_v1_session_update_context` | **sessionId**, **contextMetadata** | sessionId, contextMetadata, timeoutMs | Updates session metadata. |
| 32 | `chat_v1_sessions_create` | **externalUserId** | externalUserId, agentIds, contextMetadata, timeoutMs | Creates a new chat session. |
| 33 | `chat_v1_sessions_get_all` | — | externalUserId, sort, cursor, limit, timeoutMs | Lists all sessions. |
| 34 | `comm_events_send_email` | **to**, **name**, **subject**, **body**, **params**, **companyId** | to, name, subject, body, params, companyId | Sends a plain-text email by publishing a send_email_core42 event to the CommEvents Redis stream. |
| 35 | `config_v1_public_get_endpoints` | — | timeoutMs | Returns all available endpoints with their ID, name, and model ID. |
| 36 | `config_v1_public_get_github_token` | — | timeoutMs | Returns the GitHub token stored for the company associated with the caller's API key. |
| 37 | `config_v1_public_get_reasoning_modes` | — | timeoutMs | Returns all available reasoning modes (predefined and user-defined), including mode ID, name, model name, and rank. |
| 38 | `config_v1_public_serverless_application_create` | **name**, **serverlessRepo** | name, dockerScriptPath, appBuildMode, branchName, serverlessRepo, timeoutMs | Creates a serverless application linked to a repository. |
| 39 | `config_v1_public_serverless_application_delete` | **applicationId** | applicationId, timeoutMs | Deletes a serverless application. |
| 40 | `config_v1_public_serverless_application_list` | — | timeoutMs | Lists all serverless applications. |
| 41 | `config_v1_public_serverless_application_trigger_build` | **applicationId** | applicationId, timeoutMs | Triggers a build for a serverless application. |
| 42 | `config_v1_public_serverless_application_update` | **applicationId** | applicationId, name, dockerScriptPath, appBuildMode, branchName, serverlessRepo, timeoutMs | Updates a serverless application. |
| 43 | `config_v1_public_serverless_container_logs_get` | **endpointId** | endpointId, type, timeSpan, timeoutMs | Retrieves container logs for a serverless endpoint. |
| 44 | `config_v1_public_serverless_endpoint_create` | **targetPortNumber**, **application**, **endpointName** | targetPortNumber, application, environment, endpointName, serverlessComputeType, maxInstanceCount, minInstanceCount, environmentVariables, authorization, isPrivate, timeoutMs | Creates a serverless endpoint for an application. |
| 45 | `config_v1_public_serverless_endpoint_delete` | **endpointId** | endpointId, timeoutMs | Deletes a serverless endpoint. |
| 46 | `config_v1_public_serverless_endpoint_list` | — | timeoutMs | Lists all serverless endpoints. |
| 47 | `config_v1_public_serverless_endpoint_trigger_deploy` | **endpointId** | endpointId, timeoutMs | Triggers deployment of a serverless endpoint. |
| 48 | `config_v1_public_serverless_endpoint_update` | **endpointId** | endpointId, targetPortNumber, application, environment, endpointName, serverlessComputeType, maxInstanceCount, minInstanceCount, environmentVariables, authorization, status, isPrivate, timeoutMs | Updates a serverless endpoint. |
| 49 | `config_v1_public_serverless_image_build_details_get` | **applicationId** | applicationId, runId, timeoutMs | Retrieves image build details for a serverless application. |
| 50 | `config_v1_public_serverless_repo_create` | **repoUrl**, **repoPlatform**, **name** | repoUrl, isRepoPublic, repoPlatform, accessToken, name, timeoutMs | Creates a serverless Git repository configuration. |
| 51 | `config_v1_public_serverless_repo_delete` | **repoId** | repoId, timeoutMs | Deletes a serverless repository configuration. |
| 52 | `config_v1_public_serverless_repo_list` | — | timeoutMs | Lists all serverless repository configurations. |
| 53 | `config_v1_public_serverless_repo_update` | **repoId** | repoId, repoUrl, accessToken, isRepoPublic, timeoutMs | Updates a serverless repository configuration. |
| 54 | `plugin_v1_plugin_configuration_create` | **pluginId**, **active** | pluginId, active, fields, timeoutMs | Create a plugin configuration for a plugin or agent. Accepts pluginId, active flag, and optional metadata/fields. Returns the created PluginConfiguration. |
| 55 | `plugin_v1_plugin_create` | **name**, **identifier**, **description**, **logoUrl**, **type**, **source**, **category** | name, identifier, description, logoUrl, type, source, category, fileSubType, chatSubType, conversationStarters, privacyPolicy, status, action, timeoutMs | Create a new plugin/agent. Requires name, identifier, description, logoUrl, type (chat\|file), source (internal\|external), and category. Returns the created pl |
| 56 | `public_v1_plugin_ai_generated_tool_create` | **query** | query, sessionId, isAutoSave, timeoutMs | Generate a new AI-authored plugin/tool from a natural-language query (e.g. 'Create a tool to get weather by city using OpenWeather API'). Optionally accepts a s |
| 57 | `public_v1_suggest_plugins` | **query** | query, limit, timeoutMs | Search for suggested plugins/agents by query. Returns plugin ID, name, description, logo URL, category, and type. |

MCP calls made in this pass (all against the same URL, key masked):

| UTC | JSON-RPC method | Tool | HTTP status | Result |
|---|---|---|---|---|
| 2026-09-19T11:33:28.014Z | `initialize` | — | 200 | ok |
| 2026-09-19T11:33:28.112Z | `notifications/initialized` | — | 202 | ok |
| 2026-09-19T11:33:28.380Z | `tools/list` | — | 200 | ok |
| 2026-09-19T11:36:07.939Z | `tools/call` | `public_v1_suggest_plugins` | 200 | suggest_plugins → marketplace plugins only (Planet Satellite Imagery, NASA FIRMS Fire Detector, …) |
| 2026-09-19T11:36:14.363Z | `tools/call` | `plugin_v1_plugin_create` | 200 | variant 1 → isError:true, message: schema must be string |
| 2026-09-19T11:36:18.449Z | `tools/call` | `plugin_v1_plugin_create` | 200 | variant 1 → isError:true, message: empty |
| 2026-09-19T11:36:44.349Z | `tools/call` | `plugin_v1_plugin_create` | 200 | variant 3 → isError:true, message: empty |
| 2026-09-19T11:37:06.838Z | `tools/call` | `plugin_v1_plugin_create` | 200 | variant 4 → isError:true, message: empty |
| 2026-09-19T11:38:32.691Z | `tools/call` | `public_v1_plugin_ai_generated_tool_create` | 520 | DRAFT probe isAutoSave:false → HTTP 520 (Cloudflare origin error) |
| 2026-09-19T11:39:49.845Z | `tools/call` | `plugin_v1_plugin_create` | 200 | variant 5 → isError:true, message: empty |
| 2026-09-19T11:39:50.135Z | `tools/call` | `plugin_v1_plugin_create` | 200 | variant 6 → isError:true, message: empty |

## 4. Every documentation URL and probe fetched in this pass

### 4.1 Keyed docs API (gateway.on-demand.io, `apikey` header, value masked)

| # | URL | HTTP status | Bytes | UTC |
|---|---|---|---|---|
| 1 | https://gateway.on-demand.io/config/v1/public/docs/categories | 200 | 2918 | 2026-09-19T11:31:53Z |
| 2 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/fetchmedia | 200 | 4539 | 2026-09-19T11:31:54Z |
| 3 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/createmediaurl | 200 | 6963 | 2026-09-19T11:31:54Z |
| 4 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/deletemedia | 200 | 961 | 2026-09-19T11:31:55Z |
| 5 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/convertaudiototext | 200 | 1974 | 2026-09-19T11:31:55Z |
| 6 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/converttexttoaudio | 200 | 2326 | 2026-09-19T11:31:56Z |
| 7 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/translatetext | 200 | 2166 | 2026-09-19T11:31:57Z |
| 8 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/createmqttuser | 200 | 1450 | 2026-09-19T11:31:57Z |
| 9 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/deletemqttuser | 200 | 1093 | 2026-09-19T11:31:58Z |
| 10 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/post_public-projects | 200 | 5290 | 2026-09-19T11:31:58Z |
| 11 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/get_public-projects | 200 | 5886 | 2026-09-19T11:31:59Z |
| 12 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/get_public-projects-projectid | 200 | 4496 | 2026-09-19T11:31:59Z |
| 13 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/patch_public-projects-projectid | 200 | 5586 | 2026-09-19T11:32:00Z |
| 14 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/delete_public-projects-projectid | 200 | 3940 | 2026-09-19T11:32:00Z |
| 15 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/get_public-sessions | 200 | 5564 | 2026-09-19T11:32:01Z |
| 16 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/post_approvalgate-executionid-approval-nodekey-approve | 200 | 1487 | 2026-09-19T11:32:01Z |
| 17 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/post_approvalgate-executionid-approval-nodekey-reject | 200 | 1484 | 2026-09-19T11:32:02Z |
| 18 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/get_execution-executionid | 200 | 1990 | 2026-09-19T11:32:02Z |
| 19 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/get_execution-executionid-delivery-track-email | 200 | 2194 | 2026-09-19T11:32:03Z |
| 20 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/get_execution-executionid-logs | 200 | 1728 | 2026-09-19T11:32:03Z |
| 21 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/get_execution-executionid-node-outputs | 200 | 1709 | 2026-09-19T11:32:04Z |
| 22 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/post_execution-executionid-report-problem | 200 | 1500 | 2026-09-19T11:32:04Z |
| 23 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/get_execution-executionid-transcript | 200 | 1904 | 2026-09-19T11:32:05Z |
| 24 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/get_execution-list | 200 | 1998 | 2026-09-19T11:32:05Z |
| 25 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/post_workflow | 200 | 5314 | 2026-09-19T11:32:06Z |
| 26 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/get_workflow | 200 | 5567 | 2026-09-19T11:32:07Z |
| 27 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/get_workflow-id | 200 | 5447 | 2026-09-19T11:32:07Z |
| 28 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/patch_workflow-id | 200 | 5267 | 2026-09-19T11:32:08Z |
| 29 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/delete_workflow-id | 200 | 629 | 2026-09-19T11:32:08Z |
| 30 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/post_workflow-id-activate | 200 | 600 | 2026-09-19T11:32:09Z |
| 31 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/post_workflow-id-deactivate | 200 | 606 | 2026-09-19T11:32:09Z |
| 32 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/post_workflow-id-execute | 200 | 804 | 2026-09-19T11:32:10Z |
| 33 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/patch_workflow-id-name | 200 | 795 | 2026-09-19T11:32:10Z |
| 34 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/post_workflow-upload-config | 200 | 740 | 2026-09-19T11:32:11Z |
| 35 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/createchatsession | 200 | 3623 | 2026-09-19T11:32:11Z |
| 36 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/getchatsessions | 200 | 4436 | 2026-09-19T11:32:12Z |
| 37 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/getchatsession | 200 | 3031 | 2026-09-19T11:32:12Z |
| 38 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/getchatmessages | 200 | 6990 | 2026-09-19T11:32:13Z |
| 39 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/getchatmessage | 200 | 5589 | 2026-09-19T11:32:13Z |
| 40 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/submitquery | 200 | 6196 | 2026-09-19T11:32:14Z |
| 41 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/updatelivesessionsettings | 200 | 2993 | 2026-09-19T11:32:14Z |

### 4.2 Public documentation site (unauthenticated)

| # | URL | HTTP status | Content-type | Bytes | UTC | Blocked | Bytes vs 2026-09-17 baseline |
|---|---|---|---|---|---|---|---|
| 1 | https://docs.on-demand.io/ | 200 | text/html | 203646 | 2026-09-19T11:32:17Z | False |  |
| 2 | https://docs.on-demand.io/llms.txt | 200 | text/plain | 9493 | 2026-09-19T11:32:18Z | False | same |
| 3 | https://docs.on-demand.io/llms-full.txt | 404 | text/html | 116089 | 2026-09-19T11:32:18Z | False |  |
| 4 | https://docs.on-demand.io/sitemap.xml | 404 | text/html | 0 | 2026-09-19T11:32:19Z | False |  |
| 5 | https://docs.on-demand.io/robots.txt | 200 | text/plain | 25 | 2026-09-19T11:32:19Z | False |  |
| 6 | https://docs.on-demand.io/api-reference | 404 | text/html | 116089 | 2026-09-19T11:32:20Z | False |  |
| 7 | https://docs.on-demand.io/api-reference/introduction | 404 | text/html | 116154 | 2026-09-19T11:32:20Z | False |  |
| 8 | https://api.on-demand.io/ | 404 | text/plain | 36 | 2026-09-19T11:32:21Z | False |  |
| 9 | https://api.on-demand.io/docs | 404 | text/plain | 36 | 2026-09-19T11:32:21Z | False |  |
| 10 | https://api.on-demand.io/openapi.json | 404 | application/json | 36 | 2026-09-19T11:32:22Z | False |  |
| 11 | https://api.on-demand.io/swagger | 404 | text/plain | 36 | 2026-09-19T11:32:22Z | False |  |
| 12 | https://gateway.on-demand.io/ | 404 | text/plain | 36 | 2026-09-19T11:32:23Z | False |  |
| 13 | https://gateway.on-demand.io/config/v1/public/docs/categories | 401 | text/plain | 62 | 2026-09-19T11:32:23Z | False |  |
| 14 | https://app.on-demand.io/ | 200 | text/html | 8866 | 2026-09-19T11:32:24Z | False |  |
| 15 | https://docs.on-demand.io/docs/agent-skills.md | 200 | text/markdown | 13394 | 2026-09-19T11:32:24Z | False | same |
| 16 | https://docs.on-demand.io/docs/agent-skills.md.md | 404 | text/html | 116815 | 2026-09-19T11:32:25Z | False |  |
| 17 | https://docs.on-demand.io/docs/workflow-api.md | 200 | text/markdown | 12033 | 2026-09-19T11:34:36Z | False | same |
| 18 | https://docs.on-demand.io/docs/workflow-api | 200 | text/html | 224310 | 2026-09-19T11:32:26Z | False |  |
| 19 | https://docs.on-demand.io/docs/workflow-nodes.md | 200 | text/markdown | 7072 | 2026-09-19T11:32:27Z | False | same |
| 20 | https://docs.on-demand.io/docs/workflow-api.md.md | 404 | text/html | 116815 | 2026-09-19T11:32:27Z | False |  |
| 21 | https://docs.on-demand.io/docs/workflow-nodes.md.md | 404 | text/html | 116825 | 2026-09-19T11:32:28Z | False |  |
| 22 | https://docs.on-demand.io/docs/creating-a-workflow.md | 200 | text/markdown | 5256 | 2026-09-19T11:32:28Z | False | same |
| 23 | https://docs.on-demand.io/reference/get_workflow.md.md | 404 | text/html | 116857 | 2026-09-19T11:32:29Z | False |  |
| 24 | https://docs.on-demand.io/reference/get_workflow.md | 200 | text/markdown | 11778 | 2026-09-19T11:32:29Z | False | same |
| 25 | https://docs.on-demand.io/reference/post_workflow.md.md | 404 | text/html | 116862 | 2026-09-19T11:32:30Z | False |  |
| 26 | https://docs.on-demand.io/reference/post_workflow.md | 200 | text/markdown | 11222 | 2026-09-19T11:32:30Z | False | same |
| 27 | https://docs.on-demand.io/docs/creating-a-workflow.md.md | 404 | text/html | 116850 | 2026-09-19T11:32:31Z | False |  |
| 28 | https://docs.on-demand.io/reference/get_workflow-id.md.md | 429 | text/html | 21810 | 2026-09-19T11:32:31Z | True |  |
| 29 | https://docs.on-demand.io/docs/plugin-api.md | 200 | text/markdown | 5837 | 2026-09-19T11:34:22Z | False | same |
| 30 | https://docs.on-demand.io/docs/what-are-plugins.md | 200 | text/markdown | 5652 | 2026-09-19T11:34:24Z | False | same |
| 31 | https://docs.on-demand.io/docs/plugins.md | 200 | text/markdown | 4347 | 2026-09-19T11:34:26Z | False | same |
| 32 | https://docs.on-demand.io/docs/rest-based-plugins.md | 200 | text/markdown | 8993 | 2026-09-19T11:34:28Z | False | same |
| 33 | https://docs.on-demand.io/docs/rest-api-plugin-examples.md | 200 | text/markdown | 17607 | 2026-09-19T11:34:30Z | False | same |
| 34 | https://docs.on-demand.io/docs/open-api-schema.md | 200 | text/markdown | 16875 | 2026-09-19T11:34:32Z | False | same |
| 35 | https://docs.on-demand.io/docs/agents-flow-builder.md | 200 | text/markdown | 962 | 2026-09-19T11:34:34Z | False | same |
| 36 | https://docs.on-demand.io/reference/post_workflow-id-execute.md | 200 | text/markdown | 1814 | 2026-09-19T11:34:38Z | False | same |
| 37 | https://docs.on-demand.io/reference/post_workflow-id-activate.md | 200 | text/markdown | 1318 | 2026-09-19T11:34:40Z | False | same |
| 38 | https://docs.on-demand.io/reference/post_workflow-id-deactivate.md | 200 | text/markdown | 1326 | 2026-09-19T11:34:42Z | False | same |
| 39 | https://docs.on-demand.io/reference/patch_workflow-id.md | 200 | text/markdown | 11028 | 2026-09-19T11:34:44Z | False | same |
| 40 | https://docs.on-demand.io/reference/get_workflow-id.md | 200 | text/markdown | 11429 | 2026-09-19T11:34:46Z | False | same |
| 41 | https://docs.on-demand.io/reference/delete_workflow-id.md | 200 | text/markdown | 1382 | 2026-09-19T11:34:48Z | False | same |
| 42 | https://docs.on-demand.io/reference/patch_workflow-id-name.md | 200 | text/markdown | 1833 | 2026-09-19T11:34:50Z | False | same |
| 43 | https://docs.on-demand.io/reference/post_workflow-upload-config.md | 200 | text/markdown | 1629 | 2026-09-19T11:34:52Z | False | same |
| 44 | https://docs.on-demand.io/reference/get_execution-executionid-logs.md | 200 | text/markdown | 3805 | 2026-09-19T11:34:54Z | False | same |
| 45 | https://docs.on-demand.io/docs/execution-api.md | 200 | text/markdown | 8888 | 2026-09-19T11:34:56Z | False | same |
| 46 | https://docs.on-demand.io/docs/rules-to-publish-a-rest-api-plugin.md | 200 | text/markdown | 2618 | 2026-09-19T11:34:58Z | False | same |
| 47 | https://docs.on-demand.io/docs/knowledge-plugin.md | 200 | text/markdown | 13678 | 2026-09-19T11:35:00Z | False | same |
| 48 | https://docs.on-demand.io/docs/terminal-agent.md | 200 | text/markdown | 23976 | 2026-09-19T11:35:02Z | False | same |
| 49 | https://docs.on-demand.io/docs/what-are-connectors.md | 200 | text/markdown | 3112 | 2026-09-19T11:35:04Z | False | same |
| 50 | https://docs.on-demand.io/docs/chat-api.md | 200 | text/markdown | 16084 | 2026-09-19T11:35:06Z | False | same |
| 51 | https://docs.on-demand.io/docs/getting-started.md | 200 | text/markdown | 7476 | 2026-09-19T11:35:08Z | False | same |
| 52 | https://docs.on-demand.io/docs/authentication.md | 200 | text/markdown | 4795 | 2026-09-19T11:35:10Z | False | same |
| 53 | https://docs.on-demand.io/reference/intro-to-ondemand-api.md | 200 | text/markdown | 2957 | 2026-09-19T11:35:12Z | False | same |
| 54 | https://docs.on-demand.io/reference/how-to-do-authentication.md | 200 | text/markdown | 1872 | 2026-09-19T11:35:14Z | False | same |
| 55 | https://docs.on-demand.io/docs/chat-wokflow.md | 200 | text/markdown | 3587 | 2026-09-19T11:35:16Z | False | same |
| 56 | https://docs.on-demand.io/docs/mqttiot-plugins.md | 200 | text/markdown | 11722 | 2026-09-19T11:35:18Z | False | same |
| 57 | https://docs.on-demand.io/reference/createchatsession.md | 200 | text/markdown | 6326 | 2026-09-19T11:35:20Z | False | same |
| 58 | https://docs.on-demand.io/reference/submitquery.md | 200 | text/markdown | 10816 | 2026-09-19T11:35:22Z | False | same |
| 59 | https://docs.on-demand.io/docs/general-faqs.md | 200 | text/markdown | 1261 | 2026-09-19T11:35:24Z | False | same |
| 60 | https://docs.on-demand.io/docs/what-is-playground.md | 200 | text/markdown | 7514 | 2026-09-19T11:35:26Z | False | same |
| 61 | https://docs.on-demand.io/reference/get_execution-executionid.md | 200 | text/markdown | 4215 | 2026-09-19T11:35:28Z | False | same |
| 62 | https://docs.on-demand.io/docs/mcp.md | 404 | text/html | 116755 | 2026-09-19T11:35:30Z | False |  |
| 63 | https://docs.on-demand.io/docs/mcp-server.md | 404 | text/html | 116790 | 2026-09-19T11:35:32Z | False |  |

Notes: the `.md.md` rows are a first-pass URL-construction slip (llms.txt links already end in `.md`) and are listed for completeness; the two 429 rows are ReadMe rate-limit pages (body contains `challenge-platform`), not Cloudflare bot challenges — the crawl slowed to 1 request / 2 s and every page then answered 200.

### 4.3 MCP server calls — see §3 (initialize / tools/list / tools/call rows).

### 4.4 Labelled probes — UNDOCUMENTED endpoints (observations only; not documentation)

| # | Label | Method | URL | HTTP status | UTC | Body excerpt |
|---|---|---|---|---|---|---|
| 1 | plugin create (mcp-tool-name-derived) | POST | `https://api.on-demand.io/plugin/v1/plugin` | 404 | 2026-09-19T11:37:43.915Z | `Not Found` |
| 2 | plugin create (plural) | POST | `https://api.on-demand.io/plugin/v1/plugins` | 404 | 2026-09-19T11:37:44.464Z | `Not Found` |
| 3 | plugin create (/create) | POST | `https://api.on-demand.io/plugin/v1/create` | 404 | 2026-09-19T11:37:45.000Z | `Not Found` |
| 4 | plugin create (root) | POST | `https://api.on-demand.io/plugin/v1` | 500 | 2026-09-19T11:37:45.536Z | `` |
| 5 | plugins (bare) | POST | `https://api.on-demand.io/plugins` | 404 | 2026-09-19T11:37:45.983Z | `{"error_msg":"404 Route Not Found"} ` |
| 6 | agents (bare) | POST | `https://api.on-demand.io/agents` | 404 | 2026-09-19T11:37:46.363Z | `{"error_msg":"404 Route Not Found"} ` |
| 7 | chat agents | POST | `https://api.on-demand.io/chat/v1/agents` | 404 | 2026-09-19T11:37:46.718Z | `{"message":"Route not found","errorCode":"not_found"}` |
| 8 | skills (bare) | POST | `https://api.on-demand.io/skills` | 404 | 2026-09-19T11:37:47.473Z | `{"error_msg":"404 Route Not Found"} ` |
| 9 | skills v1 | POST | `https://api.on-demand.io/skills/v1/skills` | 404 | 2026-09-19T11:37:47.870Z | `{"error_msg":"404 Route Not Found"} ` |
| 10 | skill under plugin svc | POST | `https://api.on-demand.io/plugin/v1/skills` | 404 | 2026-09-19T11:37:48.244Z | `Not Found` |
| 11 | skills under automation | POST | `https://api.on-demand.io/automation/api/skills` | 404 | 2026-09-19T11:37:48.743Z | `Not Found` |
| 12 | skills list (bare) | GET | `https://api.on-demand.io/skills` | 404 | 2026-09-19T11:37:49.183Z | `{"error_msg":"404 Route Not Found"} ` |
| 13 | skills list under plugin svc | GET | `https://api.on-demand.io/plugin/v1/skills` | 400 | 2026-09-19T11:37:49.565Z | `{"message":"Agent plugin not found","errorCode":"invalid_request"}` |
| 14 | agent tools list (documented guide-only) | GET | `https://api.on-demand.io/plugin/v1/list?page=1&limit=5` | 200 | 2026-09-19T11:37:50.022Z | `{"message":"Agent fetched successfully","page":1,"limit":5,"data":{"total":0}}` |
| 15 | plugin config create (mcp-tool-name-derived) | POST | `https://api.on-demand.io/plugin/v1/plugin-configuration` | 404 | 2026-09-19T11:37:50.479Z | `Not Found` |
| 16 | ai-generated tool (mcp-tool-name-derived) | POST | `https://api.on-demand.io/public/v1/plugin/ai-generated-tool` | 404 | 2026-09-19T11:37:51.008Z | `{"error_msg":"404 Route Not Found"} ` |
| 17 | suggest plugins (mcp-tool-name-derived) | GET | `https://api.on-demand.io/public/v1/suggest-plugins?query=earthquake` | 404 | 2026-09-19T11:37:51.361Z | `{"error_msg":"404 Route Not Found"} ` |
| 18 | plugin create diagnostic: empty body | POST | `https://api.on-demand.io/plugin/v1` | 400 | 2026-09-19T11:38:31.851Z | `{"message":"Key: 'CreatePluginRequest.Name' Error:Field validation for 'Name' failed on the 'required' tag\nKey: 'CreatePluginRequest.Identi` |
| 19 | plugin create diagnostic: name only | POST | `https://api.on-demand.io/plugin/v1` | 400 | 2026-09-19T11:38:32.082Z | `{"message":"Key: 'CreatePluginRequest.Identifier' Error:Field validation for 'Identifier' failed on the 'required' tag\nKey: 'CreatePluginRe` |

Reading of the probes: `POST /plugin/v1` is the REST operation behind MCP `plugin_v1_plugin_create` (Go validator names `CreatePluginRequest.{Name,Identifier,Description,LogoUrl,Type,Source,Category}`); with a complete body — and even with a deliberately invalid `identifier` — it returns **500 with an empty body**, which the MCP wrapper surfaces as `isError:true` with empty text. No `/plugins`, `/agents`, `/skills` route exists (`404 Route Not Found`); the MCP-derived REST paths for `plugin-configuration`, `ai-generated-tool` and `suggest-plugins` are not exposed on `api.on-demand.io` (404) — those operations are MCP-only.

## 5. Method notes

- Docs API: Python `requests`, `apikey` header from the runtime env (never printed), browser User-Agent (a plain UA is refused by Cloudflare 1010).
- Site crawl: unauthenticated HTTP fetches of the markdown page variants (no browser session was needed; no page presented a bot challenge — only ReadMe rate limits).
- MCP: a minimal streamable-HTTP JSON-RPC client (`initialize` → `notifications/initialized` → `tools/list` with cursor pagination → `tools/call`), `Mcp-Session-Id` echoed when present; the apikey travels only in the query string of the configured URL and is masked in every artefact.
- Anti-loop discipline: the plugin-create call was stopped after six distinct variants (the two error classes seen were *schema-must-be-string* and *empty error*); no retries beyond that, no deletions, and the account was verified to hold zero plugins afterwards.
