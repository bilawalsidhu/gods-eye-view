/**
 * api/ondemand/health.js — GET/HEAD /api/ondemand/health. ALWAYS HTTP 200.
 *
 * Contract reference: docs/ONDEMAND_API_CURRENT.md
 *   §2.2 List sessions   — chat probe:     GET {chat}/sessions?limit=1
 *   §5.3 Fetch media     — media probe:    GET {media}?page=1&limit=1
 *   §7.1 List workflows  — workflow probe: GET {automation}/workflow/?limit=1
 *   §6.2 Text → audio    — speech probe:   POST {services}/execute/text_to_speech
 *        body `{ input: 'ok', model: 'tts-1', voice: 'alloy' }` — all three
 *        are documented §6.2 request fields (defaults spelled out
 *        explicitly). Superseded rationale (until 2026-09-18): "no
 *        read-only probe exists for the Services API, so `speech` is a
 *        hard-coded 'degraded'". The Services API still has no read-only
 *        endpoint, but a one-token TTS synthesis measured ~3.0 s live
 *        (200, `data.audioUrl`) and is cheap enough to run ONCE per warm
 *        instance per 10 minutes — see "Speech probe" below.
 *   §8   GET /plugin/v1/list is guide-only (not in the OpenAPI reference
 *        set). This handler does NOT call it by default — see
 *        docs/ONDEMAND_PROXY_DESIGN.md for the tradeoff; `plugins` simply
 *        reports the configured ONDEMAND_SPATIAL_AGENT_ID as 'not probed'.
 *
 * The three read-only probes time out at PROBE_TIMEOUT_MS (3000ms); the
 * speech probe has its own SPEECH_PROBE_TIMEOUT_MS (4500ms — a synthesis
 * call, ~3.0 s live). All four run in parallel via Promise.all, so the
 * handler's worst case is ~4.5 s — still well under typical serverless
 * function limits.
 *
 * Speech probe (added 2026-09-18, docs/ONDEMAND_PROXY_DESIGN.md §10.6):
 *   - 2xx AND the documented envelope carries `data.audioUrl` → 'healthy'
 *     (the URL itself is never echoed in the response);
 *   - 2xx without `data.audioUrl`, or any other non-2xx status → 'degraded'
 *     (detail carries the status);
 *   - 401/403 → 'error' ("invalid key"), exactly like the other probes;
 *   - timeout → 'degraded' (NOT 'error' — TTS is a synthesis call, not a
 *     read-only probe, so a slow synthesis is not evidence of an outage);
 *   - any other network failure → 'error'.
 *   A SUCCESSFUL probe is cached per warm instance for
 *   SPEECH_PROBE_CACHE_MS (10 minutes; module-level `{ at, status, … }`),
 *   so health does not synthesize audio on every call; non-healthy
 *   outcomes are never cached (the next call re-probes). Every keyed
 *   response exposes `speechProbe: { cached: boolean, ageSec: number }`
 *   (`ageSec` = age of the cached result, 0 for a fresh probe). The unkeyed
 *   ("not configured") response runs no probe and carries no `speechProbe`.
 *
 * Roll-up rule for `ondemand` (this proxy's own documented mapping, since
 * the contract defines no such aggregate field): 'healthy' when the chat
 * probe is healthy; otherwise the WORST status among {chat, media,
 * workflow, speech} using severity order error > degraded > healthy. Chat's
 * own (non-healthy) status is included in that worst-of set in the `else`
 * branch — a broken chat probe must not be hidden behind healthier probes.
 *
 * Config diagnostic (added 2026-09-18 — see
 * docs/ONDEMAND_PROXY_DESIGN.md "Environment name reconciliation
 * (2026-09-18)"): every response (keyed or not) carries a top-level
 * `config` object — one entry per reconciled setting — `{ configured,
 * source }` (`reasoningMode` also adds `valid`), where `source` is the env
 * NAME that resolved the value, or `'default'`/`'unset'` — NEVER a value.
 * A top-level `reasoningModeInvalid: boolean` mirrors `config.reasoningMode
 * .valid` for a quick single-field check. Neither field is gated on
 * `configured`: an invalid ONDEMAND_REASONING_MODE is worth surfacing even
 * with no API key set. `config.tiers` (added 2026-09-18) is the
 * benchmarked ASK/INVESTIGATE/DEEP table from `getConfig().tiers` — model
 * ids and reasoningMode names only, never a value read from the env.
 * `config.flowVersion` (extended for the OnDemand Spatial rename) is
 * `{ configured, source, resolvedVia, canonical, alias }`: `source` is the
 * env NAME that won ('GODS_EYE_FLOW_VERSION' | 'ONDEMAND_SPATIAL_FLOW_VERSION'
 * | 'default'), `resolvedVia` classifies it as 'alias' | 'canonical' |
 * 'default', and `canonical`/`alias` echo the two NAMES from
 * `getConfig().flowVersionEnv` — that row is reconciled ALIAS-FIRST (the
 * legacy name is the one provisioned on the Vercel project), and this is
 * where an operator sees which one is live. Still names only, never the
 * value.
 *
 * Debug flag `?envNames=1` (added 2026-09-17 for the ondemand-eand-spatial
 * Vercel project — see docs/ONDEMAND_PROXY_DESIGN.md §5b): adds an `env`
 * object to the JSON body — `{ names, sources }` — reporting which env var
 * NAMES beginning with ONDEMAND_ or VITE_ (plus GODS_EYE_FLOW_VERSION — the
 * accepted alias of ONDEMAND_SPATIAL_FLOW_VERSION — SERVERLESS_MODE, VERCEL,
 * VERCEL_ENV) exist on this deployment, and which NAME supplied each
 * logical config setting. NAMES ONLY; no env var value is ever included.
 * `names` also excludes the deny-listed env var names (see DENIED_ENV_NAMES
 * below) even when they are present in process.env — this route must never
 * confirm their existence, let alone a value. The default response shape
 * (flag absent) is unchanged, and the ALWAYS-200 / 'not configured'
 * semantics above apply identically whether or not the flag is present.
 */

