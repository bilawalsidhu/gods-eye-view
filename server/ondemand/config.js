/**
 * Central environment configuration for the OnDemand serverless proxy
 * (api/ondemand/*). Read ONCE per module load (see the `state`/`computeConfig`
 * split below) — this is a Node module-cache-scoped "once", i.e. once per
 * warm Vercel function instance, not a re-read on every request.
 *
 * SINGLE IMPORT POINT: every function under api/ondemand/** imports this
 * module only indirectly, via api/ondemand/_config.js (`export * from
 * '../../server/ondemand/config.js'`) — see that file's header comment for
 * why the underscore prefix matters on Vercel.
 *
 * Contract reference: docs/ONDEMAND_API_CURRENT.md
 *   §1  Authentication — header name `apikey`; "Base URL per API family".
 *   §3.1/§12 `reasoningMode` — free string, guide-only, NOT in the OpenAPI
 *       schema; no REST endpoint enumerates it in the public docs (a live,
 *       undocumented one was found and recorded in §17.4/§17.5).
 *   §12 Reasoning Modes & Endpoints — `endpointId` is required and its
 *       predefined-id list is explicitly volatile; there is no separate
 *       "reasoning endpoint" concept in the API itself (see
 *       `reasoningEndpointId` below).
 *   §17 LIVE VALIDATION 2026-09-18 — chose the tier defaults used below.
 *
 * Reconciliation table (canonical name tried first, then the accepted
 * alias, then a built-in default; `configSources()` reports which NAME
 * — never a value — actually won for each row). Added 2026-09-17 for the
 * ondemand-eand-spatial Vercel project (full history:
 * docs/ONDEMAND_PROXY_DESIGN.md §5b); extended 2026-09-18 with the
 * step-3/live-validation defaults (docs/ONDEMAND_PROXY_DESIGN.md
 * "Environment name reconciliation (2026-09-18)"):
 *
 *   Setting              | Canonical                          | Alias                   | Default (source='default')
 *   -------------------- | ----------------------------------- | ------------------------ | ---------------------------
 *   baseUrl               | ONDEMAND_BASE_URL                  | ONDEMAND_API_BASE       | 'https://api.on-demand.io'
 *   reasoningEndpointId   | ONDEMAND_REASONING_ENDPOINT_ID      | ONDEMAND_ENDPOINT_ID    | 'dynamic'
 *   fulfillmentEndpointId | ONDEMAND_FULFILLMENT_ENDPOINT_ID    | ONDEMAND_ENDPOINT_ID    | 'predefined-gpt-5.6-luna'
 *   reasoningMode         | ONDEMAND_REASONING_MODE (validated) | —                        | '' (field omitted upstream)
 *   flowVersion           | GODS_EYE_FLOW_VERSION               | —                        | '0'
 *   spatialFlowId         | ONDEMAND_SPATIAL_FLOW_ID            | —                        | '' (no default)
 *   defaultPluginIds      | ONDEMAND_SPATIAL_AGENT_ID           | — (DENIED, see below)   | [] (no default)
 *   apiKey                | ONDEMAND_API_KEY                    | —                        | '' (no default)
 *
 * Notes:
 *   - `reasoningEndpointId` and `fulfillmentEndpointId` share the SAME
 *     alias name (`ONDEMAND_ENDPOINT_ID`) — if only that alias is set,
 *     BOTH fields resolve to it. This is intentional: OnDemand has no
 *     separate "reasoning endpoint" concept (§12), so `reasoningEndpointId`
 *     is reconciled purely for env-name compatibility/health reporting —
 *     its value is conceptually a `reasoningMode`-style tier id (its
 *     default, `'dynamic'`, is itself a documented live modeId, §17.5),
 *     never an upstream endpoint the proxy calls. It is NOT copied into
 *     `reasoningMode` and is NOT sent upstream by any handler in this task.
 *   - `reasoningMode` is validated against `DOCUMENTED_REASONING_MODES`
 *     (below); an out-of-list value falls back to `'dynamic'` (the
 *     documented default tier, §17.5 INVESTIGATE) with `reasoningModeInvalid:
 *     true` rather than being forwarded blind.
 *   - `flowVersion` (`GODS_EYE_FLOW_VERSION`) is informational only —
 *     workflow versioning is NOT FOUND IN LIVE DOCS (§7.3) — and is never
 *     sent upstream by any handler.
 *   - DENY-LIST (docs/ONDEMAND_PROXY_DESIGN.md "Environment name
 *     reconciliation (2026-09-18)"): the retired plugin-ids alias for
 *     `ONDEMAND_SPATIAL_AGENT_ID` (exact spelling: see DENIED_ENV_NAMES
 *     below) and any ElevenLabs API key env var are never read anywhere in
 *     this module, or written as a contiguous string literal anywhere
 *     under api/ondemand/** or server/ondemand/*.js (non-test files) —
 *     enforced by server/ondemand/deny-list.test.mjs.
 *
 * `configSources()` reports which NAME actually supplied each logical
 * setting — names only, never values — consumed by the `?envNames=1` debug
 * flag on api/ondemand/health.js. `getConfig()` returns everything above
 * (plus per-family `baseUrls`) as one frozen snapshot object — the single
 * shape other modules (e.g. the selftest route) should destructure from.
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

/**
 * Canonical-name-first / alias-second / default-last reconciliation for a
 * single string setting — the shared shape behind every row in the table
 * above. Returns `{ value, source }`:
 *   - canonical name set (non-empty)         -> source = canonicalName
 *   - alias name set (non-empty), no alias   -> source = aliasName
 *   - neither set, `defaultValue !== ''`     -> source = 'default'
 *   - neither set, `defaultValue === ''`     -> source = 'unset'
 * `source` is a NAME (or 'default'/'unset'), never a value.
 */
