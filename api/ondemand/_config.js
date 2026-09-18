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
 * Reconciliation table (canonical -> alias -> default; full detail and
 * rationale in server/ondemand/config.js's header comment and
 * docs/ONDEMAND_PROXY_DESIGN.md "Environment name reconciliation
 * (2026-09-18)"):
 *
 *   Setting              | Canonical                          | Alias                | Default
 *   -------------------- | ----------------------------------- | --------------------- | ---------------------------
 *   baseUrl               | ONDEMAND_BASE_URL                  | ONDEMAND_API_BASE    | 'https://api.on-demand.io'
 *   reasoningEndpointId   | ONDEMAND_REASONING_ENDPOINT_ID      | ONDEMAND_ENDPOINT_ID | 'dynamic'
 *   fulfillmentEndpointId | ONDEMAND_FULFILLMENT_ENDPOINT_ID    | ONDEMAND_ENDPOINT_ID | 'predefined-gpt-5.6-luna'
 *   reasoningMode         | ONDEMAND_REASONING_MODE (validated) | —                     | '' (field omitted upstream)
 *   flowVersion           | GODS_EYE_FLOW_VERSION               | —                     | '0'
 *   spatialFlowId         | ONDEMAND_SPATIAL_FLOW_ID            | —                     | '' (no default)
 *   defaultPluginIds      | ONDEMAND_SPATIAL_AGENT_ID           | — (DENIED alias)     | [] (no default)
 *   apiKey                | ONDEMAND_API_KEY                    | —                     | '' (no default)
 *
 * DENY-LIST: the retired plugin-ids alias and any ElevenLabs API key env
 * var (exact spelling: server/ondemand/config.js's DENIED_ENV_NAMES, or
 * docs/ONDEMAND_PROXY_DESIGN.md) are never read by
 * server/ondemand/config.js and must never appear as a contiguous string
 * literal anywhere under api/ondemand/** — enforced by
 * server/ondemand/deny-list.test.mjs.
 */
export * from '../../server/ondemand/config.js';