import { getConfig, baseUrls, isConfigured } from './_config.js';
import { ondemandFetch } from '../../server/ondemand/client.js';
import {
  assertMethod,
  rejectCrossOrigin,
  getRequestUrl,
} from '../../server/ondemand/http.js';

// GODS_EYE_FLOW_VERSION is the accepted (alias-first) alias of
// ONDEMAND_SPATIAL_FLOW_VERSION — listed by name so `?envNames=1` shows the
// legacy name is what is provisioned, not just that "something" resolved.
const ENV_NAME_PATTERN =
  /^(ONDEMAND_|VITE_|GODS_EYE_FLOW_VERSION$|SERVERLESS_MODE$|VERCEL$|VERCEL_ENV$)/;

// DENY-LIST — see server/ondemand/config.js's header comment and
// docs/ONDEMAND_PROXY_DESIGN.md "Environment name reconciliation
// (2026-09-18)". Built from parts (never a literal) so this file itself
// never contains either denied string — server/ondemand/deny-list.test.mjs
// greps non-test source files for them.
const DENIED_ENV_NAMES = [
  ['ELEVENLABS', 'API', 'KEY'].join('_'),
  ['ONDEMAND', 'KNOWLEDGE', 'PLUGIN', 'IDS'].join('_'),
];

/** Names only, never values — see the `?envNames=1` header comment above.
 * `sources` is passed in by the caller (already computed via getConfig())
 * so this request only calls getConfig() once. */
function envNamesDiagnostic(sources) {
  return {
    names: Object.keys(process.env)
      .filter((k) => ENV_NAME_PATTERN.test(k))
      .filter((k) => !DENIED_ENV_NAMES.includes(k))
      .sort(),
    sources,
  };
}

