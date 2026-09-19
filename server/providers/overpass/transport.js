import {
  OVERPASS_MAX_RESPONSE_BYTES,
  OVERPASS_UPSTREAMS,
  OVERPASS_USER_AGENT,
  OVERPASS_TIMEOUT_MS,
  OVERPASS_TOTAL_TIMEOUT_MS,
  overpassMirrorLabel,
} from './constants.js';
import { fetchUpstream, providerStatus } from '../common/upstream.js';
import { readResponseTextCapped } from '../common/http.js';
import { simplifyOverpassPayloadBody } from './geometry.js';

/** Provider name the DATA LAYERS row shows for the OSM road network. */
const OVERPASS_PROVIDER_SOURCE = 'Overpass';

/**
 * Detect whether an Overpass API response body indicates rate-limiting.
 *
 * Checks for known rate-limit phrases in the body text regardless of
 * HTTP status code, since some mirrors return 200 with an error payload.
 *
 * @param {string} bodyText - Upstream response body.
 * @returns {boolean} True if the body looks rate-limited.
 */
function overpassLooksRateLimited(bodyText) {
  const text = String(bodyText || '').toLowerCase();
  return (
    text.includes('rate_limited') ||
    text.includes('quota of your ip address') ||
    text.includes('dispatcher_client::request_read_and_idx::rate_limited') ||
    text.includes('too many requests')
  );
}

/**
 * Detect an Overpass HTTP-200 body that is actually a runtime FAILURE (server-side
 * timeout / out-of-memory) via its `remark`. These are transient upstream failures,
 * not authoritative empty results, so they must not be returned or cached.
 */
function overpassLooksRuntimeError(bodyText) {
  const text = String(bodyText || '').toLowerCase();
  return (
    text.includes('runtime error') ||
    text.includes('timed out') ||
    text.includes('out of memory')
  );
}

/**
 * True only for an upstream response that is actually Overpass data.
 *
 * The proxy caches on this and serves stale on its negation, so the two
 * decisions cannot drift apart: a payload that is not data must never be
 * written to the cache and must always be eligible for a stale replacement.
 * @param {{status: number, rateLimited?: boolean, runtimeError?: boolean}} payload
 * @returns {boolean}
 */
function overpassPayloadIsData(payload) {
  const status = Number(payload?.status);
  return (
    Number.isFinite(status) &&
    status >= 200 &&
    status < 300 &&
    !payload.rateLimited &&
    !payload.runtimeError
  );
}

/**
 * HTTP statuses that mean "this mirror declines this client / is unwell" —
 * the rotation reasons the closeout of 2026-09-19 pins (406, 429, any 5xx),
 * plus 403 and 408 which mirrors use for the same two conditions. Together
 * with network errors and timeouts they make the whole rotation DEGRADED
 * when every mirror ends in one of them. Any other non-2xx (400 parse
 * error, 413/414 oversize) is the QUERY being refused: it still rotates
 * (mirrors disagree on limits), but if every mirror agrees it is reported
 * as that refusal, never dressed up as an outage.
 * @param {number} status
 */
function isMirrorFailureStatus(status) {
  return (
    status === 403 ||
    status === 406 ||
    status === 408 ||
    status === 429 ||
    status >= 500
  );
}

/**
 * Classify one mirror's outcome for the reason string and the rotation
 * decision.
 * @param {{endpoint:string,status:number,code:string,message:string}} f
 * @returns {string} e.g. `HTTP 406`, `timed out after 12 s`, `ECONNRESET`
 */
function describeFailure(f) {
  if (f.code === 'timeout')
    return `timed out after ${Math.round(f.timeoutMs / 1000)} s`;
  if (f.code === 'rate_limited') return 'HTTP 429';
  if (f.code === 'runtime_error')
    return 'runtime error (server-side timeout/memory)';
  if (f.code === 'too_large') return 'response exceeded the byte cap';
  if (f.code === 'body_rate_limited') return 'rate limited (body)';
  if (Number.isFinite(f.status) && f.status > 0) return `HTTP ${f.status}`;
  const raw = String(f.message || 'network error')
    .replace(/^Overpass\s+\S+\s+/, '')
    .trim();
  return raw || 'network error';
}

