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
 *   §17 LIVE VALIDATION 2026-09-18 — first live pass over the tier ids;
 *       superseded for the DEFAULTS below by the timed benchmark of
 *       2026-09-18T06:42–06:45Z (docs/audit/endpoint-benchmark.md, see
 *       TIER_DEFAULTS).
 *
 * Reconciliation table (canonical name tried first, then the accepted
 * alias, then a built-in default; `configSources()` reports which NAME
 * — never a value — actually won for each row). Added 2026-09-17 for the
 * ondemand-eand-spatial Vercel project (full history:
 * docs/ONDEMAND_PROXY_DESIGN.md §5b); extended 2026-09-18 with the
 * step-3/live-validation defaults (docs/ONDEMAND_PROXY_DESIGN.md
 * "Environment name reconciliation (2026-09-18)"), then re-based on the
 * timed benchmark (docs/ONDEMAND_PROXY_DESIGN.md §10.6):
 *
 *   Setting              | Canonical                          | Alias                   | Default (source='default')
 *   -------------------- | ----------------------------------- | ------------------------ | ---------------------------
 *   baseUrl               | ONDEMAND_BASE_URL                  | ONDEMAND_API_BASE       | 'https://api.on-demand.io'
 *   reasoningEndpointId   | ONDEMAND_REASONING_ENDPOINT_ID      | ONDEMAND_ENDPOINT_ID    | 'low' (documented reasoningMode, §3.1/§12)
 *   fulfillmentEndpointId | ONDEMAND_FULFILLMENT_ENDPOINT_ID    | ONDEMAND_ENDPOINT_ID    | 'predefined-gpt-5.6-luna' (ASK winner)
 *   reasoningMode         | ONDEMAND_REASONING_MODE (validated) | —                        | '' (field omitted upstream)
 *   flowVersion           | ONDEMAND_SPATIAL_FLOW_VERSION       | GODS_EYE_FLOW_VERSION (checked FIRST) | '1' (FLOW_DEFAULTS, 2026-09-18)
 *   spatialFlowId         | ONDEMAND_SPATIAL_WORKFLOW_ID        | ONDEMAND_SPATIAL_FLOW_ID | '6aace534859f7b0abb53d99a' (FLOW_DEFAULTS)
 *   defaultPluginIds      | ONDEMAND_SPATIAL_AGENT_ID           | — (DENIED, see below)   | [] (no default)
 *   apiKey                | ONDEMAND_API_KEY                    | —                        | '' (no default)
 *
 *   Platform-registration ids (added 2026-09-19 — see REGISTRATION_ID_ENV
 *   below; docs/registration/CREATION_LOG_2026-09-19.md §4–§5): resolved
 *   env → registration pack → unset, and reported by /api/ondemand/health
 *   as `config.<row>.source` ∈ 'env' | 'registration-pack' | 'unset' —
 *   presence and source ONLY, the id value itself is never echoed.
 *
 *   Setting              | Env NAME                            | Registration-pack fallback (src/registry/capabilities.json)
 *   -------------------- | ----------------------------------- | -----------------------------------------------------------
 *   spatialAgentId (reg) | ONDEMAND_SPATIAL_AGENT_ID           | ondemand.agent.pluginId
 *   spatialToolId        | ONDEMAND_SPATIAL_TOOL_ID            | capabilities[id="earthquake.search"].ondemand_tool_id
 *
 *   Tier defaults (NOT env-reconciled — constants, see TIER_DEFAULTS /
 *   tierDefaults(); benchmark 2026-09-18, docs/audit/endpoint-benchmark.md):
 *
 *   Tier        | fulfillmentEndpointId        | reasoningMode | sync total / stream ttfd
 *   ----------- | ---------------------------- | ------------- | ------------------------
 *   ASK         | 'predefined-gpt-5.6-luna'    | 'low'         | 4,189 ms / 1,880 ms
 *   INVESTIGATE | 'predefined-claude-sonnet-5' | 'low'         | 6,480 ms / 4,053 ms
 *   DEEP        | 'predefined-claude-sonnet-5' | 'high'        | (same model, deeper reasoning)
 *
 * Notes:
 *   - `reasoningEndpointId` and `fulfillmentEndpointId` share the SAME
 *     alias name (`ONDEMAND_ENDPOINT_ID`) — if only that alias is set,
 *     BOTH fields resolve to it. This is intentional: OnDemand has no
 *     separate "reasoning endpoint" concept (§12), so `reasoningEndpointId`
 *     is reconciled purely for env-name compatibility/health reporting —
 *     its value is the DEFAULT `reasoningMode` TIER (its default, `'low'`,
 *     is a documented reasoningMode value, §3.1/§12, and the mode every
 *     benchmarked tier ran with), never an upstream endpoint the proxy
 *     calls. It is NOT copied into `reasoningMode` and is NOT sent
 *     upstream by any handler in this task.
 *   - `reasoningMode` is validated against `DOCUMENTED_REASONING_MODES`
 *     (below); an out-of-list value falls back to `'dynamic'` (the
 *     documented default tier, §17.5 INVESTIGATE — unchanged by the
 *     benchmark re-base, see docs/ONDEMAND_PROXY_DESIGN.md §10.2) with
 *     `reasoningModeInvalid: true` rather than being forwarded blind.
 *   - `flowVersion` (`ONDEMAND_SPATIAL_FLOW_VERSION`, alias
 *     `GODS_EYE_FLOW_VERSION`) is informational only — workflow versioning
 *     is NOT FOUND IN LIVE DOCS (§7.3) — and is never sent upstream by any
 *     handler. Its default is FLOW_DEFAULTS.flowVersion ('1'): the version
 *     label of the workflow this repo created. This is the ONE row that is
 *     reconciled ALIAS-FIRST (`reconcileAliasFirst`, order =
 *     FLOW_VERSION_ENV.order): the Vercel project already provisions
 *     `GODS_EYE_FLOW_VERSION` (env id usC3wgbut65gTkaR) and that value must
 *     keep winning until the operator migrates it to the canonical name —
 *     `sources.flowVersion` names which of the two (or 'default') resolved,
 *     surfaced by api/ondemand/health.js `config.flowVersion.resolvedVia`.
 *   - `spatialFlowId` is reconciled CANONICAL-first (`reconcile`, order =
 *     WORKFLOW_ID_ENV.order): `ONDEMAND_SPATIAL_WORKFLOW_ID` (canonical,
 *     added 2026-09-18 — the API calls the object a *workflow*, contract
 *     §7 / §18.2 a) → `ONDEMAND_SPATIAL_FLOW_ID` (the accepted alias, the
 *     name every earlier deployment note used) → FLOW_DEFAULTS.spatialFlowId
 *     — the REAL id returned by the documented
 *     `POST /automation/api/workflow/` (201) on 2026-09-18T07:16:04Z for
 *     "OnDemand Spatial Advanced Workflow" v1 — created as "GodsEye
 *     Advanced Spatial Workflow", display name changed 2026-09-18T10:41:47Z
 *     via `PATCH /workflow/{id}/name`, id unchanged (docs/ondemand-workflows/
 *     README.md) and re-confirmed live by `GET /workflow/{id}` → 200 on
 *     2026-09-18T16:20:55Z (contract §18.2 a; the 26-character spelling
 *     `…859f9f7b…` answers 404 and must never be used). A workflow id is
 *     not a secret (it is useless without the api key), which is why it
 *     may live here as a non-secret default. `sources.spatialFlowId` names
 *     which of the two env names (or 'default') won, surfaced by
 *     api/ondemand/health.js `config.spatialFlowId.resolvedVia`.
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