/**
 * `{ configured, source }` per reconciled setting (`reasoningMode` also
 * gets `valid`) — `source` is an env NAME or 'default'/'unset', never a
 * value. `configured` is simply "did something other than 'unset' resolve
 * this field" — true for every setting that has a built-in default
 * (baseUrl, reasoningEndpointId, fulfillmentEndpointId, flowVersion) and
 * conditional for the three that don't (apiKey, reasoningMode,
 * spatialFlowId). Plus `tiers`: the benchmarked ASK/INVESTIGATE/DEEP
 * defaults (`getConfig().tiers` — constants; ids only, nothing from env).
 */
function configDiagnostic(cfg) {
  const src = cfg.sources;
  const notUnset = (name) => src[name] !== 'unset';
  return {
    tiers: cfg.tiers,
    apiKey: { configured: notUnset('apiKey') },
    baseUrl: { configured: notUnset('baseUrl'), source: src.baseUrl },
    reasoningEndpointId: {
      configured: notUnset('reasoningEndpointId'),
      source: src.reasoningEndpointId,
    },
    fulfillmentEndpointId: {
      configured: notUnset('fulfillmentEndpointId'),
      source: src.fulfillmentEndpointId,
    },
    reasoningMode: {
      configured: notUnset('reasoningMode'),
      source: src.reasoningMode,
      valid: !cfg.reasoningModeInvalid,
    },
    flowVersion: {
      configured: notUnset('flowVersion'),
      source: src.flowVersion,
      resolvedVia: flowVersionResolvedVia(src.flowVersion, cfg.flowVersionEnv),
      canonical: cfg.flowVersionEnv.canonical,
      alias: cfg.flowVersionEnv.alias,
    },
    spatialFlowId: {
      configured: notUnset('spatialFlowId'),
      source: src.spatialFlowId,
    },
  };
}

/** 'alias' | 'canonical' | 'default' — derived from the env NAME in
 * `sources.flowVersion` against `getConfig().flowVersionEnv` (names only). */
function flowVersionResolvedVia(source, flowVersionEnv) {
  if (source === flowVersionEnv.alias) return 'alias';
  if (source === flowVersionEnv.canonical) return 'canonical';
  return 'default';
}

const PROBE_TIMEOUT_MS = 3000;
// TTS is a synthesis call (~3.0 s live, 2026-09-18), not a read-only probe —
// it gets its own, longer budget than the three GET probes above.
const SPEECH_PROBE_TIMEOUT_MS = 4500;
// A successful speech probe is reused per warm instance for this long, so
// health does not synthesize audio on every call.
const SPEECH_PROBE_CACHE_MS = 10 * 60 * 1000;
// Contract §6.2 request fields, and nothing else: `input` (required),
// `model` (enum, default tts-1), `voice` (enum, default alloy).
const SPEECH_PROBE_BODY = Object.freeze({
  input: 'ok',
  model: 'tts-1',
  voice: 'alloy',
});
const SPEECH_TIMEOUT_DETAIL =
  'speech probe timed out (>4.5 s); TTS is a synthesis call, not a read-only probe';
const SEVERITY = ['error', 'degraded', 'not configured', 'healthy']; // lower index = worse

/** Module-level (= per warm instance) memo of the last SUCCESSFUL speech
 * probe: `{ at, status, httpStatus, latencyMs }` or null. Only 'healthy'
 * outcomes are stored — see the header comment. */
let speechProbeCache = null;

/** TEST-ONLY — clears the per-instance speech probe memo so
 * server/ondemand/handlers.test.mjs can exercise the fresh-probe and
 * cached branches in one process. Never called by production code. */
export function __resetSpeechProbeCacheForTests() {
  speechProbeCache = null;
}

