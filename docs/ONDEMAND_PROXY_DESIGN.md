# OnDemand Serverless Proxy — Design Notes

| Field                                         | Value                                                                                                                                                                                                                       |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generated (UTC)                               | 2026-09-17T06:48:16Z                                                                                                                                                                                                        |
| Author                                        | Subagent S3 ("OnDemand proxy functions")                                                                                                                                                                                    |
| Audited commit (repo HEAD at time of writing) | `0d41b6be5490db1f10a171f238be75db4d4ec3b4`                                                                                                                                                                                  |
| Single source of truth for wire contract      | `docs/ONDEMAND_API_CURRENT.md` (generated 2026-09-17T06:14:03Z) — every field, URL, header and status code below cites a section of that document; nothing here should be treated as authoritative if it disagrees with it. |
| Scope                                         | `api/ondemand/{sessions,chat,media,stt,tts,workflow,health}.js` and their shared helpers under `server/ondemand/`.                                                                                                          |
| Explicitly out of scope                       | `api/[...route].js`, `server/serverless/**`, `vercel.json`, the local dev emulator, the client (`src/**`) — owned by sibling subagents in this same workstream.                                                             |

This document assumes the reader has `docs/ONDEMAND_API_CURRENT.md` open; it does not restate the wire contract, only how this proxy maps onto it.

---

## 1. Endpoint table — local route → upstream → contract § → notes

