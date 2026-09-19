/**
 * server/providers/common/upstream.js — the ONE upstream-fetch helper every
 * MOVEMENT provider proxy (satellites, flights, military, vessels, traffic)
 * is built on. Added 2026-09-18 after the serverless preview surfaced raw
 * upstream failures to the DATA LAYERS panel ("OpenSky HTTP 502",
 * "adsb.lol HTTP 502", "CelesTrak unreachable").
 *
 *   fetchUpstream(url, options)   fetch with a per-attempt timeout (default
 *                                 10 s), at most `retries` (default 2)
 *                                 jittered retries on network errors, timeouts,
 *                                 429 and 5xx (never on other 4xx), a
 *                                 descriptive User-Agent, gzip accepted, and a
 *                                 hard byte cap on the body. Resolves to
 *                                 { ok, status, headers, text, attempts,
 *                                 elapsedMs, retryAfterMs } — it NEVER throws
 *                                 for an upstream problem; `ok:false` carries
 *                                 `error` ({ code, message }) instead.
 *   providerStatus(fields)        the structured status every proxy reports:
 *                                 { status: 'live'|'stale'|'degraded'|
 *                                 'unavailable', source, fetchedAt, ageSec,
 *                                 error, count, detail }.
 *   statusHeaders(status, cache)  the response headers that carry it —
 *                                 X-Provider-Status / -Source / -Fetched-At /
 *                                 -Age-Sec / -Error — plus the Cache-Control the
 *                                 Vercel edge honours (`s-maxage`,
 *                                 `stale-while-revalidate`) so slow-changing
 *                                 feeds (TLEs) are served from the edge and a
 *                                 failing upstream is bridged by the cached
 *                                 copy.
 *   createLastGoodStore()         per-key last-good memory (value + fetchedAt +
 *                                 source) so a proxy can answer STALE instead
 *                                 of an error for as long as the function
 *                                 instance is warm.
 *   parseRetryAfter(header, now)  seconds or HTTP-date → milliseconds.
 *   jitteredBackoffMs(attempt)    250 ms · 2^attempt with ±50 % jitter,
 *                                 capped at 1.5 s.
 *   bboxAround(lat, lon, deg)     scene bounding box (clamped to the globe).
 *   distanceNm(lat1,lon1,lat2,lon2) great-circle distance in nautical miles
 *                                 (scene-radius filters).
 *
 * Every dependency the tests need to control is injectable: `fetchImpl`
 * (defaults to `globalThis.fetch` read AT CALL TIME so `t.mock.method(
 * globalThis, 'fetch', …)` keeps working), `sleep`, `random`, `now`.
 *
 * Related: server/sources/_shared.js#fetchWithRetry is the Gate 3 source
 * adapters' equivalent (one retry, no jitter). They stay separate on purpose —
 * the source adapters return a documented `{ ok, status, error }` failure
 * shape to the capability loop; this helper feeds browser-facing proxies whose
 * contract is "HTTP 200 with a structured status, never a raw upstream code".
 */

/**
 * Descriptive User-Agent with a contact point (CelesTrak requires one). The
 * version is the package's major.minor (bump with package.json); the repo
 * convention for provider UAs is the same string family as
 * server/providers/overpass/constants.js.
 */
export const PROVIDER_USER_AGENT =
  'ondemand-spatial/0.1 (+https://github.com/bilawalsidhu/gods-eye-view)';

/** The four states a MOVEMENT proxy may report; the UI maps them 1:1. */
export const PROVIDER_STATUSES = Object.freeze([
  'live',
  'stale',
  'degraded',
  'unavailable',
]);

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_RETRIES = 2;
export const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;
const BACKOFF_BASE_MS = 250;
const BACKOFF_CAP_MS = 1_500;
const RETRY_AFTER_CAP_MS = 5_000; // a longer Retry-After is honoured by the caller's cooldown, not by blocking the request

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Parse an HTTP `Retry-After` header (delta-seconds or HTTP-date) into
 * milliseconds from `now`; null when absent or unusable.
 */
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null || value === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.round(seconds * 1000);
  const at = Date.parse(String(value));
  if (Number.isFinite(at) && at > now) return at - now;
  return null;
}