import { readFileSync } from 'node:fs';

/** An env var explicitly set to `""` (or whitespace-only) is treated as
 * unset, matching this module's long-standing `X || default` convention. */
function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Platform-registration id rows (added 2026-09-19). The OnDemand platform
 * has no public REST/MCP operation that creates a REST agent, an agent with
 * a system prompt, or a skill (docs/registration/API_RECHECK_2026-09-19.md
 * §1), so the ids the dashboard returns are pasted by a human into
 * `src/registry/capabilities.json` (the "registration pack" paste-back
 * file, docs/audit/dashboard-registration-pack.md §6) and/or provisioned
 * as env vars. Each row resolves env NAME → registration pack → unset;
 * the resolved SOURCE is one of REGISTRATION_ID_SOURCES and is the only
 * thing api/ondemand/health.js reports (never the id value).
 *
 * `pack` is the repo-relative path of the paste-back file; `packKeys`
 * documents where each row is read from inside it (names only).
 */
export const REGISTRATION_ID_ENV = Object.freeze({
  spatialAgentId: 'ONDEMAND_SPATIAL_AGENT_ID',
  spatialToolId: 'ONDEMAND_SPATIAL_TOOL_ID',
  pack: 'src/registry/capabilities.json',
  packKeys: Object.freeze({
    spatialAgentId: 'ondemand.agent.pluginId',
    spatialToolId: 'capabilities[id="earthquake.search"].ondemand_tool_id',
  }),
});