export default async function handler(req, res) {
  if (rejectCrossOrigin(req, res)) return;
  if (!assertMethod(req, res, ['GET', 'HEAD'])) return;

  const checkedAt = new Date().toISOString();
  const requestUrl = getRequestUrl(req);
  const envNamesRequested = requestUrl.searchParams.get('envNames') === '1';
  const cfg = getConfig();

  if (!isConfigured()) {
    const notConfiguredBody = {
      ondemand: 'not configured',
      chat: 'not configured',
      speech: 'not configured',
      media: 'not configured',
      workflow: 'not configured',
      plugins: {},
      configured: false,
      reasoningModeInvalid: cfg.reasoningModeInvalid,
      config: configDiagnostic(cfg),
      checkedAt,
      message:
        'ONDEMAND_API_KEY is not set. Set it in the Vercel project Environment Variables (or in .env for local dev) and redeploy/restart.',
    };
    if (envNamesRequested)
      notConfiguredBody.env = envNamesDiagnostic(cfg.sources);
    finish(req, res, 200, notConfiguredBody);
    return;
  }

  const verbose = requestUrl.searchParams.get('verbose') === '1';

  // Order matters for the stubbed-fetch tests (calls are consumed in
  // invocation order): chat, media, workflow, then speech — the speech
  // probe is skipped entirely (no fetch) while its cached success is fresh.
  const [chatProbe, mediaProbe, workflowProbe, speech] = await Promise.all([
    probe(() =>
      ondemandFetch(`${baseUrls().chat}/sessions?limit=1`, {
        method: 'GET',
        timeoutMs: PROBE_TIMEOUT_MS,
      }),
    ),
    probe(() =>
      ondemandFetch(`${baseUrls().media}?page=1&limit=1`, {
        method: 'GET',
        timeoutMs: PROBE_TIMEOUT_MS,
      }),
    ),
    probe(() =>
      ondemandFetch(`${baseUrls().automation}/workflow/?limit=1`, {
        method: 'GET',
        timeoutMs: PROBE_TIMEOUT_MS,
      }),
    ),
    speechProbe(),
  ]);

  const plugins = {};
  if (cfg.spatialAgentId) {
    plugins[cfg.spatialAgentId] = 'not probed'; // GET /plugin/v1/list is guide-only (§8); not called by default
  }

  const ondemand = rollUp({
    chat: chatProbe.status,
    media: mediaProbe.status,
    workflow: workflowProbe.status,
    speech: speech.status,
  });

  // `cached`/`ageSec` are reported under `speechProbe`, not `details`.
  const { cached, ageSec, ...speechResult } = speech;

  const body = {
    ondemand,
    chat: chatProbe.status,
    speech: speech.status,
    media: mediaProbe.status,
    workflow: workflowProbe.status,
    plugins,
    configured: true,
    speechProbe: { cached, ageSec },
    reasoningModeInvalid: cfg.reasoningModeInvalid,
    config: configDiagnostic(cfg),
    checkedAt,
    message: messageFor(ondemand),
  };

  const errored = [
    ['chat', chatProbe],
    ['media', mediaProbe],
    ['workflow', workflowProbe],
    ['speech', speechResult],
  ].filter(([, p]) => p.status === 'error');

  if (verbose) {
    body.details = {
      chat: detailOf(chatProbe),
      media: detailOf(mediaProbe),
      workflow: detailOf(workflowProbe),
      speech: detailOf(speechResult),
    };
  } else {
    // Surface *why* even outside verbose mode so an operator isn't blind to
    // an invalid-key/network failure — and, for speech only, to a
    // 'degraded' outcome too (its detail — timeout vs. an upstream status —
    // is the whole point of running a synthesis probe).
    const surfaced = Object.fromEntries(
      errored.map(([name, p]) => [name, { detail: p.detail }]),
    );
    if (speechResult.status === 'degraded') {
      surfaced.speech = { detail: speechResult.detail };
      if (speechResult.httpStatus !== undefined)
        surfaced.speech.httpStatus = speechResult.httpStatus;
    }
    if (Object.keys(surfaced).length > 0) body.details = surfaced;
  }

  if (envNamesRequested) body.env = envNamesDiagnostic(cfg.sources);

  finish(req, res, 200, body);
}

