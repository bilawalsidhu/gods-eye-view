// Map tiles for headless QA: the disk cache entry of a tile request and one
// fetch per missing tile, with backoff on HTTP 429, for the free tile hosts
// the QA pages load (OpenStreetMap imagery, the keyless re:earth terrain).
// Back-to-back QA runs otherwise reload the same tiles until those hosts
// rate-limit them. The strict harness (scripts/qa-strict-harness.mjs) pauses
// only the requests to these hosts (CDP Fetch with URL patterns) and answers
// them from the cache in the system temp directory.

import { createHash } from 'node:crypto';
import path from 'node:path';

export const CACHED_TILE_HOSTS = Object.freeze([
  'tile.openstreetmap.org',
  'terrain.reearth.land',
]);
const RETRIES = 4;
/** Who is asking, with a contact URL (the tile hosts' usage policies). */
export const QA_USER_AGENT =
  'gods-eye-view-qa/1 (headless tests with a disk cache; https://github.com/bilawalsidhu/gods-eye-view)';
/** Fetches to the tile hosts in flight at once. */
export const MAX_MISSES_IN_FLIGHT = 2;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The cache entry for a GET of `url` with `accept` (terrain answers by its
 * Accept header), or null for a host that is not cached.
 */
export function tileCacheFile(url, accept, dir, hosts = CACHED_TILE_HOSTS) {
  let host;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    host = parsed.host;
  } catch {
    return null;
  }
  if (!hosts.includes(host)) return null;
  const key = createHash('sha256')
    .update(`${url}\n${accept ?? ''}`)
    .digest('hex')
    .slice(0, 32);
  return path.join(dir, `${host}-${key}`);
}

/**
 * Waits before retry `attempt` (0-based) after a 429: the server's
 * Retry-After in seconds when it sends one (at most 30 s), else 1, 2, 4, 8 s.
 */
export function backoffMs(attempt, retryAfter) {
  const seconds =
    retryAfter == null || retryAfter === '' ? Number.NaN : Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.min(seconds, 30) * 1000;
  return 1000 * 2 ** attempt;
}

/** GETs a tile, retrying on 429; resolves to { status, contentType, body }. */
export async function fetchTile(
  url,
  { accept, fetchImpl = fetch, wait = sleep } = {},
) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetchImpl(url, {
      headers: {
        'User-Agent': QA_USER_AGENT,
        ...(accept ? { Accept: accept } : {}),
      },
    });
    if (response.status !== 429 || attempt >= RETRIES)
      return {
        status: response.status,
        contentType: response.headers.get('content-type'),
        body: Buffer.from(await response.arrayBuffer()),
      };
    await wait(backoffMs(attempt, response.headers.get('retry-after')));
  }
}

/**
 * Loads missing tiles politely: at most MAX_MISSES_IN_FLIGHT fetches at
 * once (the rest queue), and one fetch for identical misses in flight (same
 * URL and Accept). `load(url, accept)` resolves to fetchTile's result.
 */
export function createMissLoader({
  fetchImpl = fetch,
  wait = sleep,
  maxInFlight = MAX_MISSES_IN_FLIGHT,
} = {}) {
  const pending = new Map();
  const queue = [];
  let running = 0;
  const next = () => {
    while (running < maxInFlight && queue.length) {
      const job = queue.shift();
      running++;
      fetchTile(job.url, { accept: job.accept, fetchImpl, wait })
        .then(job.resolve, job.reject)
        .finally(() => {
          running--;
          pending.delete(job.key);
          next();
        });
    }
  };
  return {
    load(url, accept) {
      const key = `${url}\n${accept ?? ''}`;
      let promise = pending.get(key);
      if (!promise) {
        promise = new Promise((resolve, reject) =>
          queue.push({ key, url, accept, resolve, reject }),
        );
        pending.set(key, promise);
        next();
      }
      return promise;
    },
  };
}