/**
 * The reason the DATA LAYERS row prints after `DEGRADED · Overpass · `:
 * `all 5 mirrors failed · last: kumi.systems HTTP 406`, or when the rotation
 * ran out of its time budget `3 of 5 mirrors failed, 2 skipped (time budget)
 * · last: private.coffee timed out after 12 s`.
 * @param {Array<object>} failures  one entry per mirror tried
 * @param {number} total            mirrors in the list
 */
function describeRotationFailure(failures, total) {
  const last = failures[failures.length - 1];
  const tail = last ? ` · last: ${last.label} ${describeFailure(last)}` : '';
  if (failures.length >= total) {
    return `all ${total} mirror${total === 1 ? '' : 's'} failed${tail}`;
  }
  const skipped = total - failures.length;
  return `${failures.length} of ${total} mirrors failed, ${skipped} skipped (time budget)${tail}`;
}

/**
 * Try each mirror in order through the shared upstream helper
 * (server/providers/common/upstream.js — per-attempt timeout, body cap,
 * status vocabulary; no per-mirror retries: the NEXT mirror is the retry).
 * Every request carries `User-Agent: <shared provider UA>`,
 * `Accept: application/json` and a form-encoded POST body.
 *
 * Rotation: HTTP 406 / 429 / 5xx (and 403 / 408), rate-limit or runtime-error
 * bodies, oversized bodies, network errors and timeouts all move on to the
 * next mirror; so does any other non-2xx, but that class ("the query was
 * refused") is remembered separately. The whole rotation stops when
 * `totalTimeoutMs` is spent.
 *
 * Outcome:
 *  - first mirror that answers 2xx data → that payload (simplified);
 *  - every mirror refused the QUERY (400-class) → the FIRST refusal payload,
 *    so a genuinely bad query still says what upstream said (never cached:
 *    `overpassPayloadIsData` is false);
 *  - otherwise (every mirror failed for infrastructure reasons, or the budget
 *    ran out) → a non-data payload carrying `provider` =
 *    `{ status: 'degraded', source: 'Overpass', error: <reason> }` and
 *    `failures` (label/status/code per mirror); the proxy turns that into a
 *    structured HTTP 503. A rotation in which EVERY mirror threw at the
 *    network level throws instead (message = the reason), with the same
 *    `provider` attached to the error — the proxy's catch handles both.
 *
 * @param {string} body URL-encoded Overpass QL query body (`data=<query>`).
 * @param {number} [maxResponseBytes] Endpoint-specific response cap.
 * @param {object} [options] Server-only endpoint and I/O overrides for tests.
 * @returns {Promise<{status:number,body:string,contentType:string,endpoint:string,rateLimited:boolean,runtimeError:boolean,provider?:object,failures?:Array<object>}>}
 */