/** Exponential backoff with ±50 % jitter: 250 ms, 500 ms, 1 s … capped at 1.5 s. */
export function jitteredBackoffMs(attempt, random = Math.random) {
  const base = Math.min(
    BACKOFF_CAP_MS,
    BACKOFF_BASE_MS * 2 ** Math.max(0, attempt),
  );
  const jitter = 0.5 + random(); // 0.5 … 1.5
  return Math.round(Math.min(BACKOFF_CAP_MS, base * jitter));
}

function isRetriableStatus(status) {
  return status === 429 || status === 408 || status >= 500;
}

function errorCode(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError')
    return 'timeout';
  const cause = error?.cause;
  const code = String(cause?.code || error?.code || '');
  if (/TIMEOUT/i.test(code)) return 'timeout';
  return 'network';
}

function errorMessage(error) {
  const cause = error?.cause;
  const detail =
    cause?.code || cause?.message || error?.message || 'fetch failed';
  return String(detail).slice(0, 160);
}

/**
 * Read a response body as text with a hard byte cap. Returns
 * { text, tooLarge }. Cancels the stream past the cap.
 */
async function readTextCapped(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try {
      await response.body?.cancel();
    } catch {
      /* ignore */
    }
    return { text: '', tooLarge: true };
  }
  const body = response.body;
  if (!body || typeof body[Symbol.asyncIterator] !== 'function') {
    const text = await response.text();
    return text.length > maxBytes
      ? { text: '', tooLarge: true }
      : { text, tooLarge: false };
  }
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  for await (const chunk of body) {
    total += chunk.length;
    if (total > maxBytes) {
      try {
        await body.cancel();
      } catch {
        /* ignore */
      }
      return { text: '', tooLarge: true };
    }
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  return { text, tooLarge: false };
}

/**
 * Fetch an upstream URL with timeout, bounded jittered retries and a body cap.
 *
 * @param {string|URL} url
 * @param {object} [options]
 * @param {string} [options.method='GET']
 * @param {Record<string,string>} [options.headers]
 * @param {string} [options.body]
 * @param {number} [options.timeoutMs=10000]     per attempt
 * @param {number} [options.retries=2]           extra attempts after the first
 * @param {number} [options.maxBytes]            body cap (bytes)
 * @param {string} [options.accept]              Accept header shorthand
 * @param {AbortSignal} [options.signal]         caller abort — never retried
 * @param {Function} [options.fetchImpl]         defaults to globalThis.fetch at call time
 * @param {Function} [options.sleep]
 * @param {Function} [options.random]
 * @param {Function} [options.now]
 * @param {string} [options.label]               provider name for error text
 * @returns {Promise<{ok:boolean,status:number,headers:Headers|null,text:string,attempts:number,elapsedMs:number,retryAfterMs:number|null,error:{code:string,message:string}|null,url:string}>}
 */
