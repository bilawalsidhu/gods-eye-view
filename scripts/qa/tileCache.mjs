// Map tiles for headless QA: a disk cache shared by every run (in the system
// temp directory) and one fetch per missing tile, with backoff on HTTP 429,
// for the free tile hosts the QA pages load (OpenStreetMap imagery, the
// keyless re:earth terrain). Back-to-back QA runs otherwise reload the same
// tiles until those hosts rate-limit them. Only requests to these hosts are
// paused (CDP Fetch with URL patterns); page-wide request interception also
// held the Navara workers' requests and kept workers alive past their globe.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CACHED_TILE_HOSTS = Object.freeze([
  'tile.openstreetmap.org',
  'terrain.reearth.land',
]);
const RETRIES = 4;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The cache entry for a GET of `url` with `accept` (terrain answers by its
 * Accept header), or null for a host that is not cached.
 */
export function tileCacheFile(url, accept, dir) {
  let host;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    host = parsed.host;
  } catch {
    return null;
  }
  if (!CACHED_TILE_HOSTS.includes(host)) return null;
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
        'User-Agent': 'gods-eye-view-qa (headless test, cached)',
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
 * Serves the page's requests to CACHED_TILE_HOSTS from the cache (filling
 * it on a miss). Returns the counts.
 */
export async function installTileCache(
  page,
  { dir = path.join(os.tmpdir(), 'gev-qa-tiles') } = {},
) {
  fs.mkdirSync(dir, { recursive: true });
  const stats = { hits: 0, fetched: 0, cancelled: 0, failed: 0, errors: {} };
  const client = await page.createCDPSession();
  client.on('Fetch.requestPaused', async ({ requestId, request }) => {
    const accept = Object.entries(request.headers ?? {}).find(
      ([name]) => name.toLowerCase() === 'accept',
    )?.[1];
    const file =
      request.method === 'GET' ? tileCacheFile(request.url, accept, dir) : null;
    try {
      if (!file)
        return await client.send('Fetch.continueRequest', { requestId });
      let entry = null;
      if (fs.existsSync(`${file}.json`)) {
        entry = {
          ...JSON.parse(fs.readFileSync(`${file}.json`, 'utf8')),
          body: fs.readFileSync(file),
        };
        stats.hits++;
      } else {
        const tile = await fetchTile(request.url, { accept });
        // Only successes are cached; a 404 (no tile there) is passed on.
        if (tile.status === 200) {
          fs.writeFileSync(file, tile.body);
          fs.writeFileSync(
            `${file}.json`,
            JSON.stringify({ status: 200, contentType: tile.contentType }),
          );
          stats.fetched++;
        } else if (tile.status === 429) stats.failed++;
        entry = tile;
      }
      await client.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: entry.status,
        responseHeaders: [
          ...(entry.contentType
            ? [{ name: 'Content-Type', value: entry.contentType }]
            : []),
          { name: 'Access-Control-Allow-Origin', value: '*' },
        ],
        body: entry.body.toString('base64'),
      });
    } catch (error) {
      // The page dropped the request meanwhile (a tile no longer in view).
      if (/Invalid InterceptionId/.test(String(error?.message))) {
        stats.cancelled++;
        return;
      }
      stats.failed++;
      const reason = String(error?.message ?? error).slice(0, 80);
      stats.errors[reason] = (stats.errors[reason] ?? 0) + 1;
      await client
        .send('Fetch.failRequest', { requestId, errorReason: 'Failed' })
        .catch(() => {});
    }
  });
  await client.send('Fetch.enable', {
    patterns: CACHED_TILE_HOSTS.map((host) => ({
      urlPattern: `https://${host}/*`,
    })),
  });
  return stats;
}