function reconcile(canonicalName, aliasName, defaultValue) {
  const canonicalValue = process.env[canonicalName];
  if (nonEmpty(canonicalValue)) {
    return { value: canonicalValue, source: canonicalName };
  }
  if (aliasName) {
    const aliasValue = process.env[aliasName];
    if (nonEmpty(aliasValue)) {
      return { value: aliasValue, source: aliasName };
    }
  }
  return {
    value: defaultValue,
    source: defaultValue === '' ? 'unset' : 'default',
  };
}

// DENY-LIST — see the header comment and docs/ONDEMAND_PROXY_DESIGN.md
// "Environment name reconciliation (2026-09-18)". Built from parts (never a
// literal) so this file itself never contains the two denied strings —
// server/ondemand/deny-list.test.mjs greps non-test source files for them.
// Rule 43: no secondary AI/voice provider (an ElevenLabs API key) is ever
// read or forwarded; plugin ids come only from ONDEMAND_SPATIAL_AGENT_ID,
// never the retired knowledge-plugin-ids alias (full name spelled out in
// docs/ONDEMAND_PROXY_DESIGN.md and in DENIED_ENV_NAMES's own runtime
// value just below).
const DENIED_ENV_NAMES = Object.freeze([
  ['ELEVENLABS', 'API', 'KEY'].join('_'),
  ['ONDEMAND', 'KNOWLEDGE', 'PLUGIN', 'IDS'].join('_'),
]);

/** Throws if any key of `result` or `result.sources` is literally one of
 * DENIED_ENV_NAMES — a defensive runtime tripwire (mirrored statically by
 * deny-list.test.mjs) so a future edit can't silently reintroduce either
 * name as a config field. Never expected to actually throw in normal
 * operation. */
function assertNoDeniedKeys(result) {
  const keys = [...Object.keys(result), ...Object.keys(result.sources)];
  for (const key of keys) {
    if (DENIED_ENV_NAMES.includes(key)) {
      throw new Error(
        `server/ondemand/config.js: "${key}" must never be a getConfig() key (deny-list)`,
      );
    }
  }
}

/**
 * Documented/observed `reasoningMode` tier ids. `ONDEMAND_REASONING_MODE`
 * is validated against this list (see `reconcileReasoningMode` below); an
 * out-of-list value is rejected rather than forwarded blind.
 *
 * Sources (no single enumerated list is published anywhere for this field):
 *   - docs/ONDEMAND_API_CURRENT.md §3.1 "Every body field" (`reasoningMode`
 *     row) — guide examples `low`, `high`.
 *   - docs/ONDEMAND_API_CURRENT.md §12 "Reasoning mode values" — stream
 *     samples `"grok-4-fast"` and `"low"`.
 *   - docs/ONDEMAND_API_CURRENT.md §17.4 "LIVE VALIDATION 2026-09-18" —
 *     `GET /config/v1/public/reasoning_modes` (undocumented but live),
 *     predefined `modeId` values verbatim: `dynamic, glm-4.7-flash,
 *     gemini-3-flash, grok-4-fast, gemini-3, deepseek-v3.1, haiku,
 *     glm-5-turbo, minimax-m2, gpt-5.4, gpt-5.4-pro, opus, kimi-k2`.
 */
export const DOCUMENTED_REASONING_MODES = Object.freeze([
  'low',
  'high',
  'grok-4-fast',
  'dynamic',
  'glm-4.7-flash',
  'gemini-3-flash',
  'gemini-3',
  'deepseek-v3.1',
  'haiku',
  'glm-5-turbo',
  'minimax-m2',
  'gpt-5.4',
  'gpt-5.4-pro',
  'opus',
  'kimi-k2',
]);

