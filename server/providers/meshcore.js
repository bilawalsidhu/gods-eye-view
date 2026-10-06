import path from 'node:path';
import { promises as fsp } from 'node:fs';

import { readResponseTextCapped } from './common/http.js';
import { normalizeMeshcoreNodes } from '../../src/data/meshcoreNodes.js';

/**
 * MeshCore public node-map proxy.
 *
 * Upstream: https://map.meshcore.io/api/v1/nodes?short=1 — the same open,
 * keyless JSON feed that powers map.meshcore.io and (per its source, the
 * meshcore-dev/map.meshcore.dev repo) community deployments like
 * cascadiamesh.org/map. MeshCore is a LoRa mesh radio protocol; each record
 * is one node (Client/Repeater/Room Server/Sensor) somewhere on the public
 * mesh, self-reported by its owner. No API key exists for this feed and none
 * is required — it is publicly documented and fetched the same way the
 * official map fetches it.
 *
 * The raw feed is a flat, un-paginated JSON array of ~60k+ verbose records
 * (public key, full msgpack-shaped field names, an embedded meshcore:// deep
 * link per node) — tens of megabytes. This proxy fetches it ONCE per TTL
 * window, trims every record down to only what the globe needs to render and
 * label a point, and serves that compact array to every client from memory.
 * Pattern mirrors firmsProxy: memory + disk cache, TTL, single-flight
 * refresh, serve-stale-on-failure — appropriate here too, since the upstream
 * has no bounding-box query support (unlike Overpass) and a full refetch is
 * the only option, so minimizing how often that happens matters.
 *
 * Routes:
 *   GET /api/meshcore/nodes → {fetchedAt, stale, ttlMs, count, nodes}
 *
 * Never touches OPENAI/AISSTREAM-style secrets — there is nothing to keep
 * server-side here beyond the cache itself; this proxy exists purely to
 * shrink and share one upstream fetch across all connected clients.
 *
 * @returns {import('vite').Plugin}
 */
export function meshcoreProxy() {
  const UPSTREAM_URL = 'https://map.meshcore.io/api/v1/nodes?short=1';
  const TTL_MS = 10 * 60_000; // nodes advertise roughly every 10 min-few hours; matches map.meshcore.io's own freshness buckets (recent <5d)
  const FETCH_TIMEOUT_MS = 30_000;
  const MAX_RESPONSE_BYTES = 90 * 1024 * 1024; // guard rail; observed upstream is ~50MB uncompressed
  const CACHE_DIR = path.join(process.cwd(), '.gev-cache');
  const CACHE_PATH = path.join(CACHE_DIR, 'meshcore.json');

  /** @type {?{at: number, nodes: Array<object>}} */
  let mem = null;
  let diskChecked = false;
  /** @type {?Promise<?{at: number, nodes: Array<object>}>} single-flight refresh */
  let inflight = null;

  async function readDiskOnce() {
    if (diskChecked) return;
    diskChecked = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(CACHE_PATH, 'utf8'));
      if (Number.isFinite(parsed?.at) && Array.isArray(parsed?.nodes)) {
        mem = parsed;
      }
    } catch {
      /* no disk cache yet */
    }
  }

  async function writeDisk(entry) {
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(CACHE_PATH, JSON.stringify(entry), 'utf8');
    } catch (err) {
      console.warn('[meshcore-proxy] cache write failed:', err?.message || err);
    }
  }

  async function refreshUpstream() {
    const res = await fetch(UPSTREAM_URL, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'gods-eye-view-meshcore-proxy/1.0',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await readResponseTextCapped(res, MAX_RESPONSE_BYTES);
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      throw new Error('Unexpected MeshCore upstream payload shape');
    }
    const nodes = normalizeMeshcoreNodes(parsed);
    if (nodes.length === 0) {
      throw new Error('MeshCore upstream returned no usable nodes');
    }
    return { at: Date.now(), nodes };
  }

  function buildPayload(entry, stale) {
    return {
      fetchedAt: entry.at,
      stale,
      ttlMs: TTL_MS,
      count: entry.nodes.length,
      nodes: entry.nodes,
    };
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/meshcore/nodes', async (req, res) => {
      const sendJson = (status, obj) => {
        if (res.headersSent) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(obj));
      };
      try {
        if (req.method !== 'GET') {
          sendJson(405, { error: 'Method Not Allowed' });
          return;
        }
        await readDiskOnce();

        const entry = mem;
        if (entry && Date.now() - entry.at < TTL_MS) {
          sendJson(200, buildPayload(entry, false));
          return;
        }
        // Stale or missing → refresh, single-flight (concurrent requests
        // share one upstream pass, same as firmsProxy).
        if (!inflight) {
          inflight = refreshUpstream()
            .then(async (fresh) => {
              mem = fresh;
              await writeDisk(fresh);
              return fresh;
            })
            .catch((err) => {
              console.warn(
                `[meshcore-proxy] refresh failed (${err?.message || err}) — serving cache if any`,
              );
              return null;
            })
            .finally(() => {
              inflight = null;
            });
        }
        const fresh = await inflight;
        if (fresh) {
          sendJson(200, buildPayload(fresh, false));
        } else if (entry) {
          sendJson(200, buildPayload(entry, true)); // upstream down — stale beats empty
        } else {
          sendJson(502, {
            error: 'meshcore fetch failed and no cache available',
          });
        }
      } catch (err) {
        console.warn('[meshcore-proxy] error:', err?.message || err);
        sendJson(500, { error: 'meshcore proxy error' });
      }
    });
  };

  return {
    name: 'meshcore-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}

export {
  MESHCORE_NODE_TYPE_LABELS,
  normalizeMeshcoreNode,
  normalizeMeshcoreNodes,
} from '../../src/data/meshcoreNodes.js';
