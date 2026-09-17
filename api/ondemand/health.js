/**
 * api/ondemand/health.js — GET/HEAD /api/ondemand/health. ALWAYS HTTP 200.
 *
 * Contract reference: docs/ONDEMAND_API_CURRENT.md
 *   §2.2 List sessions   — chat probe:     GET {chat}/sessions?limit=1
 *   §5.3 Fetch media     — media probe:    GET {media}?page=1&limit=1
 *   §7.1 List workflows  — workflow probe: GET {automation}/workflow/?limit=1
 *   §6   Services API — NO documented read-only probe exists for STT/TTS;
 *        a real call would incur cost, so `speech` is reported 'degraded'
 *        (key present) / 'not configured' (key absent) without ever calling
 *        the Services API.
 *   §8   GET /plugin/v1/list is guide-only (not in the OpenAPI reference
 *        set). This handler does NOT call it by default — see
 *        docs/ONDEMAND_PROXY_DESIGN.md for the tradeoff; `plugins` simply
 *        reports the configured ONDEMAND_SPATIAL_AGENT_ID as 'not probed'.
 *
 * Roll-up rule for `ondemand` (this proxy's own documented mapping, since
 * the contract defines no such aggregate field): 'healthy' when the chat
 * probe is healthy; otherwise the WORST status among {chat, media,
 * workflow, speech} using severity order error > degraded > healthy. Chat's
 * own (non-healthy) status is included in that worst-of set in the `else`
 * branch — a broken chat probe must not be hidden behind healthier probes.
 *
 * Debug flag `?envNames=1` (added 2026-09-17 for the ondemand-eand-spatial
 * Vercel project — see docs/ONDEMAND_PROXY_DESIGN.md §5b): adds an `env`
 * object to the JSON body — `{ names, sources }` — reporting which env var
 * NAMES beginning with ONDEMAND_ or VITE_ (plus SERVERLESS_MODE, VERCEL,
 * VERCEL_ENV) exist on this deployment, and which NAME supplied each
 * logical config setting. NAMES ONLY; no env var value is ever included.
 * The default response shape (flag absent) is unchanged, and the
 * ALWAYS-200 / 'not configured' semantics above apply identically whether
 * or not the flag is present.
 */

import {
  config,
  baseUrls,
  isConfigured,
  configSources,
} from '../../server/ondemand/config.js';
import { ondemandFetch } from '../../server/ondemand/client.js';
import {
  assertMethod,
  rejectCrossOrigin,
  getRequestUrl,
} from '../../server/ondemand/http.js';

const ENV_NAME_PATTERN =
  /^(ONDEMAND_|VITE_|SERVERLESS_MODE$|VERCEL$|VERCEL_ENV$)/;

/** Names only, never values — see the `?envNames=1` header comment above. */
function envNamesDiagnostic() {
  return {
    names: Object.keys(process.env)
      .filter((k) => ENV_NAME_PATTERN.test(k))
      .sort(),
    sources: configSources(),
  };
}

const PROBE_TIMEOUT_MS = 5000;
const SEVERITY = ['error', 'degraded', 'not configured', 'healthy']; // lower index = worse

export default async function handler(req, res) {
  if (rejectCrossOrigin(req, res)) return;
  if (!assertMethod(req, res, ['GET', 'HEAD'])) return;

  const checkedAt = new Date().toISOString();
  const requestUrl = getRequestUrl(req);
  const envNamesRequested = requestUrl.searchParams.get('envNames') === '1';

  if (!isConfigured()) {
    const notConfiguredBody = {
      ondemand: 'not configured',
      chat: 'not configured',
      speech: 'not configured',
      media: 'not configured',
      workflow: 'not configured',
      plugins: {},
      configured: false,
      checkedAt,
      message:
        'ONDEMAND_API_KEY is not set. Set it in the Vercel project Environment Variables (or in .env for local dev) and redeploy/restart.',
    };
    if (envNamesRequested) notConfiguredBody.env = envNamesDiagnostic();
    finish(req, res, 200, notConfiguredBody);
    return;
  }

  const verbose = requestUrl.searchParams.get('verbose') === '1';

  const [chatProbe, mediaProbe, workflowProbe] = await Promise.all([
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
  ]);

  const speechDetail =
    'no read-only probe documented for the Services API (§6); a real STT/TTS call would incur cost, so it is not attempted. Verify the subscription in the OnDemand dashboard.';
  const speech = { status: 'degraded', detail: speechDetail };

  const plugins = {};
  if (config.spatialAgentId) {
    plugins[config.spatialAgentId] = 'not probed'; // GET /plugin/v1/list is guide-only (§8); not called by default
  }

  const ondemand = rollUp({
    chat: chatProbe.status,
    media: mediaProbe.status,
    workflow: workflowProbe.status,
    speech: speech.status,
  });

  const body = {
    ondemand,
    chat: chatProbe.status,
    speech: speech.status,
    media: mediaProbe.status,
    workflow: workflowProbe.status,
    plugins,
    configured: true,
    checkedAt,
    message: messageFor(ondemand),
  };

  const errored = [
    ['chat', chatProbe],
    ['media', mediaProbe],
    ['workflow', workflowProbe],
  ].filter(([, p]) => p.status === 'error');

  if (verbose) {
    body.details = {
      chat: detailOf(chatProbe),
      media: detailOf(mediaProbe),
      workflow: detailOf(workflowProbe),
      speech: { detail: speechDetail },
    };
  } else if (errored.length > 0) {
    // Surface *why* even outside verbose mode so an operator isn't blind to
    // an invalid-key/network failure.
    body.details = Object.fromEntries(
      errored.map(([name, p]) => [name, { detail: p.detail }]),
    );
  }

  if (envNamesRequested) body.env = envNamesDiagnostic();

  finish(req, res, 200, body);
}

function detailOf({ status, ...rest }) {
  return rest;
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
