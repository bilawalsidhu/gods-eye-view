/**
 * Shared dev-proxy infrastructure
 *
 * Extracted verbatim from vite.config.js (Batch 4, PLAN.md) so each
 * endpoint can be unit-tested in isolation; vite.config.js assembles the
 * plugin list from these modules.
 */

// ---------------------------------------------------------------------------
// OpenSky OAuth2 token + response cache state
// ---------------------------------------------------------------------------
/** @type {string|null} Current OAuth2 bearer token. */
export let _openskyToken = null;

/** @type {number} Epoch-ms when the current token expires. */
export let _openskyTokenExpiry = 0;

/** @type {Promise<string|null>|null} In-flight token refresh promise (coalesces concurrent callers). */
export let _openskyTokenPromise = null;

/** @type {boolean} Guards duplicate auth-failure warnings in logs. */
export let _openskyAuthWarned = false;

/**
 * Minimal fixed-window per-key rate limiter for the dev proxies. Not a hard
 * security boundary (dev-only), just a backstop so a runaway client can't hammer
 * the public Overpass / OSRM mirrors or exhaust this process.
 */
export const RATE_LIMITER_MAX_KEYS = 2000;

export function makeRateLimiter({ windowMs, max, globalMax }) {
  const hits = new Map(); // key -> number[] (timestamps within window)
  let globalTimes = []; // all hits in window, for the global backstop
  return function allow(key) {
    const now = Date.now();
    globalTimes = globalTimes.filter((t) => now - t < windowMs);
    if (globalMax && globalTimes.length >= globalMax) return false; // global backstop
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) { hits.set(key, recent); return false; }
    recent.push(now);
    hits.set(key, recent);
    globalTimes.push(now);
    // Hard key cap so a key-rotating caller can't grow the map without bound.
    if (hits.size > RATE_LIMITER_MAX_KEYS) {
      const oldest = hits.keys().next().value;
      if (oldest !== undefined) hits.delete(oldest);
    }
    if (hits.size > 256) {
      for (const [k, v] of hits) {
        if (!v.length || now - v.at(-1) > windowMs) hits.delete(k);
      }
    }
    return true;
  };
}

/**
 * Opt-in per-IP rate limiter for the cost-bearing API proxies (OpenAI / Google).
 * DEFAULT IS UNLIMITED: when the env var is unset, `0`, or non-numeric, this
 * returns `null` and the caller skips the check entirely — a runtime no-op that
 * preserves the original behavior. Only a positive integer N enables a fixed
 * 60s window of N requests/IP (built lazily once, then reused so its per-IP
 * window state persists across requests). The global backstop is set to a
 * generous multiple of the per-IP cap so a single host can't starve the rest.
 *
 * @param {string|undefined} envValue - Raw env value (requests/min/IP).
 * @returns {((key:string)=>boolean)|null} An `allow(key)` fn, or null when unlimited.
 */
export function makeOptInRateLimiter(envValue) {
  const max = Number(envValue);
  if (!Number.isFinite(max) || max <= 0) return null; // unset/0/garbage -> unlimited
  return makeRateLimiter({ windowMs: 60_000, max: Math.floor(max), globalMax: Math.floor(max) * 20 });
}

/**
 * Apply an opt-in limiter to a request, writing a 429 when over the cap.
 * When `limiter` is null (unlimited, the default) this is a no-op returning
 * `true`, so the handler proceeds exactly as before.
 *
 * @param {((key:string)=>boolean)|null} limiter
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @returns {boolean} True if the request may proceed; false if a 429 was sent.
 */
/**
 * Same-site guard — Pages parity with `sameSiteViolation` in
 * `functions/_lib.js`. POSTs carry Origin on every browser request, so a
 * mismatched host is a cross-site drive-by. GETs carry no Origin, so fall
 * back to `Sec-Fetch-Site` (sent by every modern browser on fetch): anything
 * but same-origin/none is rejected. Absent headers = a non-browser client —
 * allowed, throttled instead. Returns the rejection reason, or null to allow.
 */
export function sameSiteViolation(req) {
  const origin = req.headers.origin;
  if (origin) {
    const hostOf = (value) => { try { return new URL(value).host; } catch { return ''; } };
    return hostOf(origin) !== hostOf(`http://${req.headers.host || 'localhost'}`) ? 'cross-origin' : null;
  }
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return 'cross-site';
  return null;
}