/** Closed vocabulary of `sources.spatialAgentId` / `sources.spatialToolId`
 * (and of `config.<row>.source` in the health response). */
export const REGISTRATION_ID_SOURCES = Object.freeze([
  'env',
  'registration-pack',
  'unset',
]);

const REGISTRATION_PACK_URL = new URL(
  '../../src/registry/capabilities.json',
  import.meta.url,
);

/** TEST-ONLY override of the parsed registration pack (see
 * `__setRegistrationPackForTests()` below); `null` = read the real file. */
let registrationPackOverride = null;

/**
 * Read the registration pack's two id slots. Synchronous by design: config
 * is computed once per module load, the file is a ~200-line JSON that ships
 * with every function (the same `new URL(..., import.meta.url)` pattern
 * server/ondemand/capability-loop.js already relies on), and a missing or
 * malformed file must degrade to "no pack value" — never throw at import.
 * Returns `{ available, spatialAgentId, spatialToolId }` with `''` for an
 * empty/null slot. Values stay inside this module's state; nothing here
 * logs them.
 */
function readRegistrationPack() {
  if (registrationPackOverride !== null) {
    return normalizeRegistrationPack(registrationPackOverride);
  }
  try {
    const parsed = JSON.parse(readFileSync(REGISTRATION_PACK_URL, 'utf8'));
    return normalizeRegistrationPack(parsed);
  } catch {
    return { available: false, spatialAgentId: '', spatialToolId: '' };
  }
}

/** Extract the two id slots from a parsed registration pack object
 * (see REGISTRATION_ID_ENV.packKeys); anything that is not a non-empty
 * string counts as absent. */
function normalizeRegistrationPack(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return { available: false, spatialAgentId: '', spatialToolId: '' };
  }
  const agentSlot = parsed.ondemand?.agent?.pluginId;
  const capabilities = Array.isArray(parsed.capabilities)
    ? parsed.capabilities
    : [];
  const toolRow = capabilities.find((c) => c && c.id === 'earthquake.search');
  const toolSlot = toolRow ? toolRow.ondemand_tool_id : undefined;
  return {
    available: true,
    spatialAgentId: nonEmpty(agentSlot) ? agentSlot.trim() : '',
    spatialToolId: nonEmpty(toolSlot) ? toolSlot.trim() : '',
  };
}

/**
 * env → registration pack → unset for one registration id row. The env
 * value may be a comma/whitespace-separated list (ONDEMAND_SPATIAL_AGENT_ID
 * already is one for `defaultPluginIds`); the row's single id is the first
 * entry. A value that splits down to nothing (e.g. `" , "`) counts as
 * unset, exactly like `defaultPluginIds`. Returns `{ value, source }` with
 * `source` ∈ REGISTRATION_ID_SOURCES.
 */
