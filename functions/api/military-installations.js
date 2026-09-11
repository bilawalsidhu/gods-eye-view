// functions/api/military-installations.js
/**
 * Cloudflare Pages Function — `/api/military-installations`
 *
 * The production counterpart of the dev middleware in `vite.config.js`
 * (militaryInstallationsProxy). This narrow endpoint deliberately does not
 * expose arbitrary Overpass QL to the browser: it accepts only a validated
 * bbox and answers the exact payload shape the client
 * (`src/data/militaryInstallations.js`) consumes.
 *
 * History: the previous `military-installations.ts` read a `bbox` query param
 * the client has never sent (it sends `south/west/north/east`), so every
 * production request 400'd — the layer was dead on Pages while working in
 * dev. It also embedded its own query with a 100-element cap and no caching.
 * Deleted; this implementation shares the policy module with dev instead.
 *
 * Contract (identical to dev):
 *   405 {error:'Method Not Allowed'}
 *   429 {error:'Rate limit exceeded'} + Retry-After: 5
 *   400 {error:'A non-dateline bbox no larger than 10 degrees is required'}
 *   200 {elements, saturated, elementCap, retrievedAt, status} with
 *       `X-Military-Installations: HIT|INFLIGHT|MISS|STALE` and
 *       `Cache-Control: public, max-age=60` (stale answers: no-store)
 *   503 {error:'Mapped installation context is temporarily unavailable'}
 *
 * Shared keying with dev: the bbox is snapped OUTWARD onto a 0.05° grid
 * (neighbouring viewports share one entry; an outward snap always covers what
 * was asked), and `exact=1` opts out — the client re-asks for its exact
 * viewport after a SATURATED snapped answer. Exact and snapped answers are
 * keyed separately so they never collide.
 *
 * Honest runtime difference: dev adds a 30-day disk tier (restart survival)
 * and serves memory-stale at ANY age once the disk fallback also misses;
 * workerd has no `fs`, so Pages serves memory-stale at any age as the final
 * degraded tier instead. CORS is deliberately unset, matching dev.
 */
import { clientKey, makeRateLimiter } from '../_lib.js';
import {
  buildMilitaryInstallationsQuery,
  fetchOverpassPayload,
  militaryInstallationCacheKey,
  MILITARY_INSTALLATION_ELEMENT_CAP,
  quantizeMilitaryInstallationBox,
  validMilitaryInstallationBox,
} from '../../src/data/overpassPolicy.js';
import { coalesceRequest } from '../_upstream.js';

const CACHE_MS = 5 * 60_000;
const MAX_CACHE = 80;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** Dev limiter limits: 90/min per client, 300/min global backstop. */
let rateLimiter = makeRateLimiter({ windowMs: 60_000, max: 90, globalMax: 300 });

/** @type {Map<string,{payload:object,cachedAt:number}>} */
const installationCache = new Map();
/** @type {Map<string,Promise>} */
const inFlight = new Map();

/** Test-only: clear every module-level cache so tests start cold. */
export function resetMilitaryInstallationsStateForTest() {
  installationCache.clear();
  inFlight.clear();
  rateLimiter = makeRateLimiter({ windowMs: 60_000, max: 90, globalMax: 300 });
}

function trimCache() {
  while (installationCache.size > MAX_CACHE) {
    const oldest = installationCache.keys().next().value;
    if (oldest === undefined) break;
    installationCache.delete(oldest);
  }
}

function jsonWith(status, body, headers) {
  return new Response(JSON.stringify(body), { status, headers });
}

async function refresh(box, _key) {
  const upstream = await fetchOverpassPayload(
    buildMilitaryInstallationsQuery(box, MILITARY_INSTALLATION_ELEMENT_CAP),
    MAX_RESPONSE_BYTES,
  );
  if (upstream.status >= 400 || upstream.rateLimited || upstream.runtimeError) {
    throw new Error('Mapped installation upstream unavailable');
  }
  const parsed = JSON.parse(upstream.body);
  const elements = Array.isArray(parsed?.elements)
    ? parsed.elements.slice(0, MILITARY_INSTALLATION_ELEMENT_CAP)
    : [];
  return {
    elements,
    // Honest truncation flag — the client re-asks for its exact viewport so
    // off-view features can never starve in-view ones. The cap travels with
    // the payload so the client never has to hard-code it.
    saturated: elements.length >= MILITARY_INSTALLATION_ELEMENT_CAP,
    elementCap: MILITARY_INSTALLATION_ELEMENT_CAP,
    retrievedAt: new Date().toISOString(),
    status: 'ready',
  };
}

export async function onRequest({ request }) {
  if (request.method !== 'GET') {
    return jsonWith(405, { error: 'Method Not Allowed' }, {
      'Content-Type': 'application/json; charset=utf-8',
    });
  }
  if (!rateLimiter(clientKey(request))) {
    return jsonWith(429, { error: 'Rate limit exceeded' }, {
      'Content-Type': 'application/json; charset=utf-8',
      'Retry-After': '5',
    });
  }

  const requested = validMilitaryInstallationBox(new URL(request.url).searchParams);
  if (!requested) {
    return jsonWith(400, { error: 'A non-dateline bbox no larger than 10 degrees is required' }, {
      'Content-Type': 'application/json; charset=utf-8',
    });
  }

  // Query the SNAPPED box, not the raw viewport (see module docblock).
  const exact = new URL(request.url).searchParams.get('exact') === '1';
  const box = exact ? requested : quantizeMilitaryInstallationBox(requested);
  // Key at the precision the query actually uses (see militaryInstallationCacheKey).
  const key = exact
    ? `exact:${militaryInstallationCacheKey(box, 5)}`
    : militaryInstallationCacheKey(box);

  const now = Date.now();
  const cached = installationCache.get(key);
  if (cached && now - cached.cachedAt <= CACHE_MS) {
    return jsonWith(200, { ...cached.payload, status: 'cached' }, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
      'X-Military-Installations': 'HIT',
    });
  }

  const { promise, shared } = coalesceRequest(inFlight, key, () => refresh(box, key));
  try {
    const payload = await promise;
    if (!shared) {
      installationCache.set(key, { payload, cachedAt: Date.now() });
      trimCache();
    }
    return jsonWith(200, payload, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
      'X-Military-Installations': shared ? 'INFLIGHT' : 'MISS',
    });
  } catch {
    // Overpass is down: last-good mapped context at ANY age beats an empty
    // layer (Pages' degraded-tier substitute for dev's serve-stale disk).
    if (cached) {
      return jsonWith(200, { ...cached.payload, status: 'stale' }, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Military-Installations': 'STALE',
      });
    }
    return jsonWith(503, { error: 'Mapped installation context is temporarily unavailable' }, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  }
}
