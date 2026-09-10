// functions/api/celestrak/[[path]].js
/**
 * `/api/celestrak/<group>` — Cloudflare Pages Function.
 *
 * Production counterpart of the dev middleware in `vite.config.js`
 * (celestrakProxy). CelesTrak 403s browser CORS requests outright, so the
 * client fetches same-origin TLE text: `/api/celestrak/stations`,
 * `/api/celestrak/gps-ops`, `/api/celestrak/starlink`,
 * `/api/celestrak/active` (see `src/data/satellites.js` and
 * `src/data/rocketLaunches.js`).
 *
 * ROUTE SHAPE — optional catch-all (`[[path]]`), not `[group]` and not a bare
 * `celestrak.js`, because the dev middleware is mounted as a Connect *prefix*
 * (`use('/api/celestrak', …)`) and therefore also answers the bare
 * `/api/celestrak` mount with `400 invalid group`. An optional catch-all is
 * the only Pages file shape that reproduces both that and `/api/celestrak/<group>`.
 * The group is read from the still-percent-encoded request pathname, exactly
 * as the dev middleware reads the raw (un-decoded) Connect `req.url`, so
 * `/api/celestrak/%41ctive` is rejected here just as it is in dev.
 *
 * Contract (identical to dev — `Content-Type: text/plain` on EVERY response,
 * including errors; the body is raw TLE text, never JSON):
 *   GET  /api/celestrak/<group>  → 200 TLE text + `x-tle-cache: HIT|MISS`
 *   stale entry + upstream down  → 200 stale TLE + `x-tle-cache: STALE-ERROR`
 *   upstream down + no entry     → 502 'celestrak fetch failed and no cache
 *                                   available' + `x-tle-cache: NONE`
 *   group outside /^[a-z0-9-]+$/i → 400 'invalid group' (no cache header)
 *   unexpected throw             → 500 'celestrak proxy error: …' + `x-tle-cache: ERROR`
 *
 * The upstream guard `/^1 /m` is contract, not decoration: a CelesTrak error
 * page or rate-limit notice arrives as HTTP 200 with zero TLE lines, and
 * caching that would blank the satellite layer for six hours.
 *
 * Caching: 6 h TTL, single-flight per group (concurrent misses share one
 * upstream request, so 6 catalog groups loading at once cost one fetch each).
 * The dev middleware ALSO mirrors the cache to `.gev-cache/celestrak-<group>.json`
 * so it survives a dev-server restart. Workers have no writable filesystem, so
 * the disk tier has no analogue here: the cache is per-isolate memory, which
 * means an isolate that has just been recycled has no stale fallback and
 * answers 502 until one upstream request succeeds. Everything else — TTL,
 * single-flight, stale-on-error, status codes, headers — is identical.
 *
 * Honest note: the `500` branch is defensive. `fetchUpstream` failures are
 * absorbed into the single-flight promise (`null`), so nothing in the happy
 * path is observed to reach it on either runtime.
 */
const MOUNT = '/api/celestrak';
/** TLE freshness window (ms) — CelesTrak regenerates GP data a few times a day. */
const TLE_TTL_MS = 6 * 3600_000;

/** @type {Map<string, {at: number, body: string}>} group -> cached TLE text. */
const mem = new Map();
/** @type {Map<string, Promise<{at: number, body: string}|null>>} single-flight per group. */
const inflight = new Map();

async function fetchUpstream(group) {
  const url = new URL('https://celestrak.org/NORAD/elements/gp.php');
  url.searchParams.set('GROUP', group);
  url.searchParams.set('FORMAT', 'tle');
  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(20_000),
    // CelesTrak 403s bulk groups (e.g. `active`) unless the request carries a
    // descriptive User-Agent with a contact point.
    headers: { 'User-Agent': 'gods-eye-view-celestrak-proxy/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.text();
  // An upstream error page parses to zero TLEs — treat as failure, keep cache.
  if (!/^1 /m.test(body)) throw new Error('no TLE lines in response');
  return { at: Date.now(), body };
}

function send(status, body, cacheStatus) {
  const headers = { 'Content-Type': 'text/plain' };
  // The 400 validates the group before any cache exists, so it carries no
  // cache header — same as dev.
  if (cacheStatus) headers['x-tle-cache'] = cacheStatus;
  return new Response(body, { status, headers });
}

export async function onRequest(context) {
  const { request } = context;

  // The dev middleware receives Connect's prefix-stripped `req.url`
  // (`/stations?x=1`); `pathname` is the same string minus the query, and
  // still percent-encoded, so the same validation applies.
  const group = new URL(request.url).pathname.slice(MOUNT.length).replace(/^\//, '').split('?')[0];
  if (!/^[a-z0-9-]+$/i.test(group)) {
    return send(400, 'invalid group', null);
  }

  try {
    const now = Date.now();
    const entry = mem.get(group);
    if (entry && now - entry.at < TLE_TTL_MS) {
      return send(200, entry.body, 'HIT');
    }
    // Stale or missing → refresh, single-flight per group.
    if (!inflight.has(group)) {
      inflight.set(group, fetchUpstream(group)
        .then((fresh) => {
          mem.set(group, fresh);
          return fresh;
        })
        .catch((err) => {
          console.warn(`[celestrak-proxy] ${group} refresh failed (${err?.message || err}) — serving cache if any`);
          return null;
        })
        .finally(() => inflight.delete(group)));
    }
    const fresh = await inflight.get(group);
    if (fresh) {
      return send(200, fresh.body, 'MISS');
    }
    if (entry) {
      return send(200, entry.body, 'STALE-ERROR'); // upstream down — stale beats empty
    }
    return send(502, 'celestrak fetch failed and no cache available', 'NONE');
  } catch (err) {
    return send(500, `celestrak proxy error: ${err?.message || err}`, 'ERROR');
  }
}
