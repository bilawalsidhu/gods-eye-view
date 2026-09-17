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
 * Accepted env-var ALIASES (added 2026-09-17 for the ondemand-eand-spatial
 * Vercel project — see docs/ONDEMAND_PROXY_DESIGN.md §5b for the full
 * reconciliation table). That project was provisioned with a few
 * differently-named variables for the same concepts as this proxy's
 * canonical names. The canonical name always wins when both are set; the
 * alias is a fallback, never an override:
 *   - `ONDEMAND_BASE_URL`                (canonical) | `ONDEMAND_API_BASE` (alias)
 *   - `ONDEMAND_FULFILLMENT_ENDPOINT_ID` (canonical) | `ONDEMAND_ENDPOINT_ID` (alias)
 *   - `ONDEMAND_SPATIAL_AGENT_ID`        (canonical) | `ONDEMAND_KNOWLEDGE_PLUGIN_IDS` (alias, comma/whitespace-separated)
 * `ONDEMAND_SPATIAL_FLOW_ID` has no alias on that project — no equivalent
 * env var exists there for a default workflow id.
 * `configSources()` reports which NAME actually supplied each logical
 * setting — names only, never values — consumed by the `?envNames=1` debug
 * flag on api/ondemand/health.js.
 *
 * SECURITY: nothing exported here may be logged or returned to a client
 * verbatim. Use server/ondemand/errors.js#redactKey() for any log line that
 * could carry `config.apiKey`.
 */

/** An env var explicitly set to `""` (or whitespace-only) is treated as
 * unset, matching this module's long-standing `X || default` convention. */
function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// Contract §2.1 `pluginIds` schema: `maxItems: 20`. Applied here too since
// `defaultPluginIds` below feeds straight into that same field.
const MAX_DEFAULT_PLUGIN_IDS = 20;

/** API-family path suffixes documented in contract §1 (see `baseUrls()`
 * below). An aliased env var (`ONDEMAND_API_BASE`) may have been copied from
 * a full endpoint URL rather than the bare host `ONDEMAND_BASE_URL`
 * documents, so one trailing known suffix is stripped defensively — e.g.
 * `https://x.on-demand.io/chat/v1` still yields a usable host for every
 * family, not just `chat`. */
const KNOWN_BASE_URL_SUFFIXES = [
  '/chat/v1',
  '/media/v1/public/file',
  '/services/v1/public/service',
  '/automation/api',
];

/** Strip trailing slash(es) (contract §1 documents the base URL without
 * one; a caller-supplied override might still include one, or several). */