async function fetchOverpassPayload(
  body,
  maxResponseBytes = OVERPASS_MAX_RESPONSE_BYTES,
  {
    endpoints = OVERPASS_UPSTREAMS,
    fetchImpl = fetch,
    readBody = readResponseTextCapped,
    simplify = simplifyOverpassPayloadBody,
    timeoutMs = OVERPASS_TIMEOUT_MS,
    totalTimeoutMs = OVERPASS_TOTAL_TIMEOUT_MS,
    now = () => Date.now(),
    sleep,
  } = {},
) {
  const list = Array.isArray(endpoints) && endpoints.length ? endpoints : [];
  const failures = [];
  let firstQueryRefusal = null;
  let everyMirrorThrew = list.length > 0;
  const startedAt = now();

  // Legacy/test fetch doubles answer `{ status, headers: { get } }` and rely on
  // an injected `readBody`; the shared helper reads real Responses. Normalise
  // whatever the fetch double returns into a Response so ONE code path (the
  // helper's) does the reading, the capping and the timeout.
  const normalisedFetch = async (url, init) => {
    const raw = await fetchImpl(url, init);
    if (typeof Response !== 'undefined' && raw instanceof Response) return raw;
    const text = await readBody(raw, maxResponseBytes);
    return new Response(text, {
      status: Number(raw?.status) || 500,
      headers: {
        'content-type':
          raw?.headers?.get?.('content-type') || 'application/json',
      },
    });
  };

  for (const endpoint of list) {
    const label = overpassMirrorLabel(endpoint);
    const remaining = totalTimeoutMs - (now() - startedAt);
    if (remaining < 250) break; // budget spent — the reason says how many were skipped

    const result = await fetchUpstream(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': OVERPASS_USER_AGENT,
        Accept: 'application/json',
      },
      body,
      timeoutMs: Math.min(timeoutMs, remaining),
      retries: 0,
      maxBytes: maxResponseBytes,
      label: `Overpass ${label}`,
      fetchImpl: normalisedFetch,
      now,
      ...(sleep ? { sleep } : {}),
    });

    const status = Number(result.status) || 0;
    const contentType =
      result.headers?.get?.('content-type') || 'application/json';

    if (result.ok) {
      everyMirrorThrew = false;
      const responseBody = result.text;
      const rateLimited = overpassLooksRateLimited(responseBody);
      const runtimeError = overpassLooksRuntimeError(responseBody);
      if (rateLimited || runtimeError) {
        failures.push({
          endpoint,
          label,
          status,
          code: rateLimited ? 'body_rate_limited' : 'runtime_error',
          message: rateLimited
            ? `Overpass ${label} rate limited (body)`
            : `Overpass runtime error (${endpoint})`,
          timeoutMs,
        });
        continue;
      }
      // Success: decimate giant boundary geometry before it reaches the cache,
      // the disk, or the client (what makes the 32 MB read cap safe to hold).
      return {
        status,
        body: simplify(responseBody),
        contentType,
        endpoint,
        rateLimited: false,
        runtimeError: false,
      };
    }

    const code = result.error?.code || 'network';
    const message = result.error?.message || `Overpass ${label} fetch failed`;
    const networkLevel = code === 'network' || code === 'timeout';
    if (!networkLevel) everyMirrorThrew = false;
    failures.push({ endpoint, label, status, code, message, timeoutMs });

    // A non-2xx that is neither a mirror-health status nor a network problem
    // is the query being refused (400 parse error, 413 body cap, …). Keep the
    // FIRST such answer so, if every mirror agrees, upstream's own words are
    // what the caller sees.
    if (
      status > 0 &&
      code !== 'too_large' &&
      !isMirrorFailureStatus(status) &&
      !firstQueryRefusal
    ) {
      firstQueryRefusal = {
        status,
        // The helper drains a non-2xx body to a short snippet inside its
        // error message; pass that on as text so a parse error stays legible.
        body: String(message || '').replace(/^Overpass\s+\S+\s+/, ''),
        contentType: 'text/plain; charset=utf-8',
        endpoint,
        rateLimited: false,
        runtimeError: false,
      };
    }
  }

  const reason = list.length
    ? describeRotationFailure(failures, list.length)
    : 'no Overpass mirrors configured';
  const degraded = providerStatus({
    status: 'degraded',
    source: OVERPASS_PROVIDER_SOURCE,
    error: reason,
    count: 0,
    now: now(),
  });
  const failureSummary = failures.map((f) => ({
    endpoint: f.endpoint,
    label: f.label,
    status: f.status || null,
    code: f.code,
    detail: describeFailure(f),
  }));

  if (
    firstQueryRefusal &&
    failures.length &&
    failures.every((f) => f.status > 0 && !isMirrorFailureStatus(f.status))
  ) {
    // Every mirror rejected the QUERY itself: report upstream's verdict.
    return { ...firstQueryRefusal, failures: failureSummary };
  }

  if (everyMirrorThrew && list.length) {
    const error = new Error(reason);
    error.provider = degraded;
    error.failures = failureSummary;
    error.code = 'OVERPASS_ALL_MIRRORS_UNREACHABLE';
    throw error;
  }

  const last = failures[failures.length - 1];
  return {
    status: last?.status || 503,
    body: '',
    contentType: 'application/json',
    endpoint: last?.endpoint || list[list.length - 1] || 'unknown',
    rateLimited: failures.some(
      (f) => f.code === 'rate_limited' || f.code === 'body_rate_limited',
    ),
    runtimeError: failures.some((f) => f.code === 'runtime_error'),
    provider: degraded,
    failures: failureSummary,
  };
}

export {
  OVERPASS_PROVIDER_SOURCE,
  describeRotationFailure,
  isMirrorFailureStatus,
  overpassPayloadIsData,
  fetchOverpassPayload,
};
