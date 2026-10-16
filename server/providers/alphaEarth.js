import path from 'node:path';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';

import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { coalesceProxyRequest } from './common/http.js';
import {
  ALPHA_EARTH_ATTRIBUTION,
  ALPHA_EARTH_LICENSE,
} from './alphaEarth/constants.js';
import { createAlphaEarthCatalog } from './alphaEarth/catalog.js';
import { createCogReader } from './alphaEarth/cog.js';
import { computeAlphaEarthChange } from './alphaEarth/change.js';
import {
  alphaEarthChangeKey,
  parseAlphaEarthChangeQuery,
} from './alphaEarth/query.js';

/** Annual layers never change once published; a month bounds dataset revisions. */
const RESULT_TTL_MS = 30 * 24 * 3600_000;
const MEMORY_RESULTS = 24;
/** Each job holds two years of int8 embeddings (≤ 128 MB) while sampling. */
const MAX_RUNNING_JOBS = 2;
const JOB_TIMEOUT_MS = 240_000;

/**
 * AlphaEarth Foundations embedding change (keyless, Source Cooperative mirror).
 *
 * Reads the annual 64-dimension Satellite Embedding COGs by HTTP range,
 * samples two years over a WGS84 box at the finest overview that fits the
 * request's byte budget, and serves the per-pixel `1 − cosine` grid. Results
 * are cached in memory and under `.gev-cache/alpha-earth/` because a box costs
 * tens of megabytes of upstream reads.
 *
 * Routes:
 *   GET /api/alpha-earth/change?west&south&east&north&from&to[&threshold][&detail=standard|high]
 *       → {from,to,west,south,east,north,width,height,pixelMeters,stats,grid,...}
 *   GET /api/alpha-earth/years  → {years, attribution, license}
 *   GET /api/alpha-earth/status → {index, running, cached}
 *
 * @returns {import('vite').Plugin}
 */
export function alphaEarthProxy({
  catalog = createAlphaEarthCatalog(),
  reader = createCogReader(),
  compute = computeAlphaEarthChange,
  cacheDir = path.join(process.cwd(), '.gev-cache', 'alpha-earth'),
  now = () => Date.now(),
  rateLimiter = makeRateLimiter({ windowMs: 60_000, max: 12, globalMax: 60 }),
} = {}) {
  /** @type {Map<string, object>} insertion-ordered LRU of payloads */
  const memory = new Map();
  const inFlight = new Map();
  let running = 0;

  const diskPath = (key) =>
    path.join(
      cacheDir,
      `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`,
    );

  function remember(key, payload) {
    memory.delete(key);
    memory.set(key, payload);
    while (memory.size > MEMORY_RESULTS) {
      memory.delete(memory.keys().next().value);
    }
  }

  async function readDisk(key) {
    try {
      const parsed = JSON.parse(await fsp.readFile(diskPath(key), 'utf8'));
      if (parsed?.key === key && now() - parsed.at < RESULT_TTL_MS) {
        return parsed.payload;
      }
    } catch {
      /* not cached */
    }
    return null;
  }

  async function writeDisk(key, payload) {
    try {
      await fsp.mkdir(cacheDir, { recursive: true });
      await fsp.writeFile(
        diskPath(key),
        JSON.stringify({ key, at: now(), payload }),
        'utf8',
      );
    } catch (err) {
      console.warn('[alpha-earth] cache write failed:', err?.message || err);
    }
  }

  async function run(query, key) {
    running += 1;
    try {
      const payload = await compute({
        ...query,
        catalog,
        reader,
        signal: AbortSignal.timeout(JOB_TIMEOUT_MS),
      });
      const result = {
        ...payload,
        detail: query.detail,
        attribution: ALPHA_EARTH_ATTRIBUTION,
        computedAt: new Date(now()).toISOString(),
      };
      remember(key, result);
      await writeDisk(key, result);
      return result;
    } finally {
      running -= 1;
    }
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/alpha-earth', async (req, res) => {
      const sendJson = (status, obj, cache = 'no-store') => {
        if (res.headersSent) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': cache,
        });
        res.end(JSON.stringify(obj));
      };
      try {
        const url = new URL(req.url, 'http://localhost');
        const subPath = url.pathname;

        if (subPath === '/status') {
          sendJson(200, {
            index: catalog.status(),
            running,
            cached: memory.size,
          });
          return;
        }
        if (subPath === '/years') {
          const years = await catalog.years();
          sendJson(
            200,
            {
              years,
              attribution: ALPHA_EARTH_ATTRIBUTION,
              license: ALPHA_EARTH_LICENSE,
            },
            'public, max-age=3600',
          );
          return;
        }
        if (subPath !== '/change') {
          sendJson(404, { error: 'not_found' });
          return;
        }

        const parsed = parseAlphaEarthChangeQuery(url.searchParams);
        if (!parsed.ok) {
          sendJson(400, { error: 'bad_request', message: parsed.error });
          return;
        }
        const key = alphaEarthChangeKey(parsed.value);
        const cached = memory.get(key) ?? (await readDisk(key));
        if (cached) {
          remember(key, cached);
          sendJson(200, cached, 'public, max-age=86400');
          return;
        }
        if (!inFlight.has(key)) {
          if (!rateLimiter(clientKey(req))) {
            sendJson(429, { error: 'rate_limited' });
            return;
          }
          if (running >= MAX_RUNNING_JOBS) {
            sendJson(503, { error: 'busy', retryAfterMs: 15_000 });
            return;
          }
        }
        const { promise } = coalesceProxyRequest(inFlight, key, () =>
          run(parsed.value, key),
        );
        sendJson(200, await promise, 'public, max-age=86400');
      } catch (err) {
        if (err?.code === 'no_coverage') {
          sendJson(404, { error: 'no_coverage', message: err.message });
          return;
        }
        console.warn('[alpha-earth] error:', err?.message || err);
        const timedOut = err?.name === 'TimeoutError';
        sendJson(timedOut ? 504 : 502, {
          error: timedOut ? 'timeout' : 'upstream_failed',
        });
      }
    });
  };
  return {
    name: 'alpha-earth-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
