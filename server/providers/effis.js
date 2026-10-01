// server/providers/effis.js
//
// Layer decision (Task 0, corrected 2026-09-29 during Task 1 implementation):
// ms:effis.nrt.ba.poly is the ENTIRE EFFIS archive (13.3M features) and 502s
// on any unbounded request — it is not a recent/rolling window despite the
// "nrt" name. Using ms:modis.ba.poly.week instead: 162 features (live-verified
// 2026-09-29), genuinely time-windowed, and — unlike effis.nrt.ba.poly — its
// DescribeFeatureType has a real attribute schema (FIREDATE, AREA_HA, COUNTRY,
// PROVINCE, COMMUNE, land-cover fields). Both AREA_HA and FIREDATE are
// schema-optional (minOccurs="0"), so a missing value on some feature is a
// real, expected case — normalizeEffisFeatureCollection returns null for it,
// not a sign something is broken.
import path from 'node:path';
import { promises as fsp } from 'node:fs';

/** Hard cap on upstream features per snapshot (WFS COUNT and normalized rows). */
export const MAX_FEATURES = 2000;
/** Hard cap on the upstream response body, in bytes (8 MiB). */
export const MAX_BYTES = 8 * 1024 * 1024;

const WFS_URL =
  'https://maps.effis.emergency.copernicus.eu/effis?MAP=/mnt/nfs/mapfiles/effis.map&SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=ms:modis.ba.poly.week&OUTPUTFORMAT=GEOJSON' +
  `&COUNT=${MAX_FEATURES}`;

/**
 * Read a fetch Response body as text, refusing anything over `maxBytes`.
 * A declared Content-Length over the cap is rejected before reading; otherwise
 * the stream is counted chunk by chunk and cancelled as soon as it overflows,
 * so an oversized upstream can never be buffered whole.
 * @param {Response} res
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
async function readBodyCapped(res, maxBytes) {
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel?.().catch(() => {});
    throw new Error('response_too_large');
  }
  if (!res.body?.getReader) {
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes)
      throw new Error('response_too_large');
    return text;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error('response_too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

/** Compute a polygon's centroid as a simple coordinate average (good enough for a marker anchor, not for area). */
function centroidOf(ring) {
  let sumLon = 0;
  let sumLat = 0;
  for (const [lon, lat] of ring) {
    sumLon += lon;
    sumLat += lat;
  }
  return [sumLon / ring.length, sumLat / ring.length];
}

/** Validate + flatten one EFFIS GetFeature response. Never throws; drops malformed features. */
export function normalizeEffisFeatureCollection(geojson) {
  if (!Array.isArray(geojson?.features)) return [];
  const rows = [];
  for (const [index, feature] of geojson.features.entries()) {
    const geometry = feature?.geometry;
    if (geometry?.type !== 'Polygon') continue;
    const ring = geometry.coordinates?.[0];
    if (!Array.isArray(ring) || ring.length < 4) continue;
    const validRing = ring.every(
      (pt) =>
        Array.isArray(pt) &&
        Number.isFinite(pt[0]) &&
        Math.abs(pt[0]) <= 180 &&
        Number.isFinite(pt[1]) &&
        Math.abs(pt[1]) <= 90,
    );
    if (!validRing) continue;
    const [lon, lat] = centroidOf(ring);
    const properties = feature.properties || {};
    const areaHa =
      properties.AREA_HA === '' || properties.AREA_HA == null
        ? NaN
        : Number(properties.AREA_HA);
    rows.push({
      // Live EFFIS features have no top-level `id`, but carry a unique,
      // stable `properties.id`; the positional id is a last resort.
      id:
        feature.id != null
          ? String(feature.id)
          : properties.id != null
            ? String(properties.id)
            : `effis-ba-${index + 1}`,
      lon,
      lat,
      polygon: ring,
      areaHa: Number.isFinite(areaHa) ? areaHa : null,
      fireDate:
        typeof properties.FIREDATE === 'string' ? properties.FIREDATE : null,
    });
  }
  return rows;
}

