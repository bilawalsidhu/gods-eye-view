/**
 * Central environment configuration for the OnDemand serverless proxy
 * (api/ondemand/*). Read ONCE per module load (see the `state`/`computeConfig`
 * split below) — this is a Node module-cache-scoped "once", i.e. once per
 * warm Vercel function instance, not a re-read on every request.
 *
 * Contract reference: docs/ONDEMAND_API_CURRENT.md
 *   §1  Authentication — header name `apikey`; "Base URL per API family".
 *   §12 Reasoning Modes & Endpoints — `endpointId` is required and its
 *       predefined-id list is explicitly volatile; there is no separate
 *       "reasoning endpoint" concept (see docs/ONDEMAND_PROXY_DESIGN.md,
 *       "Dropped env vars" table, for ONDEMAND_REASONING_ENDPOINT_ID).
 *
 * SECURITY: nothing exported here may be logged or returned to a client
 * verbatim. Use server/ondemand/errors.js#redactKey() for any log line that
 * could carry `config.apiKey`.
 */

/** Strip exactly one trailing slash (contract §1 documents the base URL
 * without one; a caller-supplied override might still include one). */
function stripTrailingSlash(value) {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function computeConfig() {
  const rawBaseUrl =
    process.env.ONDEMAND_BASE_URL || 'https://api.on-demand.io';
  const timeoutRaw = Number(process.env.ONDEMAND_REQUEST_TIMEOUT_MS);
  return {
    apiKey: process.env.ONDEMAND_API_KEY || '',
    baseUrl: stripTrailingSlash(rawBaseUrl),
    // Agent/plugin id passed as `pluginIds` (§2.1 / §3.1) — default session plugin.
    spatialAgentId: process.env.ONDEMAND_SPATIAL_AGENT_ID || '',
    // Workflow id for `POST /workflow/{id}/execute` (§7.1).
    spatialFlowId: process.env.ONDEMAND_SPATIAL_FLOW_ID || '',
    // `endpointId` of the fulfillment model (§3.1 / §12). Never hardcode a
    // model id as a silent fallback in the proxy itself — the predefined list
    // is documented as volatile.
    fulfillmentEndpointId: process.env.ONDEMAND_FULFILLMENT_ENDPOINT_ID || '',
    // Guide-only, free-string, stream-only field (§3.1 "reasoningMode" row,
    // §12 "Reasoning mode values") — NOT in the OpenAPI schema. Optional knob;
    // see docs/ONDEMAND_PROXY_DESIGN.md for why ONDEMAND_REASONING_ENDPOINT_ID
    // (an *endpoint id*) was dropped instead of kept under this name.
    reasoningMode: process.env.ONDEMAND_REASONING_MODE || '',
    // Local proxy behaviour ONLY — NOT an OnDemand API field. Bounds every
    // upstream fetch except the SSE stream (which aborts on client close).
    requestTimeoutMs:
      Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 60000,
  };
}

// Read once per module load (production behaviour).
let state = computeConfig();

/**
 * Live view of the current config. Implemented with getters (rather than a
 * frozen plain object) so that `__reloadConfigForTests()` — used ONLY by
 * server/ondemand/*.test.mjs — is visible to every already-imported
 * consumer without re-importing this module.
 */
export const config = {
  get apiKey() {
    return state.apiKey;
  },
  get baseUrl() {
    return state.baseUrl;
  },
  get spatialAgentId() {
    return state.spatialAgentId;
  },
  get spatialFlowId() {
    return state.spatialFlowId;
  },
  get fulfillmentEndpointId() {
    return state.fulfillmentEndpointId;
  },
  get reasoningMode() {
    return state.reasoningMode;
  },
  get requestTimeoutMs() {
    return state.requestTimeoutMs;
  },
};

export function isConfigured() {
  return state.apiKey.length > 0;
}

/**
 * Base URL per API family — derived exactly per contract §1 "Base URL per
 * API family". `media` and `services` already include the documented path
 * prefix down to (but not including) the trailing verb segment, so callers
 * append only the remaining documented suffix, e.g. `${media}/raw`,
 * `${media}/{fileId}`, `${services}/execute/speech_to_text`.
 */
export function baseUrls() {
  return {
    chat: `${state.baseUrl}/chat/v1`,
    media: `${state.baseUrl}/media/v1/public/file`,
    services: `${state.baseUrl}/services/v1/public/service`,
    automation: `${state.baseUrl}/automation/api`,
  };
}

export function requestTimeoutMs() {
  return state.requestTimeoutMs;
}

/**
 * TEST-ONLY. Re-reads process.env into this module's cached state. Never
 * called by production code paths (config is read once per module load by
 * design) — it exists solely so server/ondemand/*.test.mjs can exercise both
 * the "configured" and "not configured" branches inside a single process
 * without spinning up separate module instances per case.
 */
export function __reloadConfigForTests() {
  state = computeConfig();
}
