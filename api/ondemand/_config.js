/**
 * api/ondemand/_config.js — the SINGLE config import point for every
 * function under api/ondemand/**.
 *
 * Why the underscore prefix: Vercel does not deploy `api/**\/_*.js` files as
 * routable functions (an underscore-prefixed file under `api/` is treated as
 * a private/shared module, not an endpoint) — see
 * https://vercel.com/docs/functions/serverless-functions/runtimes#project-structure.
 * That makes this the correct place for a re-export shim: it lives inside
 * `api/ondemand/` (so every sibling handler can import it with a short
 * relative path, `./_config.js`) without Vercel ever trying to build it into
 * its own `/api/ondemand/_config` route.
 *
 * Every handler (chat.js, sessions.js, media.js, stt.js, tts.js, workflow.js,
 * health.js) imports from `./_config.js`, never directly from
 * `../../server/ondemand/config.js` — one import path to change if the
 * config module ever moves, and one place (this file) to see every name a
 * handler is allowed to pull in.
 *
 * Reconciliation table (canonical -> alias -> default — EXCEPT the
 * `flowVersion` row, which is alias-first: `GODS_EYE_FLOW_VERSION` is the
 * name already provisioned on the Vercel project (env id usC3wgbut65gTkaR)
 * and keeps winning over the canonical `ONDEMAND_SPATIAL_FLOW_VERSION`
 * until it is migrated; `FLOW_VERSION_ENV` / `getConfig().flowVersionEnv`
 * carry the names and order. The `spatialFlowId` row is canonical-first
 * like every other: `ONDEMAND_SPATIAL_WORKFLOW_ID` (canonical since
 * 2026-09-18) -> `ONDEMAND_SPATIAL_FLOW_ID` (accepted alias) -> default;
 * `WORKFLOW_ID_ENV` / `getConfig().workflowIdEnv` carry those names and
 * order, and health's `config.spatialFlowId.resolvedVia` says which won.
 * Full detail and rationale in server/ondemand/config.js's header comment
 * and docs/ONDEMAND_PROXY_DESIGN.md "Environment name reconciliation
 * (2026-09-18)"):
 *
 *   Setting              | Canonical                          | Alias                | Default
 *   -------------------- | ----------------------------------- | --------------------- | ---------------------------
 *   baseUrl               | ONDEMAND_BASE_URL                  | ONDEMAND_API_BASE    | 'https://api.on-demand.io'
 *   reasoningEndpointId   | ONDEMAND_REASONING_ENDPOINT_ID      | ONDEMAND_ENDPOINT_ID | 'low' (documented reasoningMode, §3.1/§12)
 *   fulfillmentEndpointId | ONDEMAND_FULFILLMENT_ENDPOINT_ID    | ONDEMAND_ENDPOINT_ID | 'predefined-gpt-5.6-luna' (ASK winner)
 *   reasoningMode         | ONDEMAND_REASONING_MODE (validated) | —                     | '' (field omitted upstream)
 *   flowVersion           | ONDEMAND_SPATIAL_FLOW_VERSION       | GODS_EYE_FLOW_VERSION (checked FIRST) | '1' (FLOW_DEFAULTS)
 *   spatialFlowId         | ONDEMAND_SPATIAL_WORKFLOW_ID        | ONDEMAND_SPATIAL_FLOW_ID | '6aace534859f7b0abb53d99a' (FLOW_DEFAULTS)
 *   defaultPluginIds      | ONDEMAND_SPATIAL_AGENT_ID           | — (DENIED alias)     | [] (no default)
 *   apiKey                | ONDEMAND_API_KEY                    | —                     | '' (no default)
 *
 * Tier defaults — `TIER_DEFAULTS` / `tierDefaults(tier)` (re-exported from
 * the same module; also `getConfig().tiers`). Constants, not env-reconciled;
 * benchmark 2026-09-18T06:42–06:45Z, docs/audit/endpoint-benchmark.md and
 * docs/ONDEMAND_PROXY_DESIGN.md §10.6 (sync total / stream ttfd, all 200):
 *
 *   Tier        | fulfillmentEndpointId        | reasoningMode | measured
 *   ----------- | ---------------------------- | ------------- | ---------------------
 *   ASK         | 'predefined-gpt-5.6-luna'    | 'low'         | 4,189 ms / 1,880 ms
 *   INVESTIGATE | 'predefined-claude-sonnet-5' | 'low'         | 6,480 ms / 4,053 ms
 *   DEEP        | 'predefined-claude-sonnet-5' | 'high'        | same model, `high` reasoning
 *
 *   `tierDefaults('deep')` is case-insensitive; an unknown tier resolves
 *   to INVESTIGATE.
 *
 * Workflow defaults — `FLOW_DEFAULTS` (re-exported from the same module;
 * also `getConfig().flowDefaults`): the non-secret id and version label of
 * the workflow this repo created through the documented
 * `POST /automation/api/workflow/` on 2026-09-18 ("OnDemand Spatial
 * Advanced Workflow" v1 — created as "GodsEye Advanced Spatial Workflow",
 * display name changed 2026-09-18T10:41:47Z via the documented
 * `PATCH /workflow/{id}/name`, id unchanged — export
 * docs/ondemand-workflows/ondemand-spatial-advanced-v1.json,
 * docs/ondemand-workflows/README.md):
 *
 *   spatialFlowId = '6aace534859f7b0abb53d99a'   (201 @ 2026-09-18T07:16:04Z,
 *                                                 activated 200 @ 07:16:14Z)
 *   flowVersion   = '1'
 *
 *   These are the DEFAULT branch of the two reconciliation rows above; an
 *   env var set on the deployment still wins. `reasoningEndpointId`'s default is the default
 *   reasoningMode TIER (`'low'`), not an upstream endpoint — OnDemand has
 *   no separate reasoning endpoint (§12).
 *
 * DENY-LIST: the retired plugin-ids alias and any ElevenLabs API key env
 * var (exact spelling: server/ondemand/config.js's DENIED_ENV_NAMES, or
 * docs/ONDEMAND_PROXY_DESIGN.md) are never read by
 * server/ondemand/config.js and must never appear as a contiguous string
 * literal anywhere under api/ondemand/** — enforced by
 * server/ondemand/deny-list.test.mjs.
 */
export * from '../../server/ondemand/config.js';
// Camera-chat profile defaults (non-secret; docs/ONDEMAND_CAMERA_CHAT_ADDENDUM_2026-09-21.md).
export * from '../../server/ondemand/camera-chat-config.js';