function stripTrailingSlashes(value) {
  let out = value;
  while (out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

/** Trim + strip trailing slash(es) + defensively strip one trailing known
 * API-family path segment (see KNOWN_BASE_URL_SUFFIXES above), re-stripping
 * any slash that then borders the new end. */
function normalizeBaseUrl(raw) {
  let out = stripTrailingSlashes(String(raw).trim());
  for (const suffix of KNOWN_BASE_URL_SUFFIXES) {
    if (out.length > suffix.length && out.endsWith(suffix)) {
      out = stripTrailingSlashes(out.slice(0, -suffix.length));
      break;
    }
  }
  return out;
}

/** comma/whitespace-separated list -> trimmed, de-duplicated, capped at the
 * documented `pluginIds` maxItems (20, contract §2.1). Order preserved. */
function splitIds(raw) {
  const parts = String(raw)
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(parts)].slice(0, MAX_DEFAULT_PLUGIN_IDS);
}

function computeConfig() {
  const envBaseUrl = process.env.ONDEMAND_BASE_URL;
  const envApiBase = process.env.ONDEMAND_API_BASE;
  let rawBaseUrl = 'https://api.on-demand.io';
  let baseUrlSource = 'default';
  if (nonEmpty(envBaseUrl)) {
    rawBaseUrl = envBaseUrl;
    baseUrlSource = 'ONDEMAND_BASE_URL';
  } else if (nonEmpty(envApiBase)) {
    rawBaseUrl = envApiBase;
    baseUrlSource = 'ONDEMAND_API_BASE';
  }

  const envFulfillmentId = process.env.ONDEMAND_FULFILLMENT_ENDPOINT_ID;
  const envEndpointId = process.env.ONDEMAND_ENDPOINT_ID;
  let fulfillmentEndpointId = '';
  let fulfillmentEndpointIdSource = 'unset';
  if (nonEmpty(envFulfillmentId)) {
    fulfillmentEndpointId = envFulfillmentId;
    fulfillmentEndpointIdSource = 'ONDEMAND_FULFILLMENT_ENDPOINT_ID';
  } else if (nonEmpty(envEndpointId)) {
    fulfillmentEndpointId = envEndpointId;
    fulfillmentEndpointIdSource = 'ONDEMAND_ENDPOINT_ID';
  }

  const envSpatialAgentId = process.env.ONDEMAND_SPATIAL_AGENT_ID;
  const envKnowledgePluginIds = process.env.ONDEMAND_KNOWLEDGE_PLUGIN_IDS;
  let defaultPluginIds = [];
  let defaultPluginIdsSource = 'unset';
  if (nonEmpty(envSpatialAgentId)) {
    defaultPluginIds = splitIds(envSpatialAgentId);
    defaultPluginIdsSource = 'ONDEMAND_SPATIAL_AGENT_ID';
  } else if (nonEmpty(envKnowledgePluginIds)) {
    defaultPluginIds = splitIds(envKnowledgePluginIds);
    defaultPluginIdsSource = 'ONDEMAND_KNOWLEDGE_PLUGIN_IDS';
  }
  if (defaultPluginIds.length === 0) defaultPluginIdsSource = 'unset';

  const timeoutRaw = Number(process.env.ONDEMAND_REQUEST_TIMEOUT_MS);
  const timeoutOverridden = Number.isFinite(timeoutRaw) && timeoutRaw > 0;

  return {
    apiKey: process.env.ONDEMAND_API_KEY || '',
    baseUrl: normalizeBaseUrl(rawBaseUrl),
    // Which env NAME the value above came from ('ONDEMAND_BASE_URL',
    // 'ONDEMAND_API_BASE', or 'default') — never a value. Mirrored in
    // `sources.baseUrl` below; kept as its own field too since it is the
    // one alias-sourced setting worth surfacing outside a debug flag.
    baseUrlSource,
    // Agent/plugin id(s) passed as `pluginIds` (§2.1 / §3.1) — default
    // session plugins. `spatialAgentId` (first id) is kept so existing
    // single-id consumers (api/ondemand/health.js's `plugins` map) keep
    // working unchanged; `defaultPluginIds` (full list) is what
    // session-service.js now defaults `pluginIds` from.
    spatialAgentId: defaultPluginIds[0] || '',
    defaultPluginIds,
    // Workflow id for `POST /workflow/{id}/execute` (§7.1). No alias exists
    // on the target Vercel project for this concept — see
    // docs/ONDEMAND_PROXY_DESIGN.md §5b.
    spatialFlowId: process.env.ONDEMAND_SPATIAL_FLOW_ID || '',
    // `endpointId` of the fulfillment model (§3.1 / §12). Never hardcode a
    // model id as a silent fallback in the proxy itself — the predefined list
    // is documented as volatile.
    fulfillmentEndpointId,
    // Guide-only, free-string, stream-only field (§3.1 "reasoningMode" row,
    // §12 "Reasoning mode values") — NOT in the OpenAPI schema. Optional knob;
    // see docs/ONDEMAND_PROXY_DESIGN.md for why ONDEMAND_REASONING_ENDPOINT_ID
    // (an *endpoint id*) was dropped instead of kept under this name.
    reasoningMode: process.env.ONDEMAND_REASONING_MODE || '',
    // Local proxy behaviour ONLY — NOT an OnDemand API field. Bounds every
    // upstream fetch except the SSE stream (which aborts on client close).
    requestTimeoutMs: timeoutOverridden ? timeoutRaw : 60000,
    // Names only, never values — see configSources() below.
    sources: {
      apiKey: nonEmpty(process.env.ONDEMAND_API_KEY)
        ? 'ONDEMAND_API_KEY'
        : 'unset',
      baseUrl: baseUrlSource,
      defaultPluginIds: defaultPluginIdsSource,
      spatialFlowId: nonEmpty(process.env.ONDEMAND_SPATIAL_FLOW_ID)
        ? 'ONDEMAND_SPATIAL_FLOW_ID'
        : 'unset',
      fulfillmentEndpointId: fulfillmentEndpointIdSource,
      reasoningMode: nonEmpty(process.env.ONDEMAND_REASONING_MODE)
        ? 'ONDEMAND_REASONING_MODE'
        : 'unset',
      requestTimeoutMs: timeoutOverridden
        ? 'ONDEMAND_REQUEST_TIMEOUT_MS'
        : 'default',
    },
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
  get baseUrlSource() {
    return state.baseUrlSource;
  },
  get spatialAgentId() {
    return state.spatialAgentId;
  },
  get defaultPluginIds() {
    return state.defaultPluginIds;
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
 * Which env NAME supplied each logical setting: the canonical name, the
 * accepted alias name, `'default'` (built-in default was used, e.g.
 * baseUrl/requestTimeoutMs), or `'unset'` (no default either — the field is
 * simply empty). NAMES ONLY, never values — safe to serialize verbatim in
 * an HTTP response (see api/ondemand/health.js's `?envNames=1`).
 */
export function configSources() {
  return { ...state.sources };
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