export async function fetchUpstream(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    maxBytes = DEFAULT_MAX_BODY_BYTES,
    accept,
    signal,
    fetchImpl,
    sleep = defaultSleep,
    random = Math.random,
    now = () => Date.now(),
    label = 'upstream',
  } = options;
  const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args));
  const target = String(url);
  const started = now();
  const requestHeaders = {
    'User-Agent': PROVIDER_USER_AGENT,
    'Accept-Encoding': 'gzip, deflate, br',
    ...(accept ? { Accept: accept } : {}),
    ...headers,
  };

  let attempts = 0;
  let lastError = null;
  let lastStatus = 0;
  let lastHeaders = null;
  let lastRetryAfterMs = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) {
      return {
        ok: false,
        status: 0,
        headers: null,
        text: '',
        attempts,
        elapsedMs: now() - started,
        retryAfterMs: null,
        error: { code: 'cancelled', message: `${label} request cancelled` },
        url: target,
      };
    }
    attempts += 1;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(target, {
        method,
        headers: requestHeaders,
        body,
        signal: controller.signal,
        redirect: 'follow',
      });
      lastStatus = response.status;
      lastHeaders = response.headers ?? null;
      lastRetryAfterMs = parseRetryAfter(
        response.headers?.get?.('retry-after') ??
          response.headers?.get?.('x-rate-limit-retry-after-seconds'),
        now(),
      );
      if (response.ok) {
        const { text, tooLarge } = await readTextCapped(response, maxBytes);
        if (tooLarge) {
          return {
            ok: false,
            status: response.status,
            headers: response.headers ?? null,
            text: '',
            attempts,
            elapsedMs: now() - started,
            retryAfterMs: null,
            error: {
              code: 'too_large',
              message: `${label} body exceeded ${maxBytes} bytes`,
            },
            url: target,
          };
        }
        return {
          ok: true,
          status: response.status,
          headers: response.headers ?? null,
          text,
          attempts,
          elapsedMs: now() - started,
          retryAfterMs: null,
          error: null,
          url: target,
        };
      }
      // Non-2xx: drain (bounded) so the socket is reusable, then decide.
      let snippet = '';
      try {
        const { text } = await readTextCapped(response, 4096);
        snippet = text.slice(0, 200);
      } catch {
        /* ignore */
      }
      lastError = {
        code:
          response.status === 429
            ? 'rate_limited'
            : response.status === 401 || response.status === 403
              ? 'auth'
              : response.status >= 500
                ? 'upstream_5xx'
                : 'upstream_4xx',
        message:
          `${label} HTTP ${response.status}${snippet ? ` — ${snippet.replace(/\s+/g, ' ').trim()}` : ''}`.slice(
            0,
            200,
          ),
      };
      const retriable = isRetriableStatus(response.status) && attempt < retries;
      if (!retriable) break;
      const wait = Math.min(
        lastRetryAfterMs ?? jitteredBackoffMs(attempt, random),
        RETRY_AFTER_CAP_MS,
      );
      if (lastRetryAfterMs != null && lastRetryAfterMs > RETRY_AFTER_CAP_MS)
        break; // honour long cooldowns upstream-side, not here
      await sleep(wait);
    } catch (error) {
      if (signal?.aborted) {
        lastError = {
          code: 'cancelled',
          message: `${label} request cancelled`,
        };
        break;
      }
      lastError = {
        code: errorCode(error),
        message:
          `${label} ${errorCode(error) === 'timeout' ? `timed out after ${timeoutMs} ms` : errorMessage(error)}`.slice(
            0,
            200,
          ),
      };
      if (attempt >= retries) break;
      await sleep(jitteredBackoffMs(attempt, random));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
  }

  return {
    ok: false,
    status: lastStatus,
    headers: lastHeaders,
    text: '',
    attempts,
    elapsedMs: now() - started,
    retryAfterMs: lastRetryAfterMs,
    error: lastError || { code: 'network', message: `${label} fetch failed` },
    url: target,
  };
}

/** Convenience: fetchUpstream + JSON.parse; `json` is null when not parseable. */
export async function fetchUpstreamJson(url, options = {}) {
  const result = await fetchUpstream(url, {
    accept: 'application/json',
    ...options,
  });
  let json = null;
  if (result.ok) {
    try {
      json = JSON.parse(result.text);
    } catch {
      return {
        ...result,
        ok: false,
        json: null,
        error: {
          code: 'malformed',
          message: `${options.label || 'upstream'} returned malformed JSON`,
        },
      };
    }
  }
  return { ...result, json };
}

/**
 * The structured status every MOVEMENT proxy reports (body AND headers).
 * `fetchedAt` is when the DATA was obtained from its origin (not when this
 * response was built), so `ageSec` is honest for cached/stale answers.
 */