/**
 * Copernicus EFFIS burnt-area proxy (past-week window, ms:modis.ba.poly.week —
 * NOT ms:effis.nrt.ba.poly, which is the unbounded 13.3M-feature archive),
 * cached because the upstream ("EFFIS - OGC/WFS Test Service" per its own
 * capabilities doc) is slow (2s-60s+ observed) and occasionally returns 502.
 * No API key: EFFIS's own WFS capabilities state `Fees: none`,
 * `AccessConstraints: None`.
 *
 * Routes:
 *   GET /api/effis/burnt-areas → {fetchedAt, stale, ttlMs, count, truncated, areas}
 *
 * Bounded snapshot: the WFS request carries COUNT=MAX_FEATURES, the body is
 * read with a MAX_BYTES cap (over cap → failure, stale cache served if any),
 * and normalized rows are capped at MAX_FEATURES. `truncated` is true when the
 * upstream hit the COUNT cap or rows were cut, so the client can say so.
 *
 * @returns {import('vite').Plugin}
 */
export function effisBurntAreasProxy() {
  const TTL_MS = 60 * 60_000;
  const CACHE_DIR = path.join(process.cwd(), '.gev-cache');
  const CACHE_PATH = path.join(CACHE_DIR, 'effis-burnt-areas.json');

  /** @type {?{at: number, truncated?: boolean, areas: Array<object>}} */
  let mem = null;
  /** @type {?Promise<void>} memoized so concurrent cold-start callers share one read */
  let diskReadPromise = null;
  /** @type {?Promise<?{at: number, areas: Array<object>}>} single-flight refresh */
  let inflight = null;

  function readDiskOnce() {
    diskReadPromise ??= (async () => {
      try {
        const parsed = JSON.parse(await fsp.readFile(CACHE_PATH, 'utf8'));
        // Never let the disk copy replace a newer in-memory entry.
        if (
          Number.isFinite(parsed?.at) &&
          Array.isArray(parsed?.areas) &&
          (!mem || parsed.at > mem.at)
        )
          mem = parsed;
      } catch {
        /* no disk cache yet */
      }
    })();
    return diskReadPromise;
  }

  async function writeDisk(entry) {
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(CACHE_PATH, JSON.stringify(entry), 'utf8');
    } catch (err) {
      console.warn('[effis-proxy] cache write failed:', err?.message || err);
    }
  }

  async function refresh() {
    const res = await fetch(WFS_URL, { signal: AbortSignal.timeout(90_000) });
    if (!res.ok) throw new Error(`EFFIS HTTP ${res.status}`);
    const geojson = JSON.parse(await readBodyCapped(res, MAX_BYTES));
    // A 200 that isn't a FeatureCollection (MapServer exception, HTML error
    // page as JSON, …) is a failure — throw so getFresh keeps the previous
    // cache (served stale) instead of caching an empty "healthy" result.
    // A valid FeatureCollection with zero features is still a real result.
    if (!Array.isArray(geojson?.features))
      throw new Error('invalid_feature_collection');
    const normalized = normalizeEffisFeatureCollection(geojson);
    const areas = normalized.slice(0, MAX_FEATURES);
    const truncated =
      geojson.features.length >= MAX_FEATURES ||
      areas.length < normalized.length;
    const entry = { at: Date.now(), truncated, areas };
    await writeDisk(entry);
    return entry;
  }

  async function getFresh() {
    await readDiskOnce();
    const age = mem ? Date.now() - mem.at : Infinity;
    if (mem && age < TTL_MS) return { entry: mem, stale: false };
    if (!inflight) {
      inflight = refresh()
        .then((entry) => {
          mem = entry;
          return entry;
        })
        .finally(() => {
          inflight = null;
        });
    }
    try {
      const entry = await inflight;
      return { entry, stale: false };
    } catch (err) {
      if (mem) {
        console.warn(
          '[effis-proxy] refresh failed, serving stale:',
          err?.message || err,
        );
        return { entry: mem, stale: true };
      }
      throw err;
    }
  }

  function installMiddleware(server) {
    server.middlewares.use('/api/effis/burnt-areas', async (req, res) => {
      try {
        const { entry, stale } = await getFresh();
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            fetchedAt: entry.at,
            stale,
            ttlMs: TTL_MS,
            count: entry.areas.length,
            truncated: entry.truncated === true,
            areas: entry.areas,
          }),
        );
      } catch (err) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'upstream_unavailable' }));
      }
    });
  }

  return {
    name: 'effis-burnt-areas-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