function detailOf({ status, ...rest }) {
  return rest;
}

/**
 * Real (but rate-limited) Services API probe — see "Speech probe" in the
 * header comment for the status mapping. Resolves to
 * `{ status, detail?, httpStatus?, latencyMs?, cached, ageSec }`; never
 * rejects, never includes the synthesized `audioUrl`.
 */
async function speechProbe() {
  const now = Date.now();
  if (speechProbeCache && now - speechProbeCache.at < SPEECH_PROBE_CACHE_MS) {
    const { at, ...memo } = speechProbeCache;
    return { ...memo, cached: true, ageSec: Math.floor((now - at) / 1000) };
  }

  const fresh = { cached: false, ageSec: 0 };
  const started = Date.now();
  try {
    const response = await ondemandFetch(
      `${baseUrls().services}/execute/text_to_speech`,
      {
        method: 'POST',
        body: { ...SPEECH_PROBE_BODY },
        timeoutMs: SPEECH_PROBE_TIMEOUT_MS,
      },
    );
    const latencyMs = Date.now() - started;
    const httpStatus = response.status;
    if (httpStatus === 401 || httpStatus === 403) {
      return {
        status: 'error',
        detail: 'invalid key',
        httpStatus,
        latencyMs,
        ...fresh,
      };
    }
    if (!response.ok) {
      return {
        status: 'degraded',
        detail: `text_to_speech returned HTTP ${httpStatus}`,
        httpStatus,
        latencyMs,
        ...fresh,
      };
    }
    let envelope = null;
    try {
      envelope = await response.json(); // {message, data:{audioUrl}} (§6.2)
    } catch {
      envelope = null;
    }
    const audioUrl = envelope?.data?.audioUrl;
    if (typeof audioUrl !== 'string' || audioUrl.length === 0) {
      return {
        status: 'degraded',
        detail: `text_to_speech returned HTTP ${httpStatus} without data.audioUrl (§6.2 envelope)`,
        httpStatus,
        latencyMs,
        ...fresh,
      };
    }
    speechProbeCache = {
      at: Date.now(),
      status: 'healthy',
      httpStatus,
      latencyMs,
    };
    return { status: 'healthy', httpStatus, latencyMs, ...fresh };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    if (timedOut) {
      return {
        status: 'degraded',
        detail: SPEECH_TIMEOUT_DETAIL,
        latencyMs,
        ...fresh,
      };
    }
    return { status: 'error', detail: 'network error', latencyMs, ...fresh };
  }
}

async function probe(makeRequest) {
  const started = Date.now();
  try {
    const response = await makeRequest();
    const latencyMs = Date.now() - started;
    if (response.status === 401 || response.status === 403) {
      return {
        status: 'error',
        detail: 'invalid key',
        httpStatus: response.status,
        latencyMs,
      };
    }
    if (response.ok) {
      return { status: 'healthy', httpStatus: response.status, latencyMs };
    }
    return { status: 'degraded', httpStatus: response.status, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'error',
      detail: timedOut ? 'timeout' : 'network error',
      latencyMs,
    };
  }
}

function rollUp(statuses) {
  if (statuses.chat === 'healthy') return 'healthy';
  let worst = 'healthy';
  for (const status of Object.values(statuses)) {
    if (SEVERITY.indexOf(status) < SEVERITY.indexOf(worst)) worst = status;
  }
  return worst;
}

function messageFor(ondemand) {
  switch (ondemand) {
    case 'healthy':
      return 'OnDemand API reachable; chat probe succeeded.';
    case 'degraded':
      return 'OnDemand API reachable but at least one probe returned a non-success status; see details.';
    case 'error':
      return 'An OnDemand probe failed (invalid key or network error); see details.';
    default:
      return 'OnDemand health status computed.';
  }
}

function finish(req, res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(JSON.stringify(body));
}