| Local route                                                   | Upstream method + URL                                                                                                 | Contract §       | Notes                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /api/ondemand/sessions`                                 | `POST {chat}/sessions` (skipped when `reuse` finds a local hit)                                                       | §2.1             | Body `{externalUserId, pluginIds}`. Sends `pluginIds` (OpenAPI name), not `agentIds` (guide-sample name) — see §5 "naming drift" below.                                                                                                                |
| `GET /api/ondemand/sessions?userId=`                          | _(none — local store lookup only)_                                                                                    | §2.4 area        | Never calls upstream `GET {chat}/sessions/{id}`; this is a local `externalUserId -> sessionId` lookup, not a session-details fetch.                                                                                                                    |
| `DELETE /api/ondemand/sessions?userId=`                       | _(none)_                                                                                                              | §2.4             | Upstream delete-session is **NOT FOUND IN LIVE DOCS**; only the local mapping is removed. Response says so explicitly.                                                                                                                                 |
| `POST /api/ondemand/chat` (`responseMode: 'sync'`)            | `POST {chat}/sessions/{sessionId}/query`                                                                              | §3.1, §3.2       | Forwards the upstream JSON verbatim with the upstream status code.                                                                                                                                                                                     |
| `POST /api/ondemand/chat` (`responseMode: 'stream'`)          | `POST {chat}/sessions/{sessionId}/query`                                                                              | §3.1, §3.4, §4   | SSE bytes piped verbatim via `server/ondemand/sse.js`; upstream fetch aborted on client disconnect.                                                                                                                                                    |
| `POST /api/ondemand/chat` (`responseMode: 'webhook'`)         | _(never called)_                                                                                                      | §3.3             | 501 — payload schema/signature **NOT FOUND IN LIVE DOCS**.                                                                                                                                                                                             |
| `POST /api/ondemand/media` (JSON body)                        | `POST {media}`                                                                                                        | §5.1             | Create-from-URL.                                                                                                                                                                                                                                       |
| `POST /api/ondemand/media` (`multipart/form-data`)            | `POST {media}/raw`                                                                                                    | §5.2             | Raw bytes forwarded verbatim with the original `Content-Type` (boundary intact) — never re-encoded.                                                                                                                                                    |
| `GET /api/ondemand/media`                                     | `GET {media}`                                                                                                         | §5.3             | Only the documented query params (`page,limit,sort,plugins,externalUserId,source`) are forwarded.                                                                                                                                                      |
| `DELETE /api/ondemand/media?fileId=`                          | `DELETE {media}/{fileId}`                                                                                             | §5.4             |                                                                                                                                                                                                                                                        |
| `POST /api/ondemand/stt`                                      | `POST {services}/execute/speech_to_text`                                                                              | §6.1             | Body is exactly `{audioUrl}`. Multipart or inline-base64 audio -> 501 (no upload-bytes variant is documented).                                                                                                                                         |
| `POST /api/ondemand/tts`                                      | `POST {services}/execute/text_to_speech`                                                                              | §6.2             | `?format=json` returns the JSON envelope; default / `?format=audio` / `Accept: audio/*` re-fetches `data.audioUrl` server-side and streams the bytes back.                                                                                             |
| `POST /api/ondemand/workflow?action=execute`                  | `POST {automation}/workflow/{id}/execute`                                                                             | §7.1             | **No request body is sent** — the spec defines none. A client-supplied `input`/`payload` field -> 501.                                                                                                                                                 |
| `POST /api/ondemand/workflow?action=activate\|deactivate`     | `POST {automation}/workflow/{id}/activate` or `.../deactivate`                                                        | §7.1             | No body.                                                                                                                                                                                                                                               |
| `GET /api/ondemand/workflow?action=status&executionId=`       | `GET {automation}/execution/{executionID}`                                                                            | §7.1             |                                                                                                                                                                                                                                                        |
| `GET /api/ondemand/workflow?action=logs&executionId=`         | `GET {automation}/execution/{executionID}/logs`                                                                       | §7.1             | Polling only — see §3 below.                                                                                                                                                                                                                           |
| `GET /api/ondemand/workflow?action=outputs&executionId=`      | `GET {automation}/execution/{executionID}/node/outputs`                                                               | §7.1             |                                                                                                                                                                                                                                                        |
| `GET /api/ondemand/workflow?action=list&workflowId=&afterId=` | `GET {automation}/execution/list?workflowID=&afterID=`                                                                | §7.1             |                                                                                                                                                                                                                                                        |
| `?action=stream-logs` (either verb)                           | _(never called)_                                                                                                      | §7.1             | 501 — no streaming-logs endpoint is documented; only the polling `.../logs` exists.                                                                                                                                                                    |
| `GET`/`HEAD /api/ondemand/health`                             | `GET {chat}/sessions?limit=1`, `GET {media}?page=1&limit=1`, `GET {automation}/workflow/?limit=1` (parallel, 5s each) | §2.2, §5.3, §7.1 | Always 200. No call at all when `ONDEMAND_API_KEY` is unset. Services (STT/TTS) has no read-only probe (§6) — never called; reported `degraded`/`not configured`. `GET /plugin/v1/list` (§8, guide-only) is deliberately **not** called; see §6 below. |

---

## 2. Statelessness note + pluggable store hook

`server/ondemand/sessions-store.js` is an in-memory `Map<externalUserId, {sessionId, createdAt, lastUsedAt}>`, LRU-capped at 500 entries, memoised on `globalThis` so warm invocations of the _same_ function instance reuse one Map.

**This does not survive across instances.** Vercel may run any number of concurrent/serial instances of each function; a cold start always begins with an empty Map; instance A creating a session for `userId=42` gives instance B no way to see it. In practice this means: under light traffic, session reuse mostly "just works" because Vercel tends to route a given client to a warm instance; under load or after a deploy, some fraction of "reuse" requests will silently fall through to creating a brand-new upstream session. This is a correctness/cost tradeoff being accepted for this task's scope, not a bug — the alternative is a durable external store, which is out of scope here.

The module exports a narrow, swappable shape:

```js
{
  (get(userId), set(userId, rec), delete userId, size());
}
```

`createStore(maxEntries)` builds the in-memory adapter; `getStore()` memoises exactly one instance on `globalThis`. A **durable adapter** (Vercel KV, Upstash Redis, or a row in whatever SQL store the rest of the app eventually adopts) can implement the same four methods and be swapped in behind `getStore()` — selected by an env var such as `ONDEMAND_SESSION_STORE=kv` — without touching `session-service.js` or any `api/ondemand/*.js` caller. **Only the in-memory adapter is implemented in this task.**

---

## 3. Not implemented — absent from the live docs

Every one of these was checked against `docs/ONDEMAND_API_CURRENT.md` and returns HTTP 501 `{error:'not documented', surface, reference}` from the relevant handler instead of a guessed schema:

| Surface                                   | Contract § | Handler                                            | Why not guessed                                                                                                                                                                                                                                                                  |
| ----------------------------------------- | ---------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Webhook payload schema + signature header | §3.3       | `chat.js` (`responseMode:'webhook'`)               | "payload schema and signature header are NOT FOUND IN LIVE DOCS" — inventing a signature scheme would be actively unsafe (unverifiable webhooks).                                                                                                                                |
| Delete session                            | §2.4       | `sessions.js` (`DELETE`)                           | No delete-session operation exists in the categories index, `llms.txt`, or the Chat API guide. Only project deletion cascades session deletion, and Projects are out of scope.                                                                                                   |
| STT upload-bytes / streaming              | §6.1       | `stt.js`                                           | The documented body has exactly one field (`audioUrl`); no multipart or base64 variant, no partial/streaming transcripts.                                                                                                                                                        |
| TTS streaming synthesis                   | §6.2       | `tts.js`                                           | Output is always a hosted URL; no streaming-audio mode is documented. `tts.js` therefore always pays "full synthesis + a second download" latency.                                                                                                                               |
| Workflow log streaming                    | §7.1       | `workflow.js` (`?action=stream-logs`)              | Only the polling `GET .../logs` endpoint exists; 0 hits for a streaming-logs endpoint anywhere in the fetched docs.                                                                                                                                                              |
| Workflow versioning                       | §7.3       | `workflow.js` (nowhere — see §5 below)             | No version field on the workflow object anywhere in the docs. `GODS_EYE_FLOW_VERSION` is dropped entirely rather than sent as a guessed field.                                                                                                                                   |
| Workflow execute request body             | §7.1       | `workflow.js` (`?action=execute`)                  | "no request body is defined in the spec" — a client-supplied `input`/`payload` is refused with 501 rather than silently forwarded (which upstream would likely ignore, masking a client bug) or silently dropped (which would surprise the caller).                              |
| REST API key management                   | §10        | _(no handler — key management was never in scope)_ | Keys are dashboard-only; 0 hits for a key-management endpoint in the docs.                                                                                                                                                                                                       |
| Skills API (create/attach/invoke)         | §9         | _(no handler)_                                     | Skills are a dashboard/marketplace concept with no documented REST surface.                                                                                                                                                                                                      |
| Native realtime voice (WebSocket/WebRTC)  | §14        | _(no handler)_                                     | 0 occurrences of `websocket`/`wss://` anywhere in the fetched docs; the only voice capability is the workflow `advancedVoiceMode` node (outbound phone calls), which is a different product from a developer audio-stream API and is out of scope for this task's endpoint list. |

Additionally, **`GET /plugin/v1/list`** (§8) is guide-only — "This operation is not in the OpenAPI reference set" — so `health.js` does not call it; a configured `ONDEMAND_SPATIAL_AGENT_ID` is reported as `'not probed'` rather than actually probed. This is a deliberate simplicity/safety choice (a guide-only endpoint with no OpenAPI spec is a worse foundation for an automated health check than simply not calling it), recorded here per the task's request rather than silently decided.

---

## 4. Documented divergences taken deliberately (not gaps — explicit choices)

- **`pluginIds` vs `agentIds`** (§2.1, §3.1, §13): the OpenAPI schemas and this proxy's own response objects use `pluginIds`; several guide code samples show the identical array as `agentIds`. This proxy sends `pluginIds` everywhere (the schema name) and documents the drift in a code comment at every call site (`session-service.js`, `chat.js`).
- **`responseMode` default** (§3.1): the OpenAPI schema marks it `required` with no default; the guide claims a default of `sync`. `chat.js` defaults the _local_ request to `'stream'` when omitted (a UX choice for this task, not a claim about upstream's own default) and always sends the field explicitly upstream, sidestepping the documented contradiction entirely.
- **Media `responseMode` default** (§5.1): the schema marks it required with no documented default. `media.js` defaults to `'sync'` only when the client omits the field, and says so in a code comment — this is this proxy's choice, not a documented upstream default.
- **`reasoningMode` gating** (§3.1/§12): guide-only, stream-only field. `chat.js` accepts it in the request body but only forwards it upstream when `responseMode === 'stream'`, silently dropping it on `sync` rather than sending a field the docs never show on a sync call.
- **`ondemand` roll-up field in `/api/ondemand/health`**: the contract defines no such aggregate. This proxy's own rule (stated in a code comment in `health.js`): `'healthy'` iff the chat probe is healthy; otherwise the worst status among `{chat, media, workflow, speech}` (severity `error > degraded > healthy`) — chat's own bad status is included in that worst-of set so a broken chat probe can never be hidden behind two healthy probes.

---

## 5. Dropped env vars and why

| Variable                                                                               | Source                   | Disposition                                             | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ONDEMAND_REASONING_ENDPOINT_ID`                                                       | Task's candidate list    | **DROPPED**                                             | The docs have no "reasoning endpoint" concept — `reasoningMode` is a free string (§3.1/§12), not an endpoint id. Keeping a variable named like an id for a non-id concept would mislead future readers. If a reasoning knob is wanted, `ONDEMAND_REASONING_MODE` (a string, passed as `reasoningMode` on stream queries only) is the one actually backed by the guide — kept, and clearly labeled "guide-only" in `config.js` and `.env.example`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `GODS_EYE_FLOW_VERSION`                                                                | Task's candidate list    | **DROPPED**                                             | Workflow versioning is **NOT FOUND IN LIVE DOCS** (§7.3) — no version field exists on the workflow object anywhere in the fetched docs. `workflow.js` never reads this variable under any name.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `ONDEMAND_DEFAULT_MODEL`                                                               | FalKonEye blueprint §7.2 | **RENAMED**, not dropped                                | This task's candidate list already renames it `ONDEMAND_FULFILLMENT_ENDPOINT_ID`; same concept (`endpointId` default for chat), kept under the new name.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `ONDEMAND_PLUGIN_IDS` (comma-separated list)                                           | FalKonEye blueprint §7.2 | **REPLACED** by `ONDEMAND_SPATIAL_AGENT_ID` (single id) | The task's candidate list narrows the default to one agent id rather than a list. A future multi-id default would need a new variable and a comma-split parser; not built here since it wasn't asked for.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `ONDEMAND_WORKFLOW_ID`                                                                 | FalKonEye blueprint §7.2 | **REPLACED** by `ONDEMAND_SPATIAL_FLOW_ID`              | Same concept, renamed per this task's candidate list.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `ONDEMAND_COMPANY_ID`                                                                  | FalKonEye blueprint §7.2 | **DROPPED**                                             | The blueprint scoped this to the Projects API (`x-company-id` "required only by `/chat/v1/public/*`" — blueprint's own words). Projects are not part of this task's endpoint list; nothing here ever needs a company id (it is derived server-side from the API key on every documented call this proxy makes).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `ONDEMAND_MAX_CONCURRENCY`, `ONDEMAND_RAG_RATE_PER_MIN`, `ONDEMAND_DAILY_TOKEN_BUDGET` | FalKonEye blueprint §7.8 | **DROPPED — follow-up needed**                          | These are process-local limiter configs. The blueprint's own §7.8 caveat says it plainly: "all of these counters are module-level JavaScript state... with _N_ instances the real ceiling becomes *N*× [the configured rate] while OnDemand enforces one account-wide limit." On Vercel, N is elastic and unbounded by this codebase, so a per-instance counter is worse than useless here — it would look like protection while providing none. Implementing it properly needs a shared store (the same durable-store follow-up as §2 above); tracked as future work, not built.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `ONDEMAND_PROXY_SHARED_SECRET`                                                         | FalKonEye blueprint §7.2 | **DEFERRED — risk accepted with a mitigation**          | The blueprint made this **required** as an interim auth gate on `/api/ondemand/*`. This task's brief does not ask for shared-secret auth, and there is no UI/client work in scope to mint or send such a secret. **Risk, stated plainly:** every `/api/ondemand/*` route is reachable by anyone who can reach this deployment's origin, gated only by whatever network/auth boundary sits in front of the whole app (there is none documented for this repo beyond same-origin browsing). **Mitigation implemented instead:** a cheap same-origin (CSRF) guard in `server/ondemand/http.js` (`isSameOrigin` / `rejectCrossOrigin`), applied by every handler: when a request carries an `Origin` or `Referer` header, its host must match the request's `Host` header, or the request is rejected with 403. This stops a third-party website from driving a logged-in user's browser into spending this deployment's OnDemand quota via a cross-site request; it does **not** stop a direct `curl`/script hit (no Origin/Referer sent = allowed through, since there's nothing to compare). A real fix (the shared secret, or better, real user auth) is future work. |

---

## 5b. Accepted env-var aliases (added 2026-09-17 for the ondemand-eand-spatial Vercel project)

The real Vercel project this branch deploys to (`ondemand-eand-spatial`, team `schoolhack-web-team`) was independently provisioned with a few env var NAMES that do not match this proxy's canonical names, but denote the same concept. Rather than rename the project's variables, `server/ondemand/config.js` now accepts each project name as a documented fallback, canonical-first, read once at module load exactly like every other setting here. An env var explicitly set to `""`/whitespace counts as unset at every step below.

**Precedence implemented:**

| Logical setting          | Canonical (tried first)            | Alias (fallback)                | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------ | ---------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API root host            | `ONDEMAND_BASE_URL`                | `ONDEMAND_API_BASE`             | Trimmed, trailing slash(es) stripped; if the value carries a full endpoint path (e.g. ends `/chat/v1`) that one known API-family segment — `/chat/v1`, `/media/v1/public/file`, `/services/v1/public/service`, `/automation/api` — is stripped defensively too. Default `https://api.on-demand.io` if neither is set.                                                                                                                                                                                                        |
| Fulfillment `endpointId` | `ONDEMAND_FULFILLMENT_ENDPOINT_ID` | `ONDEMAND_ENDPOINT_ID`          | No hardcoded model-id fallback (§12: predefined list is volatile) — empty when neither is set, and every `/api/ondemand/chat` call must then supply its own `endpointId` or get 400 `endpointId_required`.                                                                                                                                                                                                                                                                                                                   |
| Default `pluginIds`      | `ONDEMAND_SPATIAL_AGENT_ID`        | `ONDEMAND_KNOWLEDGE_PLUGIN_IDS` | Alias value is comma/whitespace-split, trimmed, de-duplicated, capped at 20 (contract §2.1 `pluginIds` `maxItems`). The single-id export `config.spatialAgentId` is kept as `defaultPluginIds[0]` so `api/ondemand/health.js`'s `plugins` map keeps working unchanged; `server/ondemand/session-service.js` now defaults `pluginIds` from the **full** list (`config.defaultPluginIds`) instead of a 1-element array — a caller-supplied non-empty `pluginIds` in the request body still overrides the env default entirely. |
| Default workflow id      | `ONDEMAND_SPATIAL_FLOW_ID`         | _(none)_                        | No equivalent variable exists on the project under any name; `workflow.js` execute/activate/deactivate need an explicit `workflowId` in the request body when this is unset. Health is unaffected either way.                                                                                                                                                                                                                                                                                                                |

`configSources()` (exported from `config.js`) returns, per logical setting, which env NAME actually supplied it — `'ONDEMAND_ENDPOINT_ID'`, `'default'`, `'unset'`, etc. — **names only, never values**.

**Reconciliation table** (every canonical name the code reads, cross-referenced against what is actually configured on `ondemand-eand-spatial`):

| Code reads                                                              | Present on project?                          | Consequence if absent                                                                                                                                 | Action                                                                                                 |
| ----------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `ONDEMAND_API_KEY`                                                      | ✔ production, preview, development           | —                                                                                                                                                     | none                                                                                                   |
| `ONDEMAND_BASE_URL`                                                     | ✔ production, preview only (not development) | dev target falls back to the hardcoded default host                                                                                                   | none required; `ONDEMAND_API_BASE` (present on the project, same concept) accepted as alias regardless |
| `ONDEMAND_SPATIAL_AGENT_ID`                                             | ✘                                            | no default `pluginIds`; health `plugins` map stays empty                                                                                              | alias → `ONDEMAND_KNOWLEDGE_PLUGIN_IDS` (✔ present)                                                    |
| `ONDEMAND_SPATIAL_FLOW_ID`                                              | ✘, no equivalent anywhere on the project     | workflow execute/activate/deactivate need an explicit `workflowId`; health unaffected                                                                 | none possible — no alias exists                                                                        |
| `ONDEMAND_FULFILLMENT_ENDPOINT_ID`                                      | ✘                                            | every `/api/ondemand/chat` call omitting `endpointId` → 400 `endpointId_required`                                                                     | alias → `ONDEMAND_ENDPOINT_ID` (✔ present)                                                             |
| `ONDEMAND_REASONING_MODE`                                               | ✔                                            | —                                                                                                                                                     | none                                                                                                   |
| `ONDEMAND_REQUEST_TIMEOUT_MS`                                           | ✘                                            | optional; default 60000ms used                                                                                                                        | none needed                                                                                            |
| `SERVERLESS_MODE` (read by `server/serverless/app.js`, not `config.js`) | ✘                                            | `resolveServerlessMode()` also checks `Boolean(process.env.VERCEL)`; Vercel sets `VERCEL=1` automatically, so server-side serverless mode is still on | none needed                                                                                            |

And the reverse — `ONDEMAND_*`/`VITE_*` names present on the project that the code does _not_ read under that name:

| Present on project                                                                                                                                             | Maps to                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `ONDEMAND_API_BASE` (prod, preview)                                                                                                                            | `ONDEMAND_BASE_URL` — now an accepted alias                                                                                      |
| `ONDEMAND_ENDPOINT_ID`                                                                                                                                         | `ONDEMAND_FULFILLMENT_ENDPOINT_ID` — now an accepted alias                                                                       |
| `ONDEMAND_KNOWLEDGE_PLUGIN_IDS`                                                                                                                                | `ONDEMAND_SPATIAL_AGENT_ID` — now an accepted alias (comma-separated → list)                                                     |
| `VITE_SERVERLESS_MODE` (prod, preview only, not development)                                                                                                   | Client build-time flag / `server/serverless/app.js`'s `resolveServerlessMode()` — not an OnDemand-proxy setting, unaffected here |
| `ASK_THE_DEAL_ALLOWED_ORIGIN`, `ASK_ENABLED`, `CI`, `DOC_BUSINESS_PLAN_URL`, `DOC_BUSINESS_PLAN_PDF_URL`, `DOC_MOU_URL`, `DOC_GANTT_URL`, `ELEVENLABS_API_KEY` | Other subsystems — no `ONDEMAND_*`/`VITE_SERVERLESS_MODE` concept overlap, out of scope of this reconciliation                   |

**Debugging aid:** `GET /api/ondemand/health?envNames=1` adds `env: { names, sources }` to the JSON response — `names` is every `ONDEMAND_*`/`VITE_*`/`SERVERLESS_MODE`/`VERCEL`/`VERCEL_ENV` key currently present in `process.env` (sorted, names only) and `sources` is `configSources()`; no env var value is ever included, and the response shape is otherwise unchanged when the flag is absent.

---

## 6. FalKonEye blueprint (`falkoneye-ondemand-integration-architecture_v1.md`, session artifact dated 2026-08-29) — full divergence list

The earlier architecture document `falkoneye-ondemand-integration-architecture_v1.md` (supplied as an input artifact to this run; not copied into the repo to avoid duplicating its content) is a blueprint for a **different codebase** (FalKonEye: Express + TypeScript, `MemStorage`, Drizzle/Postgres on the roadmap). It was read for its OnDemand-specific analysis (§6, §7.1–7.2, §7.8–7.9) as prior art, not as an implementation to port. Divergences:

1. **Runtime shape.** Blueprint: routes registered inside a long-running Express app (`registerOnDemandRoutes(app)` in `server/routes.ts`), so module state (limiter counters, circuit breaker, idempotency map) survives for the process's lifetime. This repo: independent Vercel serverless functions under `api/ondemand/*.js`, each a cold-startable, horizontally-scaled, stateless-by-default unit. Every "the process keeps this in memory" design in the blueprint (rate limiter, circuit breaker, idempotency de-dupe map, daily token budget) does not transfer as-is — see the dropped-env-var table above.
2. **Session store.** Blueprint: `MemStorage` (the app's existing in-process key-value store) holds session mappings, consistent with the rest of that app's non-durable storage. This repo has no equivalent shared storage layer, so `server/ondemand/sessions-store.js` is a purpose-built `Map` on `globalThis`, memoised per function instance — same non-durability property, different reason (serverless cold starts, not "single Replit instance").
3. **Language/build.** Blueprint: TypeScript (`server/ondemand/*.ts`) compiled as part of the Express app's build. This repo's `package.json` is `"type":"module"` plain JS; every file here is `.js`/`.mjs` ESM with JSDoc types, no build step, matching the existing `server/providers/**` convention in this repo.
4. **Env vars adopted vs dropped:** see §5 above in full (`ONDEMAND_API_KEY`, `ONDEMAND_BASE_URL` kept under the same names; `ONDEMAND_DEFAULT_MODEL`→`ONDEMAND_FULFILLMENT_ENDPOINT_ID`, `ONDEMAND_PLUGIN_IDS`→`ONDEMAND_SPATIAL_AGENT_ID`, `ONDEMAND_WORKFLOW_ID`→`ONDEMAND_SPATIAL_FLOW_ID` renamed per this task's candidate list; `ONDEMAND_COMPANY_ID`, `ONDEMAND_MAX_CONCURRENCY`, `ONDEMAND_RAG_RATE_PER_MIN`, `ONDEMAND_DAILY_TOKEN_BUDGET`, `ONDEMAND_PROXY_SHARED_SECRET` dropped/deferred with reasons).
5. **Retry/backoff/circuit-breaker (blueprint §7.8).** Not implemented here at all. The blueprint's `classifyError`/`p-retry`/circuit-breaker stack is real engineering that this task did not ask for and that would need the same "shared state across instances" fix as the rate limiter before it could be correct on Vercel. Every upstream non-2xx here is surfaced to the caller immediately as `{error:'upstream_error', status, upstream}} — no automatic retries, no backoff. This is a straightforward capability gap versus the blueprint, tracked here rather than silently matched.
6. **Idempotency key (blueprint §7.8).** Not implemented. No `X-FalKon-Idempotency-Key`-equivalent header or short-lived de-dupe map exists in this proxy; a double-click or client retry against `/api/ondemand/chat` will submit two upstream queries. Same "needs shared state to do properly on serverless" reasoning as above.
7. **Streaming strategy (blueprint §7.9).** Adopted almost verbatim: `fetch()` + a byte-stream reader (not `EventSource`, which is GET-only), `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, `res.flushHeaders()`, abort propagation via `req.on('close')`/`res.on('close')`, a 15s downstream keepalive comment, `finally { res.end() }`. Two differences: (a) this proxy does **not** re-frame or reorder events by `eventIndex` — the task specification for this endpoint calls for byte-verbatim forwarding, so `eventIndex` reordering is left to the _client_, not done here (the blueprint's `stream.ts` reassembly logic was for FalKonEye's own consumer, not a proxy passthrough); (b) no idle-timeout-vs-heartbeat distinction is implemented — the upstream fetch has no fixed timeout while streaming (only the client-disconnect abort), matching this task's explicit instruction ("Wrap every upstream fetch with `AbortSignal.timeout(...)` **except the SSE stream**").
8. **`GET /api/ondemand/agents`.** The blueprint's route inventory (§7.3/§11.A) includes an agents-listing route backed by `GET /plugin/v1/list`. This task's endpoint list (`sessions`, `chat`, `media`, `stt`, `tts`, `workflow`, `health`) does not include an agents endpoint at all — **out of scope for this task**, not merely deferred. Flagged here as a documented-but-not-implemented follow-up, consistent with §8 of the contract doc marking that same endpoint "guide only" (not in the OpenAPI reference set) — the same caution that led `health.js` to skip calling it for a plugin-health probe applies to building a full route around it.
9. **Company/Projects scope.** The blueprint keeps `ONDEMAND_COMPANY_ID` for a future Projects-API integration point (§7.2 footnote: "Only for Projects API"). This task's endpoint list has no Projects surface, so the variable and everything it would configure are simply absent, not stubbed.

---

## 7. Security notes

- **Key handling.** `ONDEMAND_API_KEY` is read once per module load in `server/ondemand/config.js` (`process.env` only) and attached to every upstream request solely inside `server/ondemand/client.js#ondemandFetch`. No handler, test, or log line touches `process.env.ONDEMAND_API_KEY` directly. `server/ondemand/errors.js#redactKey()` exists for the one place a partial value might ever need to reach a log line (`***` + last 4 chars) — it is never applied to a client-facing response, because no client-facing response ever carries the key at all (redaction is a log-safety net, not a response-shaping step).
- **No key ever accepted from the client.** Every `apikey`-bearing request is built server-side; nothing in `api/ondemand/*.js` reads an incoming `apikey`/`Authorization` header from the client and forwards it upstream.
- **No other AI provider.** Nothing under `api/ondemand/**` or `server/ondemand/**` calls any endpoint outside the four documented OnDemand base URLs (`{base}/chat/v1`, `{base}/media/v1/public/file`, `{base}/services/v1/public/service`, `{base}/automation/api`) plus, in `tts.js` only, a direct fetch of the `data.audioUrl` OnDemand itself returned (necessary to stream the synthesized audio back — that URL is OnDemand's own storage, not a third-party provider). No OpenAI/Anthropic/etc. fallback exists anywhere, including in `health.js`, which reports `speech: 'degraded'` rather than ever placing a real call.
- **Same-origin (CSRF) guard.** See §5 above (`ONDEMAND_PROXY_SHARED_SECRET` row) — implemented in `server/ondemand/http.js` and applied by every one of the seven handlers as their first check.
- **Upstream error redaction.** `shapeUpstreamError()` caps forwarded upstream error bodies at 2 KB and never echoes request headers (so a hypothetical upstream that echoed a header back could not leak the key through this proxy's error path).
- **No secrets in `.env.example`.** Every OnDemand-related line appended there is a bare `NAME=` with a comment; no example/placeholder value resembling a real key is present.

---

## 8. Contract-test regeneration note

`scripts/ondemand-contract-test.mjs` was **regenerated from scratch**. At the start of this task, no file of that name (or any prior version of it) existed anywhere in this workspace — `find . -name 'ondemand-contract-test*'` before this task's changes returns nothing. The version now in the repo is new, written directly against `docs/ONDEMAND_API_CURRENT.md` (no memory of, or attempt to reproduce, a hypothetical earlier version).

---

## 9. How to run

```bash
# Unit tests (no network, no API key needed) — config, store, http, sse,
# errors, and stub-fetch smoke tests for every handler.
node --test server/ondemand/*.test.mjs

# Contract test self-check — prints the 10 planned upstream requests
# (method + URL + body field names) with no network call and no API key.
node scripts/ondemand-contract-test.mjs --dry-run

# Contract test for real, against the live OnDemand API (costs money on
# steps 8/9 — TTS/STT; set ONDEMAND_CONTRACT_SKIP_PAID=1 to skip them).
ONDEMAND_API_KEY=sk-... node scripts/ondemand-contract-test.mjs

# Local curl examples against the emulator (whatever dev server the sibling
# subagent's local emulator runs on — substitute its actual port):
curl -s http://localhost:5173/api/ondemand/health | jq .
curl -s -X POST http://localhost:5173/api/ondemand/sessions \
  -H 'Content-Type: application/json' -d '{"userId":"dev-user-1"}' | jq .
curl -s -N -X POST http://localhost:5173/api/ondemand/chat \
  -H 'Content-Type: application/json' \
  -d '{"userId":"dev-user-1","query":"Say hello in five words.","endpointId":"predefined-claude-sonnet-5","responseMode":"stream"}'
```

---

## 10. Environment name reconciliation (2026-09-18)

Extends §5b (2026-09-17) with the live-validation defaults from
`docs/ONDEMAND_API_CURRENT.md` §17 (2026-09-18) and a small deny-list.
`server/ondemand/config.js` remains the only file that reads any of these
names; every function under `api/ondemand/**` reaches it exclusively
through `api/ondemand/_config.js` (§ "Single config import point" below).

### 10.1 Precedence table (canonical → alias → default)

Every row: canonical name tried first, then the accepted alias (if any,
never a value — see `configSources()`), then a built-in default. An env var
explicitly set to `""`/whitespace counts as unset at every step.

| Setting                 | Canonical                             | Alias                  | Default (`source` reported as `'default'`)                       | Provenance of the default                                                                                                                                                                                                |
| ----------------------- | ------------------------------------- | ---------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `baseUrl`               | `ONDEMAND_BASE_URL`                   | `ONDEMAND_API_BASE`    | `https://api.on-demand.io`                                       | contract §1                                                                                                                                                                                                              |
| `reasoningEndpointId`   | `ONDEMAND_REASONING_ENDPOINT_ID`      | `ONDEMAND_ENDPOINT_ID` | `dynamic`                                                        | step-3 INVESTIGATE reasoning choice, §17.5 — reconciled for env-name/health purposes only: OnDemand has no separate "reasoning endpoint" concept (§12), so this value is never sent upstream by any handler in this task |
| `fulfillmentEndpointId` | `ONDEMAND_FULFILLMENT_ENDPOINT_ID`    | `ONDEMAND_ENDPOINT_ID` | `predefined-gpt-5.6-luna`                                        | step-3 INVESTIGATE fulfillment choice, verified live 2026-09-18 (§17.5); ids are volatile per §12                                                                                                                        |
| `reasoningMode`         | `ONDEMAND_REASONING_MODE` (validated) | —                      | `''` (unset) / `'dynamic'` (set but invalid — see §10.2)         | §17.5 documented default tier                                                                                                                                                                                            |
| `flowVersion`           | `GODS_EYE_FLOW_VERSION`               | —                      | `'0'`                                                            | informational only; workflow versioning is NOT FOUND IN LIVE DOCS (§7.3)                                                                                                                                                 |
| `spatialFlowId`         | `ONDEMAND_SPATIAL_FLOW_ID`            | —                      | `''` (no default — see §5b, no equivalent exists on the project) | —                                                                                                                                                                                                                        |
| `defaultPluginIds`      | `ONDEMAND_SPATIAL_AGENT_ID`           | — (denied, §10.3)      | `[]` (no default)                                                | —                                                                                                                                                                                                                        |
| `apiKey`                | `ONDEMAND_API_KEY`                    | —                      | `''` (no default)                                                | —                                                                                                                                                                                                                        |

Note the shared alias: `reasoningEndpointId` and `fulfillmentEndpointId`
both accept `ONDEMAND_ENDPOINT_ID` — if only that alias is set, both fields
resolve to the same value. This is intentional, not a bug: the API has one
concept (`endpointId`) doing fulfillment-model duty, and no separate
reasoning-endpoint concept at all, so the alias legitimately means the same
raw setting either way.

### 10.2 `reasoningMode` validation and `reasoningModeInvalid`

`ONDEMAND_REASONING_MODE` is validated against `DOCUMENTED_REASONING_MODES`
(one exported constant in `server/ondemand/config.js`, citing
`docs/ONDEMAND_API_CURRENT.md` §3.1/§12 for the guide examples — `low`,
`high`, `grok-4-fast` — and §17.4 for the live, undocumented
`GET /config/v1/public/reasoning_modes` predefined `modeId` values —
`dynamic, glm-4.7-flash, gemini-3-flash, grok-4-fast, gemini-3,
deepseek-v3.1, haiku, glm-5-turbo, minimax-m2, gpt-5.4, gpt-5.4-pro, opus,
kimi-k2`):

- **unset** → `reasoningMode = ''` (the field is omitted from the upstream
  request body entirely, not sent as an empty string) and
  `reasoningModeInvalid: false`.
- **set, in the list** → passed through unchanged, `reasoningModeInvalid:
false`, `source: 'ONDEMAND_REASONING_MODE'`.
- **set, NOT in the list** → replaced with `'dynamic'` (the documented
  default tier, §17.5 INVESTIGATE) rather than forwarded blind,
  `reasoningModeInvalid: true`, `source: 'default'` (the env var was read,
  but its value did not win — the default did).

`GET /api/ondemand/health` surfaces this two ways: a top-level
`reasoningModeInvalid: boolean`, and `config.reasoningMode.valid` inside
the per-setting `config` diagnostic block (§10.4) — both gated on nothing
else, so a typo'd tier id is visible even with no `ONDEMAND_API_KEY` set.

### 10.3 Deny-list and its rationale

Two env var NAMES are never read by `server/ondemand/config.js`, and must
never appear as a contiguous string literal anywhere under
`api/ondemand/**` or `server/ondemand/*.js` (non-test files):

- **`ONDEMAND_KNOWLEDGE_PLUGIN_IDS`** — the §5b alias for
  `ONDEMAND_SPATIAL_AGENT_ID` is retired. `defaultPluginIds` now comes ONLY
  from `ONDEMAND_SPATIAL_AGENT_ID` (comma/whitespace-split, capped at 20).
  Rationale: default plugin/agent ids are meant to come from the Gate-3
  spatial capability registry (the deployment's own configured spatial
  agent), not from an arbitrary externally-provisioned "knowledge plugin"
  list — collapsing the two concepts into one alias was a §5b
  interoperability convenience that this task retires in favour of a single
  source of truth.
- **`ELEVENLABS_API_KEY`** — rule 43: this proxy integrates exactly one AI
  provider (OnDemand). No secondary AI/voice provider credential is ever
  read or forwarded by anything under `api/ondemand/**` or
  `server/ondemand/**` — speech stays OnDemand's own Services API
  (`tts.js`/`stt.js`), reported `'degraded'` by health rather than ever
  falling back to a different provider.

**Enforcement:** `server/ondemand/deny-list.test.mjs` (a) recursively greps
every non-test `.js` source file under `api/ondemand/**` and
`server/ondemand/*.js` for both literal strings (built via string
concatenation inside the test itself, so the test file is never a
false-positive hit of its own scan), (b) sets both names to unique sentinel
values and asserts neither the sentinel values nor the names themselves
appear anywhere in `JSON.stringify(getConfig())` or
`JSON.stringify(configSources())`, and (c) asserts no `getConfig()` key
matches `/ELEVENLABS|KNOWLEDGE/`. `server/ondemand/config.js` itself also
carries a runtime tripwire (`getConfig()` throws if any of its own keys, or
`sources`' keys, ever literally equal a denied name) as a second,
independent line of defense. `GET /api/ondemand/health?envNames=1` applies
the same filter to `env.names` so the route cannot even confirm whether
either variable is set on the deployment.

### 10.4 Single config import point (`api/ondemand/_config.js`)

Every handler under `api/ondemand/**` (`chat.js`, `sessions.js`,
`media.js`, `stt.js`, `tts.js`, `workflow.js`, `health.js`) imports
configuration from `./_config.js`, never directly from
`../../server/ondemand/config.js`. `_config.js` is a one-line re-export
(`export * from '../../server/ondemand/config.js'`); the underscore prefix
matters because Vercel does not deploy `api/**/_*.js` files as their own
routable functions, so this file can live inside `api/ondemand/` — giving
every sibling a short `./_config.js` import — without Vercel ever trying to
build an `/api/ondemand/_config` route for it. One import path to change if
the config module ever moves; one file to read to see every name a handler
is allowed to pull in. `GET /api/ondemand/health` additionally exposes a
`config` object on every response (keyed or not) — `{ apiKey, baseUrl,
reasoningEndpointId, fulfillmentEndpointId, reasoningMode, flowVersion,
spatialFlowId }`, each `{ configured, source }` (`reasoningMode` also adds
`valid`) — so the reconciliation outcome for a live deployment is always
one health check away, without ever needing `?envNames=1`.

### 10.5 Selftest route (contract, implemented by a different task)

`GET /api/ondemand/selftest` is implemented outside this task (by
`api/ondemand/selftest.js`, using the 10-step baseline logic factored into
`server/ondemand/contract-steps.js`); this section records the contract it
is expected to satisfy, since `server/ondemand/config.js`'s
`ONDEMAND_SELFTEST_TOKEN` name and `getConfig()` shape (`apiKey, baseUrl,
fulfillmentEndpointId, spatialFlowId, defaultPluginIds`) exist specifically
to support it:

- **Auth:** the request must carry header `x-selftest-token` equal to
  `ONDEMAND_SELFTEST_TOKEN` (constant-time comparison — never a plain `===`
  on secret-bearing strings). No token configured, no header, or a
  mismatched header → **404** (not 401/403 — the route's very existence is
  not confirmed to an unauthenticated caller).
- **Rate limit:** **429** when invoked more than once per 60 seconds per
  warm instance (in-memory, process-local — the same caveat §5's
  `ONDEMAND_MAX_CONCURRENCY` row already documents applies: a fresh Vercel
  instance resets the counter).
- **Response:** the 10-step baseline JSON (the same shape as
  `docs/ONDEMAND_API_CURRENT.md` §17.2's contract run — session
  create/reuse, sync prompt, SSE stream, plugin probe, STT, TTS, media
  analysis, workflow, session-memory follow-up, latency summary), with the
  session id replaced by `sessionIdHash` (sha256 of the real session id,
  never the id itself) and no API key, header value, or other secret
  anywhere in the body.

---

## 11. Gate 3 — spatial capability rows

Gate 3 registers server-side, OnDemand-invocable "capabilities" — small,
deterministic REST adapters over public spatial data sources, tracked in
`src/registry/capabilities.json` and documented as OnDemand tool
definitions under `docs/ondemand-workflows/tools/*.json`. Row 1 below is
the first (and, as of this writing, only) row.

### Row 1 — earthquake.search (USGS FDSN Event)

- **Adapter module:** `server/sources/usgs-earthquakes.js` — deterministic,
  no LLM anywhere in the path. Talks to the USGS FDSN Event Web Service
  (`https://earthquake.usgs.gov/fdsnws/event/1/`), exposing both the
  `query` method (`USGS_QUERY_URL`) and the `count` method
  (`USGS_COUNT_URL`, selected by the local `mode:'count'` switch — `mode`
  is never itself forwarded upstream).

- **Params/caps (`ALLOWED_PARAMS`, frozen):** `starttime`, `endtime`
  (ISO-8601 UTC, `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM:SS(Z)`, hand-parsed so
  the result never depends on the host timezone), `minmagnitude` /
  `maxmagnitude` (`[-2, 10]`), `latitude` (`[-90, 90]`) / `longitude`
  (`[-180, 180]`) / `maxradiuskm` (`(0, 20001.6]`) as a circle search,
  `minlatitude`/`maxlatitude`/`minlongitude`/`maxlongitude` as a bounding
  box, `limit` (integer, default 100, silently clamped to 200 — USGS
  itself allows up to 20000, this deployment caps it), and `orderby`
  (`time` \| `time-asc` \| `magnitude` \| `magnitude-asc`, default `time`).
  Any other key is a 400 listing the unknown name(s). A circle
  (`latitude`+`longitude`+`maxradiuskm`, all three required together) and
  a bbox are mutually exclusive — supplying keys from both is a 400.
  `format=geojson` is added exactly once by `validateQuery()` itself, never
  by a caller.

- **Normalisation envelope.** Every returned event
  (`normalizeFeature()`) has the flat shape: `id, time_utc` (ISO, from
  `properties.time` ms), `magnitude` (`properties.mag`), `mag_type`
  (`properties.magType`), `depth_km` (`geometry.coordinates[2]`), `lat`
  (`coordinates[1]`), `lon` (`coordinates[0]`), `place, tsunami` (`0`\|`1`),
  `alert` (`properties.alert` or `null`), `url` (`properties.url`),
  `source:'USGS'`, `coverage:'observed'`, `retrieved_at_utc`. Every
  response also carries a `provenance` object: `source`, the exact request
  `url`, `generated` (ISO, from the GeoJSON `metadata.generated`), `api`,
  `title`, `retrieved_at_utc`, and a public-domain `license` note.

- **Error policy.** `AbortSignal.timeout(8000)` per attempt; a 5xx
  response or a network/timeout error is retried exactly once
  (`retries: 1`) — a timeout that exhausts its retry is
  `{ok:false, status:504, error:'usgs_timeout'}`, any other exhausted
  network error is `status:504, error:'usgs_unavailable'`, and an
  exhausted 5xx keeps USGS's own status with `error:'usgs_unavailable'`. A
  4xx is never retried: USGS answers a bad parameter combination with a
  plain-text 400/404 body, which is passed through as
  `{ok:false, status: <400 or 404, else normalised to 400>, error:'usgs_rejected', detail}`
  (`detail` capped to the body's first 200 characters — USGS error bodies
  are plain text, not JSON).

- **Route, and why it costs no extra function.**
  `server/serverless/earthquakes-route.js` exports
  `createEarthquakesHandler()`, a Connect-style `(req, res)` handler for
  GET/HEAD only (405 + `Allow` otherwise) that parses the query string,
  calls the adapter, and never throws (an unexpected error becomes a 502
  `{error:'sources_error'}`). `server/serverless/app.js` mounts it at
  `router.use('/api/sources/earthquakes', createEarthquakesHandler())`
  right before the provider-plugin loop, unconditionally (both standalone
  and serverless mode) — exactly like every `server/providers/**` plugin's
  own `middlewares.use(...)` call, just registered directly instead of via
  a plugin's `configureServer()`. Because every non-`api/ondemand/**`
  request already flows through the single catch-all function
  (`api/[...route].js` → `getServerlessApi().handle()`), adding this mount
  does not add a Vercel function: the deployed function count stays at 9.
  Success responses are cached at the edge/browser for 60s
  (`Cache-Control: public, max-age=60`); every error response is
  `no-store`.

- **Registry row** (`src/registry/capabilities.json`, verbatim):

  ```json
  {
    "id": "earthquake.search",
    "provider": "USGS FDSN Event",
    "route": "/api/sources/earthquakes",
    "ondemand_tool": "earthquake_search",
    "ondemand_tool_id": null,
    "coverage": "observed",
    "auth": "none",
    "persistent_connection": false,
    "status": "registered-unverified",
    "definition": "docs/ondemand-workflows/tools/earthquake_search.json",
    "notes": "REST agent creation is dashboard-only in the live OnDemand docs (§8); status becomes 'live' once the tool is created in the dashboard and the end-to-end query invokes it."
  }
  ```

- **OnDemand registration status:** **NOT FOUND IN LIVE DOCS** — per §8
  above, agent/tool creation and publishing are dashboard-only (My Agents →
  Create Agents; a REST API Agent is defined by importing an OpenAPI
  schema), and the public REST surface documents only
  `GET /plugin/v1/list`. No create/attach endpoint exists to invoke, so
  none was invented. The dashboard path recorded in both the tool
  definition and the registry row is: **REST API Agent**
  (`docs.on-demand.io/docs/rest-based-plugins.md`) — import
  `docs/ondemand-workflows/tools/earthquake_search.json`'s
  `openapi_fragment` as the agent's OpenAPI operation, which yields a real
  `ondemand_tool_id` (a `plugin-<digits>` id, per §8's documented shape)
  to fill in once it exists.

- **How the existing browser feed layer differs.** `src/layers/earthquakes/`
  (`source.js`) is unchanged by this row and stays exactly as it was: it
  polls USGS's rolling **summary** feed
  (`https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson`)
  directly from the client for the live globe view — no query parameters,
  always "the last 24 hours, everything". `server/sources/usgs-earthquakes.js`
  is a different upstream entirely: the **FDSN query API**, which accepts
  the time/magnitude/geographic filters above and is called server-side,
  through `/api/sources/earthquakes`, not from the browser. Neither
  duplicates the other's job.

- **Verification:** results are recorded in
  `docs/audit/gate3-row1-earthquake-verification.md` (placeholder — not
  yet populated by this task).
