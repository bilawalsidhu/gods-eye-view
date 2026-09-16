import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { fetchRegionalJson } from './regional/http.js';
import { coalesceProxyRequest } from './common/http.js';

const RAINVIEWER_API_URL =
  'https://api.rainviewer.com/public/weather-maps.json';
const RAINVIEWER_CACHE_MS = 10 * 60_000;
const RAINVIEWER_STALE_MS = 30 * 60_000;
const RAINVIEWER_MAX_CACHE = 10;
const TILE_MAX_BYTES = 512 * 1024;

const _rainViewerCache = new Map();
const _rainViewerInFlight = new Map();
const _tileInFlight = new Map();

const _rainViewerRateLimiter = makeRateLimiter({
  windowMs: 60_000,
  max: 60,
  globalMax: 200,
});

function trimRainViewerCache() {
  while (_rainViewerCache.size > RAINVIEWER_MAX_CACHE) {
    const oldest = _rainViewerCache.keys().next().value;
    if (oldest === undefined) break;
    _rainViewerCache.delete(oldest);
  }
}

async function fetchRainViewerMetadata() {
  const payload = await fetchRegionalJson(RAINVIEWER_API_URL, {
    maxBytes: 256 * 1024,
  });
  return payload;
}

function weatherRadarProxy() {
  async function refreshMetadata(key) {
    const metadata = await fetchRainViewerMetadata();
    if (!metadata?.radar?.past?.length)
      throw new Error('RainViewer metadata unavailable');
    const frames = metadata.radar.past;
    const host = metadata.host || 'https://tilecache.rainviewer.com';
    const payload = {
      status: 'ready',
      retrievedAt: new Date().toISOString(),
      host,
      frames: frames.map((frame, index) => ({
        index,
        time: frame.time,
        path: frame.path,
      })),
      latestIndex: frames.length - 1,
    };
    _rainViewerCache.set(key, { payload, cachedAt: Date.now() });
    trimRainViewerCache();
    return payload;
  }

  async function proxyTile(
    req,
    res,
    { host, framePath, size, z, x, y, color, options },
  ) {
    const tileUrl = `${host}${framePath}/${size}/${z}/${x}/${y}/${color}/${options}.png`;
    const tileKey = `${framePath}/${size}/${z}/${x}/${y}/${color}/${options}`;

    const request = coalesceProxyRequest(_tileInFlight, tileKey, async () => {
      const response = await fetch(tileUrl);
      if (!response.ok)
        throw new Error(`Tile fetch failed: ${response.status}`);
      const arrayBuffer = await response.arrayBuffer();
      if (arrayBuffer.byteLength > TILE_MAX_BYTES)
        throw new Error('Tile too large');
      return {
        buffer: Buffer.from(arrayBuffer),
        contentType: response.headers.get('content-type') || 'image/png',
        cacheControl:
          response.headers.get('cache-control') || 'public, max-age=300',
      };
    });

    try {
      const tile = await request.promise;
      res.writeHead(200, {
        'Content-Type': tile.contentType,
        'Cache-Control': tile.cacheControl,
        'X-RainViewer-Tile': request.shared ? 'INFLIGHT' : 'MISS',
      });
      res.end(tile.buffer);
    } catch {
      res.writeHead(503, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ error: 'Radar tile temporarily unavailable' }));
    }
  }

  function install(middlewares) {
    middlewares.use('/api/weather-radar/metadata', async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return;
      }
      if (!_rainViewerRateLimiter(clientKey(req))) {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'Retry-After': '10',
        });
        res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
        return;
      }

      const key = 'global';
      const now = Date.now();
      const cached = _rainViewerCache.get(key);
      if (cached && now - cached.cachedAt <= RAINVIEWER_CACHE_MS) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60',
          'X-RainViewer': 'HIT',
        });
        res.end(JSON.stringify({ ...cached.payload, status: 'cached' }));
        return;
      }

      const request = coalesceProxyRequest(_rainViewerInFlight, key, () =>
        refreshMetadata(key),
      );
      try {
        const payload = await request.promise;
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60',
          'X-RainViewer': request.shared ? 'INFLIGHT' : 'MISS',
        });
        res.end(JSON.stringify(payload));
      } catch {
        if (cached && now - cached.cachedAt <= RAINVIEWER_STALE_MS) {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'X-RainViewer': 'STALE',
          });
          res.end(JSON.stringify({ ...cached.payload, status: 'stale' }));
          return;
        }
        res.writeHead(503, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(
          JSON.stringify({
            error: 'Weather radar metadata temporarily unavailable',
          }),
        );
      }
    });

    middlewares.use('/api/weather-radar/tile', async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return;
      }

      const url = new URL(req.url || '', 'http://localhost');
      const host = url.searchParams.get('host');
      const framePath = url.searchParams.get('framePath');
      const size = url.searchParams.get('size') || '256';
      const z = url.searchParams.get('z');
      const x = url.searchParams.get('x');
      const y = url.searchParams.get('y');
      const color = url.searchParams.get('color') || '2';
      const options = url.searchParams.get('options') || '1_1';

      if (!host || !framePath || !z || !x || !y) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing required tile parameters' }));
        return;
      }

      const zNum = parseInt(z, 10);
      const xNum = parseInt(x, 10);
      const yNum = parseInt(y, 10);
      const sizeNum = parseInt(size, 10);
      const clampedZ = Math.min(zNum, 7);

      if (
        !Number.isFinite(zNum) ||
        zNum < 0 ||
        !Number.isFinite(xNum) ||
        xNum < 0 ||
        !Number.isFinite(yNum) ||
        yNum < 0 ||
        ![256, 512].includes(sizeNum)
      ) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid tile parameters' }));
        return;
      }

      // Proxy tile using clampedZ to ensure RainViewer always has valid data
      await proxyTile(req, res, {
        host,
        framePath,
        size: sizeNum,
        z: clampedZ,
        x: xNum,
        y: yNum,
        color,
        options,
      });
    });
  }

  return {
    name: 'weather-radar-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

export { weatherRadarProxy };