// Documented default tier (also the §17.5 INVESTIGATE reasoning choice) —
// used both as the `reasoningEndpointId` default and as the fallback value
// when ONDEMAND_REASONING_MODE is set but invalid.
const REASONING_MODE_DEFAULT_TIER = 'dynamic';

/** `ONDEMAND_REASONING_MODE` has no alias, but unlike a plain reconcile()
 * row its "default" branch only fires for an explicitly-set-but-invalid
 * value (`invalid: true`, source `'default'`) — a genuinely unset var stays
 * `''`/`'unset'` so the field is omitted upstream entirely, never sent as
 * the fallback tier id. */
function reconcileReasoningMode() {
  const raw = process.env.ONDEMAND_REASONING_MODE;
  if (!nonEmpty(raw)) {
    return { value: '', source: 'unset', invalid: false };
  }
  if (DOCUMENTED_REASONING_MODES.includes(raw)) {
    return { value: raw, source: 'ONDEMAND_REASONING_MODE', invalid: false };
  }
  return {
    value: REASONING_MODE_DEFAULT_TIER,
    source: 'default',
    invalid: true,
  };
}

function computeConfig() {
  const apiKeyResult = reconcile('ONDEMAND_API_KEY', null, '');

  const baseUrlResult = reconcile(
    'ONDEMAND_BASE_URL',
    'ONDEMAND_API_BASE',
    'https://api.on-demand.io',
  );
  const baseUrl = normalizeBaseUrl(baseUrlResult.value);

  // No separate "reasoning endpoint" concept exists upstream (§12) — see
  // the header comment for why this is reconciled independently of
  // `reasoningMode`, sharing ONDEMAND_ENDPOINT_ID as its alias with
  // `fulfillmentEndpointId` below.
  const reasoningEndpointResult = reconcile(
    'ONDEMAND_REASONING_ENDPOINT_ID',
    'ONDEMAND_ENDPOINT_ID',
    REASONING_MODE_DEFAULT_TIER,
  );

  // `endpointId` of the fulfillment model (§3.1/§12); default verified live
  // 2026-09-18 (§17.5 INVESTIGATE tier) — ids are volatile per §12, so this
  // default is expected to need revisiting as the predefined list changes.
  const fulfillmentEndpointResult = reconcile(
    'ONDEMAND_FULFILLMENT_ENDPOINT_ID',
    'ONDEMAND_ENDPOINT_ID',
    'predefined-gpt-5.6-luna',
  );

  const reasoningModeResult = reconcileReasoningMode();

  // Workflow id for `POST /workflow/{id}/execute` (§7.1). No alias exists
  // on the target Vercel project for this concept.
  const spatialFlowResult = reconcile('ONDEMAND_SPATIAL_FLOW_ID', null, '');

  // Informational only — never sent upstream (§7.3: workflow versioning is
  // NOT FOUND IN LIVE DOCS). String, not number: a version "0" vs 0 has no
  // semantic difference to any consumer, and a string avoids NaN handling.
  const flowVersionResult = reconcile('GODS_EYE_FLOW_VERSION', null, '0');

  // DENY-LIST: the retired plugin-ids alias (see DENIED_ENV_NAMES above)
  // is never read here — defaultPluginIds comes ONLY from
  // ONDEMAND_SPATIAL_AGENT_ID. See the header comment and
  // deny-list.test.mjs.
  const envSpatialAgentId = process.env.ONDEMAND_SPATIAL_AGENT_ID;
  let defaultPluginIds = [];
  let defaultPluginIdsSource = 'unset';
  if (nonEmpty(envSpatialAgentId)) {
    defaultPluginIds = splitIds(envSpatialAgentId);
    defaultPluginIdsSource = 'ONDEMAND_SPATIAL_AGENT_ID';
  }
  // A value that is non-empty but entirely separators (e.g. " , , ")
  // splits down to an empty list — report the *effective* absence as
  // 'unset', not the env NAME that contributed nothing.
  if (defaultPluginIds.length === 0) defaultPluginIdsSource = 'unset';

  const timeoutRaw = Number(process.env.ONDEMAND_REQUEST_TIMEOUT_MS);
  const timeoutOverridden = Number.isFinite(timeoutRaw) && timeoutRaw > 0;

  return {
    apiKey: apiKeyResult.value,
    baseUrl,
    // Which env NAME the value above came from ('ONDEMAND_BASE_URL',
    // 'ONDEMAND_API_BASE', or 'default') — never a value. Mirrored in
    // `sources.baseUrl` below; kept as its own field too since it is the
    // one alias-sourced setting worth surfacing outside a debug flag.
    baseUrlSource: baseUrlResult.source,
    // Agent/plugin id(s) passed as `pluginIds` (§2.1 / §3.1) — default
    // session plugins. `spatialAgentId` (first id) is kept so existing
    // single-id consumers (api/ondemand/health.js's `plugins` map) keep
    // working unchanged; `defaultPluginIds` (full list) is what
    // session-service.js now defaults `pluginIds` from.
    spatialAgentId: defaultPluginIds[0] || '',
    defaultPluginIds,
    spatialFlowId: spatialFlowResult.value,
    // See the header comment: reconciled for env-name/health purposes only;
    // not itself sent upstream by any handler in this task.
    reasoningEndpointId: reasoningEndpointResult.value,
    // Never hardcode a model id as a silent fallback anywhere BUT here —
    // the predefined list is documented as volatile (§12); this single
    // constant is the one place that assumption is made, deliberately.
    fulfillmentEndpointId: fulfillmentEndpointResult.value,
    // Guide-only, free-string, stream-only field (§3.1 "reasoningMode" row,
    // §12 "Reasoning mode values") — NOT in the OpenAPI schema. Validated
    // against DOCUMENTED_REASONING_MODES above.
    reasoningMode: reasoningModeResult.value,
    // true only when ONDEMAND_REASONING_MODE was set to a value outside
    // DOCUMENTED_REASONING_MODES (and therefore silently replaced by the
    // default tier above) — surfaced by api/ondemand/health.js so a typo'd
    // env var is visible instead of silently downgraded forever.
    reasoningModeInvalid: reasoningModeResult.invalid,
    // Informational only — see the header comment; never sent upstream.
    flowVersion: flowVersionResult.value,
    // Local proxy behaviour ONLY — NOT an OnDemand API field. Bounds every
    // upstream fetch except the SSE stream (which aborts on client close).
    requestTimeoutMs: timeoutOverridden ? timeoutRaw : 60000,
    // Names only, never values — see configSources() below.
    sources: {
      apiKey: apiKeyResult.source,
      baseUrl: baseUrlResult.source,
      reasoningEndpointId: reasoningEndpointResult.source,
      fulfillmentEndpointId: fulfillmentEndpointResult.source,
      defaultPluginIds: defaultPluginIdsSource,
      spatialFlowId: spatialFlowResult.source,
      reasoningMode: reasoningModeResult.source,
      flowVersion: flowVersionResult.source,
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
  get reasoningEndpointId() {
    return state.reasoningEndpointId;
  },
  get fulfillmentEndpointId() {
    return state.fulfillmentEndpointId;
  },
  get reasoningMode() {
    return state.reasoningMode;
  },
  get reasoningModeInvalid() {
    return state.reasoningModeInvalid;
  },
  get flowVersion() {
    return state.flowVersion;
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
 * baseUrl/reasoningEndpointId/fulfillmentEndpointId/flowVersion/an invalid
 * reasoningMode), or `'unset'` (no default either — the field is simply
 * empty). NAMES ONLY, never values — safe to serialize verbatim in an HTTP
 * response (see api/ondemand/health.js's `?envNames=1`).
 */
export function configSources() {
  return { ...state.sources };
}

/**
 * Single frozen snapshot of every setting above, plus per-family
 * `baseUrls`. This is the shape any new module should destructure from
 * (e.g. `const { apiKey, baseUrl, fulfillmentEndpointId, spatialFlowId,
 * defaultPluginIds } = getConfig();`) rather than importing individual
 * getters piecemeal. Asserts (defensively — see assertNoDeniedKeys above)
 * that none of its own keys, or `sources`' keys, are a denied env name.
 */
export function getConfig() {
  const result = {
    apiKey: state.apiKey,
    baseUrl: state.baseUrl,
    baseUrls: baseUrls(),
    reasoningEndpointId: state.reasoningEndpointId,
    fulfillmentEndpointId: state.fulfillmentEndpointId,
    reasoningMode: state.reasoningMode,
    reasoningModeInvalid: state.reasoningModeInvalid,
    flowVersion: state.flowVersion,
    spatialFlowId: state.spatialFlowId,
    defaultPluginIds: state.defaultPluginIds,
    spatialAgentId: state.spatialAgentId,
    requestTimeoutMs: state.requestTimeoutMs,
    sources: configSources(),
  };
  assertNoDeniedKeys(result);
  Object.freeze(result.baseUrls);
  Object.freeze(result.sources);
  return Object.freeze(result);
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