/** Reject a same-site violation with this endpoint's JSON error shape. */
export function sendSameSiteRejection(res, extraBody = {}) {
  res.statusCode = 403;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: 'cross-origin requests are rejected', ...extraBody }));
}

/**
 * Client key for rate limiting. Uses the real socket peer address only — we do
 * NOT trust X-Forwarded-For (client-controlled; a rotating value would mint fresh
 * quota and grow the limiter map). This is a localhost dev proxy, so the socket
 * address is the real client.
 */
export function clientKey(req) {
  return String(req.socket?.remoteAddress || 'local');
}

/**
 * Read a fetch() Response body as text with a hard byte cap. Rejects early on an
 * oversized Content-Length, then streams with a running cap so a chunked or
 * length-omitted response cannot blow past the limit. Throws { code:'RESPONSE_TOO_LARGE' }.
 */
export async function readResponseTextCapped(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    const err = new Error('Upstream response too large');
    err.code = 'RESPONSE_TOO_LARGE';
    throw err;
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) {
      const err = new Error('Upstream response too large');
      err.code = 'RESPONSE_TOO_LARGE';
      throw err;
    }
    return text;
  }
  const decoder = new TextDecoder();
  let out = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* no-op */ }
      const err = new Error('Upstream response too large');
      err.code = 'RESPONSE_TOO_LARGE';
      throw err;
    }
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

/** Parse a fetch() JSON response only after enforcing a hard byte cap. */
export async function readResponseJsonCapped(response, maxBytes) {
  return JSON.parse(await readResponseTextCapped(response, maxBytes));
}

/**
 * Return the existing promise for a cache key, or create one and remove it
 * only when that exact promise settles.
 */
export function coalesceProxyRequest(inFlight, key, create) {
  const existing = inFlight.get(key);
  if (existing) return { promise: existing, shared: true };
  const promise = Promise.resolve()
    .then(create)
    .finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return { promise, shared: false };
}

/**
 * Obtain a valid OpenSky OAuth2 bearer token, refreshing if needed.
 *
 * Uses the client_credentials grant against the OpenSky Keycloak realm.
 * Concurrent callers share a single in-flight refresh promise so only
 * one token request is issued at a time.
 *
 * @returns {Promise<string|null>} Bearer token string, or null if unavailable.
 */
export async function getOpenSkyToken() {
  const now = Date.now();
  // Return cached token if still valid (with 60 s safety margin)
  if (_openskyToken && now < _openskyTokenExpiry - 60000) return _openskyToken;

  // Coalesce concurrent refresh requests — if a refresh is already in-flight,
  // return the same promise instead of issuing a duplicate token request
  if (_openskyTokenPromise) return _openskyTokenPromise;

  const clientId = process.env.OPENSKY_CLIENT_ID;
  const clientSecret = process.env.OPENSKY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  // Wrap the async token fetch in a shared promise stored in _openskyTokenPromise
  _openskyTokenPromise = (async () => {
    try {
      const res = await fetch(
        'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`,
        }
      );

      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }

      const accessToken = data?.access_token;
      const expiresIn = Number(data?.expires_in);
      if (!res.ok || !accessToken) {
        if (!_openskyAuthWarned) {
          const detail = data?.error_description || data?.error || `HTTP ${res.status}`;
          console.warn('[OpenSky] OAuth client_credentials failed:', detail);
          _openskyAuthWarned = true;
        }
        _openskyToken = null;
        _openskyTokenExpiry = 0;
        return null;
      }

      _openskyToken = accessToken;
      // Default to 1800 s (30 min) if expires_in is missing or non-finite
      _openskyTokenExpiry = Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 1800) * 1000;
      console.log('[OpenSky] OAuth token refreshed, expires in', Number.isFinite(expiresIn) ? expiresIn : 1800, 's');
      _openskyAuthWarned = false;
      return _openskyToken;
    } catch (err) {
      if (!_openskyAuthWarned) {
        console.warn('[OpenSky] OAuth token request failed:', err?.message || String(err));
        _openskyAuthWarned = true;
      }
      _openskyToken = null;
      _openskyTokenExpiry = 0;
      return null;
    } finally {
      // Clear the shared promise so the next caller can start a fresh refresh
      _openskyTokenPromise = null;
    }
  })();

  return _openskyTokenPromise;
}