function resolveRegistrationId(envName, packValue) {
  const envValue = process.env[envName];
  if (nonEmpty(envValue)) {
    const first = splitIds(envValue)[0];
    if (first) return { value: first, source: 'env' };
  }
  if (nonEmpty(packValue)) {
    return { value: packValue.trim(), source: 'registration-pack' };
  }
  return { value: '', source: 'unset' };
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

/**
 * ALIAS-first / canonical-second / default-last reconciliation — the
 * mirror image of `reconcile()` for the single row (`flowVersion`) whose
 * legacy name is still the one provisioned on the deployment (see
 * FLOW_VERSION_ENV). Same `{ value, source }` contract, same
 * whitespace-only-is-unset rule: a blank alias falls through to the
 * canonical name, a blank canonical falls through to the default.
 *   - alias name set (non-empty)              -> source = aliasName
 *   - canonical name set (non-empty)          -> source = canonicalName
 *   - neither set, `defaultValue !== ''`      -> source = 'default'
 *   - neither set, `defaultValue === ''`      -> source = 'unset'
 */
function reconcileAliasFirst(aliasName, canonicalName, defaultValue) {
  const aliasValue = process.env[aliasName];
  if (nonEmpty(aliasValue)) {
    return { value: aliasValue, source: aliasName };
  }
  const canonicalValue = process.env[canonicalName];
  if (nonEmpty(canonicalValue)) {
    return { value: canonicalValue, source: canonicalName };
  }
  return {
    value: defaultValue,
    source: defaultValue === '' ? 'unset' : 'default',
  };
}

/**
 * Env names of the `flowVersion` row and the order they are consulted in
 * (`reconcileAliasFirst` above). Canonical = the product's own name after
 * the OnDemand Spatial rename; alias = the legacy name that the Vercel
 * project already provisions (env id usC3wgbut65gTkaR). The alias is
 * checked FIRST on purpose so that provisioned value keeps winning until
 * the operator migrates it — flipping this order silently would change a
 * live deployment's reported version label. `order` is exactly the set of
 * values `sources.flowVersion` can take. Surfaced (names only) through
 * `getConfig().flowVersionEnv` and api/ondemand/health.js
 * `config.flowVersion`.
 */
export const FLOW_VERSION_ENV = Object.freeze({
  canonical: 'ONDEMAND_SPATIAL_FLOW_VERSION',
  alias: 'GODS_EYE_FLOW_VERSION',
  order: Object.freeze([
    'GODS_EYE_FLOW_VERSION',
    'ONDEMAND_SPATIAL_FLOW_VERSION',
    'default',
  ]),
});

/**
 * Env names of the `spatialFlowId` row and the order they are consulted
 * in (`reconcile` — CANONICAL first, unlike FLOW_VERSION_ENV above).
 * Canonical = `ONDEMAND_SPATIAL_WORKFLOW_ID` (added 2026-09-18: the
 * OnDemand API calls the object a *workflow* — `POST /workflow/{id}/execute`,
 * contract §7.1 / §18.2 a — so the canonical env name says so too); alias =
 * `ONDEMAND_SPATIAL_FLOW_ID`, the name used since 2026-09-17 and still
 * accepted unchanged. Neither name is provisioned on the Vercel project
 * as of the 2026-09-18 audit (docs/ONDEMAND_PROXY_DESIGN.md §10.1), so the
 * FLOW_DEFAULTS.spatialFlowId constant is what a stock deployment resolves
 * to ('default'). `order` is exactly the set of values
 * `sources.spatialFlowId` can take. Surfaced (names only) through
 * `getConfig().workflowIdEnv` and api/ondemand/health.js
 * `config.spatialFlowId`.
 */
export const WORKFLOW_ID_ENV = Object.freeze({
  canonical: 'ONDEMAND_SPATIAL_WORKFLOW_ID',
  alias: 'ONDEMAND_SPATIAL_FLOW_ID',
  order: Object.freeze([
    'ONDEMAND_SPATIAL_WORKFLOW_ID',
    'ONDEMAND_SPATIAL_FLOW_ID',
    'default',
  ]),
});

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

// Fallback value when ONDEMAND_REASONING_MODE is set but invalid — the
// §17.5 INVESTIGATE reasoning choice / documented default tier. Deliberately
// NOT changed by the 2026-09-18 benchmark re-base (docs/ONDEMAND_PROXY_DESIGN.md
// §10.2 documents this exact fallback); only the `reasoningEndpointId`
// default below moved to `'low'`.
const REASONING_MODE_INVALID_FALLBACK = 'dynamic';

// Default value of `reasoningEndpointId`. OnDemand has no separate
// reasoning endpoint (§12), so this value is the default reasoningMode TIER
// — `'low'` is a documented reasoningMode value (§3.1 "Every body field",
// §12 "Reasoning mode values") and the mode every tier in the 2026-09-18
// benchmark ran with (see TIER_DEFAULTS below). Must be a member of
// DOCUMENTED_REASONING_MODES.
const REASONING_ENDPOINT_DEFAULT_TIER = 'low';

/**
 * Benchmarked per-tier defaults (ASK / INVESTIGATE / DEEP) — constants, not
 * env-reconciled; `fulfillmentEndpointId` here is the `endpointId` sent
 * upstream (§3.1/§12) and `reasoningMode` the documented stream-only field
 * (§3.1/§12; example values `low`, `high`, `grok-4-fast`). Both are
 * documented OnDemand fields; nothing else is derived from a tier.
 *
 * Source: live benchmark 2026-09-18T06:42–06:45Z, recorded in
 * docs/audit/endpoint-benchmark.md — a fixed 3-event USGS earthquake
 * prompt, every candidate HTTP 200, `reasoningMode: 'low'` throughout;
 * "sync" = total wall time of a `responseMode: sync` query, "ttfd" =
 * time-to-first-delta of the same query with `responseMode: stream`:
 *
 *   predefined-gpt-5.6-luna      sync  4,189 ms   ttfd  1,880 ms   593 chars
 *   predefined-gpt-5.6-terra     sync  5,687 ms   ttfd  2,082 ms
 *   predefined-claude-sonnet-5   sync  6,480 ms   ttfd  4,053 ms   1,081 chars
 *                                (richest answer; emits fulfillment_thinking)
 *   predefined-deepseek-v4-pro   sync 14,632 ms   ttfd 11,653 ms
 *   predefined-xai-grok4.6       sync 29,860 ms   ttfd 23,669 ms
 *
 * Choice: ASK = fastest 200 (luna, ttfd < 2 s); INVESTIGATE = richest
 * answer at an acceptable ttfd (claude-sonnet-5, `low`); DEEP = the same
 * strongest verified model with `reasoningMode: 'high'` (the documented
 * "more reasoning detail" value, §3.1) — deepseek-v4-pro and xai-grok4.6
 * were 2–5× slower for no measured quality gain on this prompt. The
 * predefined-id list is documented as volatile (§12), so expect this table
 * to need re-benchmarking; every id here must stay a real, live id.
 */
export const TIER_DEFAULTS = Object.freeze({
  ASK: Object.freeze({
    fulfillmentEndpointId: 'predefined-gpt-5.6-luna',
    reasoningMode: 'low',
  }),
  INVESTIGATE: Object.freeze({
    fulfillmentEndpointId: 'predefined-claude-sonnet-5',
    reasoningMode: 'low',
  }),
  DEEP: Object.freeze({
    fulfillmentEndpointId: 'predefined-claude-sonnet-5',
    reasoningMode: 'high',
  }),
});

/**
 * Non-secret defaults of the Agents Flow Builder workflow this repository
 * owns — "OnDemand Spatial Advanced Workflow", version 1 (blueprint rules
 * 22–23, 46–48). `spatialFlowId` is the real workflow id returned by the
 * documented `POST https://api.on-demand.io/automation/api/workflow/`
 * (HTTP 201, 2026-09-18T07:16:04.335Z, created as "GodsEye Advanced
 * Spatial Workflow") and activated via the documented
 * `POST /workflow/{id}/activate` (HTTP 200, 2026-09-18T07:16:14.101Z); its
 * display name was changed to "OnDemand Spatial Advanced Workflow" on
 * 2026-09-18T10:41:47Z via the documented `PATCH /workflow/{id}/name`
 * (HTTP 200) — the id, version label, trigger and the nine node prompts
 * are unchanged. Definition, export and node→module map:
 * docs/ondemand-workflows/ondemand-spatial-advanced-v1.json and
 * docs/ondemand-workflows/README.md. `flowVersion` is this repository's
 * own version label for that definition (the API has no version field,
 * §7.3) — bump it together with the export whenever the definition
 * changes.
 *
 * Both are the DEFAULT branch of the `ONDEMAND_SPATIAL_WORKFLOW_ID` (alias
 * `ONDEMAND_SPATIAL_FLOW_ID`, canonical checked first — see
 * WORKFLOW_ID_ENV) / `ONDEMAND_SPATIAL_FLOW_VERSION` (alias
 * `GODS_EYE_FLOW_VERSION`, checked first — see FLOW_VERSION_ENV)
 * reconciliation rows (source 'default'); an env var set on the deployment
 * still wins. Re-exported through api/ondemand/_config.js like every other
 * name here.
 */
export const FLOW_DEFAULTS = Object.freeze({
  spatialFlowId: '6aace534859f7b0abb53d99a',
  flowVersion: '1',
});

/**
 * Defaults for one tier by name — case-insensitive (`'deep'`, `'Deep'`,
 * `' DEEP '` all → `TIER_DEFAULTS.DEEP`); anything unknown (or not a
 * string) → `TIER_DEFAULTS.INVESTIGATE`, the balanced middle tier. Returns
 * the frozen constant itself (never a copy), so callers must not mutate.
 */
export function tierDefaults(tier) {
  const key = typeof tier === 'string' ? tier.trim().toUpperCase() : '';
  return Object.prototype.hasOwnProperty.call(TIER_DEFAULTS, key)
    ? TIER_DEFAULTS[key]
    : TIER_DEFAULTS.INVESTIGATE;
}

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
    value: REASONING_MODE_INVALID_FALLBACK,
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

  // No separate "reasoning endpoint" concept exists upstream (§12): this
  // value is the default reasoningMode TIER (`'low'`, documented §3.1/§12)
  // — see the header comment for why it is reconciled independently of
  // `reasoningMode`, sharing ONDEMAND_ENDPOINT_ID as its alias with
  // `fulfillmentEndpointId` below.
  const reasoningEndpointResult = reconcile(
    'ONDEMAND_REASONING_ENDPOINT_ID',
    'ONDEMAND_ENDPOINT_ID',
    REASONING_ENDPOINT_DEFAULT_TIER,
  );

  // `endpointId` of the fulfillment model (§3.1/§12); default = the ASK
  // tier winner of the 2026-09-18 benchmark (TIER_DEFAULTS.ASK, fastest
  // 200: sync 4,189 ms / ttfd 1,880 ms) — ids are volatile per §12, so this
  // default is expected to need revisiting as the predefined list changes.
  const fulfillmentEndpointResult = reconcile(
    'ONDEMAND_FULFILLMENT_ENDPOINT_ID',
    'ONDEMAND_ENDPOINT_ID',
    TIER_DEFAULTS.ASK.fulfillmentEndpointId,
  );

  const reasoningModeResult = reconcileReasoningMode();

  // Workflow id for `POST /workflow/{id}/execute` (§7.1 / §18.2 a).
  // CANONICAL-first (see WORKFLOW_ID_ENV): ONDEMAND_SPATIAL_WORKFLOW_ID,
  // then the accepted alias ONDEMAND_SPATIAL_FLOW_ID. Neither is provisioned
  // on the target Vercel project (2026-09-18 audit), so the default — the
  // real id of the workflow this repo created (FLOW_DEFAULTS) — is what a
  // stock deployment resolves to.
  const spatialFlowResult = reconcile(
    WORKFLOW_ID_ENV.canonical,
    WORKFLOW_ID_ENV.alias,
    FLOW_DEFAULTS.spatialFlowId,
  );

  // Informational only — never sent upstream (§7.3: workflow versioning is
  // NOT FOUND IN LIVE DOCS). String, not number: a version "1" vs 1 has no
  // semantic difference to any consumer, and a string avoids NaN handling.
  // ALIAS-FIRST (the only such row — see FLOW_VERSION_ENV): the legacy
  // GODS_EYE_FLOW_VERSION already provisioned on the Vercel project wins
  // over the canonical ONDEMAND_SPATIAL_FLOW_VERSION until it is migrated.
  const flowVersionResult = reconcileAliasFirst(
    FLOW_VERSION_ENV.alias,
    FLOW_VERSION_ENV.canonical,
    FLOW_DEFAULTS.flowVersion,
  );

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

  // Platform-registration ids (2026-09-19): env NAME → registration pack →
  // unset, per row (see REGISTRATION_ID_ENV / resolveRegistrationId). The
  // agent row reads the SAME env var as `defaultPluginIds` above but is
  // reported separately (with the pack fallback) so health can say where
  // the id would come from; `defaultPluginIds` — what is actually sent
  // upstream as `pluginIds` — deliberately stays env-only (opt-in), so
  // pasting an id into the pack never changes upstream behaviour by itself.
  const registrationPack = readRegistrationPack();
  const spatialAgentIdResult = resolveRegistrationId(
    REGISTRATION_ID_ENV.spatialAgentId,
    registrationPack.spatialAgentId,
  );
  const spatialToolIdResult = resolveRegistrationId(
    REGISTRATION_ID_ENV.spatialToolId,
    registrationPack.spatialToolId,
  );

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
    // Platform-registration ids — VALUES, server-side only (never logged,
    // never serialised into a response; health reports `sources.*` only).
    // `packAvailable` = the paste-back file was readable and parsed.
    registrationIds: {
      spatialAgentId: spatialAgentIdResult.value,
      spatialToolId: spatialToolIdResult.value,
      packAvailable: registrationPack.available,
    },
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
      // 'env' | 'registration-pack' | 'unset' (REGISTRATION_ID_SOURCES) —
      // a source CLASS rather than an env NAME, because the pack is a file.
      spatialAgentId: spatialAgentIdResult.source,
      spatialToolId: spatialToolIdResult.source,
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
  /** Resolved `ONDEMAND_SPATIAL_TOOL_ID` (env → registration pack → '').
   * Server-side only — never log or return it. */
  get spatialToolId() {
    return state.registrationIds.spatialToolId;
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
 * baseUrl/reasoningEndpointId/fulfillmentEndpointId/flowVersion/
 * spatialFlowId/an invalid reasoningMode), or `'unset'` (no default either — the field is simply
 * empty). For `flowVersion` the possible names are exactly
 * FLOW_VERSION_ENV.order ('GODS_EYE_FLOW_VERSION' |
 * 'ONDEMAND_SPATIAL_FLOW_VERSION' | 'default'); for `spatialFlowId` exactly
 * WORKFLOW_ID_ENV.order ('ONDEMAND_SPATIAL_WORKFLOW_ID' |
 * 'ONDEMAND_SPATIAL_FLOW_ID' | 'default'). NAMES ONLY, never values —
 * safe to serialize verbatim in an HTTP response (see
 * api/ondemand/health.js's `?envNames=1`).
 */
export function configSources() {
  return { ...state.sources };
}

/**
 * Single frozen snapshot of every setting above, plus per-family
 * `baseUrls` and the benchmarked `tiers` table (`TIER_DEFAULTS` — the same
 * frozen constant, not a copy). This is the shape any new module should
 * destructure from (e.g. `const { apiKey, baseUrl, fulfillmentEndpointId,
 * spatialFlowId, defaultPluginIds, tiers } = getConfig();`) rather than
 * importing individual getters piecemeal. Asserts (defensively — see
 * assertNoDeniedKeys above) that none of its own keys, or `sources`' keys,
 * are a denied env name.
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
    // Benchmarked ASK/INVESTIGATE/DEEP defaults (constants, never
    // env-reconciled — see TIER_DEFAULTS); ids only, safe to surface.
    tiers: TIER_DEFAULTS,
    // The owned workflow's non-secret defaults (constants — see
    // FLOW_DEFAULTS); the reconciled values are `spatialFlowId` /
    // `flowVersion` above.
    flowDefaults: FLOW_DEFAULTS,
    // Env NAMES (never values) of the alias-first `flowVersion` row and
    // the order they are consulted in — see FLOW_VERSION_ENV.
    flowVersionEnv: FLOW_VERSION_ENV,
    // Env NAMES (never values) of the canonical-first `spatialFlowId` row
    // (ONDEMAND_SPATIAL_WORKFLOW_ID → ONDEMAND_SPATIAL_FLOW_ID → default)
    // and the order they are consulted in — see WORKFLOW_ID_ENV.
    workflowIdEnv: WORKFLOW_ID_ENV,
    // Platform-registration ids (2026-09-19): resolved VALUES (server-side
    // only) plus `packAvailable`; the env NAMES / pack path live in
    // `registrationIdEnv` and the resolved SOURCE class of each row in
    // `sources.spatialAgentId` / `sources.spatialToolId`.
    registrationIds: { ...state.registrationIds },
    registrationIdEnv: REGISTRATION_ID_ENV,
    sources: configSources(),
  };
  assertNoDeniedKeys(result);
  Object.freeze(result.baseUrls);
  Object.freeze(result.registrationIds);
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

/**
 * TEST-ONLY. Replace the parsed registration pack (the object form of
 * src/registry/capabilities.json) that `computeConfig()` consults for the
 * 'registration-pack' fallback — pass `null` to read the real file again.
 * Takes effect on the next `__reloadConfigForTests()`. Never called by
 * production code paths.
 */
export function __setRegistrationPackForTests(pack) {
  registrationPackOverride = pack === undefined ? null : pack;
}