export function providerStatus({
  status,
  source,
  fetchedAt = null,
  error = null,
  count = null,
  detail = null,
  now = Date.now(),
} = {}) {
  const normalized = PROVIDER_STATUSES.includes(status)
    ? status
    : 'unavailable';
  const fetchedIso =
    fetchedAt == null
      ? null
      : new Date(
          typeof fetchedAt === 'number' ? fetchedAt : fetchedAt,
        ).toISOString();
  const ageSec =
    fetchedIso == null
      ? null
      : Math.max(0, Math.round((now - Date.parse(fetchedIso)) / 1000));
  return {
    status: normalized,
    source: String(source || 'unknown'),
    fetchedAt: fetchedIso,
    ageSec,
    error: error == null ? null : String(error).slice(0, 200),
    count: Number.isFinite(count) ? count : null,
    detail: detail == null ? null : String(detail).slice(0, 200),
  };
}

/** ASCII-only, single-line header value (header fields cannot carry UTF-8). */
function headerSafe(value, max = 200) {
  return String(value)
    .replace(/[\u2012-\u2015\u2212]/g, '-') // en/em dashes, minus → hyphen
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u00b7/g, '-')
    .replace(/[^\x20-\x7e]/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Response headers for a provider status. `cache` controls the edge cache:
 *   { edgeMaxAgeSec, staleWhileRevalidateSec } → `Cache-Control: public,
 *   max-age=0, s-maxage=…, stale-while-revalidate=…`; omit/`null` for
 *   `no-store` (per-view snapshots that must not be shared across clients).
 */
export function statusHeaders(status, cache = null) {
  const headers = {
    'X-Provider-Status': status.status,
    'X-Provider-Source': headerSafe(status.source, 80),
  };
  if (status.fetchedAt) headers['X-Provider-Fetched-At'] = status.fetchedAt;
  if (status.ageSec != null)
    headers['X-Provider-Age-Sec'] = String(status.ageSec);
  if (status.error) headers['X-Provider-Error'] = headerSafe(status.error);
  if (status.count != null) headers['X-Provider-Count'] = String(status.count);
  if (cache && Number.isFinite(cache.edgeMaxAgeSec)) {
    const swr = Number.isFinite(cache.staleWhileRevalidateSec)
      ? `, stale-while-revalidate=${Math.max(0, Math.round(cache.staleWhileRevalidateSec))}`
      : '';
    headers['Cache-Control'] =
      `public, max-age=0, s-maxage=${Math.max(0, Math.round(cache.edgeMaxAgeSec))}${swr}`;
  } else {
    headers['Cache-Control'] = 'no-store';
  }
  return headers;
}

/**
 * Per-key last-good memory. Bounded (LRU-ish by insertion order). Entries
 * carry `fetchedAt` + `source` so a STALE answer can still report its age and
 * provenance. Lives for the life of the warm function instance only.
 */
export function createLastGoodStore({ maxEntries = 32 } = {}) {
  const entries = new Map();
  return {
    get(key) {
      return entries.get(key) || null;
    },
    set(
      key,
      value,
      { fetchedAt = Date.now(), source = null, meta = null } = {},
    ) {
      entries.delete(key);
      entries.set(key, { value, fetchedAt, source, meta });
      while (entries.size > maxEntries) {
        entries.delete(entries.keys().next().value);
      }
      return entries.get(key);
    },
    delete(key) {
      entries.delete(key);
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  };
}

/** Scene bounding box around a point, `degrees` each side, clamped to the globe. */
export function bboxAround(latitude, longitude, degrees = 1.5) {
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const d = Math.max(0.05, Math.min(10, Number(degrees) || 1.5));
  return {
    lamin: Math.max(-90, +(lat - d).toFixed(3)),
    lamax: Math.min(90, +(lat + d).toFixed(3)),
    lomin: Math.max(-180, +(lon - d).toFixed(3)),
    lomax: Math.min(180, +(lon + d).toFixed(3)),
  };
}

/** Great-circle distance in nautical miles. */
export function distanceNm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R_NM = 3440.065;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Parse a finite query number; null when absent/invalid. */
export function queryNumber(searchParams, name) {
  const raw = searchParams?.get?.(name);
  if (raw == null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}
