import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { decodeFireGrid } from './goes/fireGrid.js';
import {
  readResponseTextCapped,
  readResponseBytesCapped,
} from '../../src/sources/httpBody.js';

/**
 * Keyless NOAA GOES-R ABI fire/hot-spot proxy.
 *
 * The `ABI-L2-FDCF` product lives in the public `noaa-goes18`/`noaa-goes19`
 * AWS Open Data buckets: anonymous access, no API key, not requester-pays. The
 * rows are emitted in the same shape the FIRMS proxy returns so the fire layer
 * and its adapter are shared unchanged.
 */

const SATELLITES = {
  goes19: { number: '19', name: 'GOES-19', bucket: 'noaa-goes19' },
  goes18: { number: '18', name: 'GOES-18', bucket: 'noaa-goes18' },
};

const PRODUCT_PREFIX = 'ABI-L2-FDCF';
const TTL_MS = 10 * 60_000; // the ABI full-disk scan cadence
const LOOKBACK_HOURS = 6;
const MAX_GRANULE_BYTES = 16 * 1024 * 1024;
const CACHE_VERSION = 1;

/** UTC day-of-year, the `DDD` segment of the S3 key. */
export function dayOfYear(date) {
  const startOfYear = Date.UTC(date.getUTCFullYear(), 0, 1);
  return Math.floor((date.getTime() - startOfYear) / 86_400_000) + 1;
}

/** Hour prefix for one satellite; the granule itself is never guessed. */
export function listPrefix(date) {
  const year = date.getUTCFullYear();
  const day = String(dayOfYear(date)).padStart(3, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  return `${PRODUCT_PREFIX}/${year}/${day}/${hour}/`;
}

export function buildListUrl(bucket, date) {
  const prefix = listPrefix(date);
  return `https://${bucket}.s3.amazonaws.com/?list-type=2&prefix=${prefix}&max-keys=1000`;
}

export function buildObjectUrl(bucket, key) {
  return `https://${bucket}.s3.amazonaws.com/${key}`;
}

/**
 * Newest granule for a satellite. The `s<timestamp>` segment of the key is the
 * scan start and does not land on a 10-minute boundary, so the key is listed
 * rather than derived from the clock; empty hours walk backwards.
 */
export async function latestGranuleKey(bucket, now, fetchImpl) {
  for (let hoursBack = 0; hoursBack <= LOOKBACK_HOURS; hoursBack += 1) {
    const at = new Date(now - hoursBack * 3_600_000);
    const signal = AbortSignal.timeout(15_000);
    const response = await fetchImpl(buildListUrl(bucket, at), { signal });
    if (!response.ok) continue;
    const xml = await readResponseTextCapped(response, 1024 * 1024, signal);
    const expected = `${PRODUCT_PREFIX}/`;
    const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)]
      .map((m) => m[1])
      .filter((key) => key.startsWith(expected) && key.endsWith('.nc'));
    if (keys.length) return keys[keys.length - 1];
  }
  return null;
}

/** Confidence tier derived from DQF — NOT the FIRMS confidence category. */
function confidenceTier(mask) {
  if ([10, 11, 30, 31].includes(Number(mask))) return 'h';
  if ([13, 33].includes(Number(mask))) return 'n';
  if ([14, 15, 34, 35].includes(Number(mask))) return 'l';
  return null;
}

function toRows(grid, satelliteName) {
  const iso = grid.scanStartIso ?? '';
  const acqDate = iso.slice(0, 10);
  const acqTime = iso.slice(11, 16).replace(':', '');
  return grid.detections.map((detection) => ({
    lat: detection.lat,
    lon: detection.lon,
    frp: detection.frp,
    confidence: confidenceTier(detection.mask),
    brightness: detection.tempK,
    daynight: detection.night == null ? null : detection.night ? 'N' : 'D',
    acqDate,
    acqTime,
    satellite: satelliteName,
    instrument: 'ABI',
  }));
}

export function goesFiresProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  const cachePath = path.join(process.cwd(), '.gev-cache', 'goes-fires.json');
  let memory = null;
  let diskChecked = false;
  let inflight = null;

  function configuredSatellites() {
    return (process.env.GOES_FIRE_SATELLITES || 'goes19,goes18')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => SATELLITES[value]);
  }

  async function loadDiskCache() {
    if (diskChecked) return;
    diskChecked = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(cachePath, 'utf8'));
      const maxFutureMs = 5 * 60_000;
      if (
        parsed?.version === CACHE_VERSION &&
        Number.isFinite(parsed.at) &&
        parsed.at <= Date.now() + maxFutureMs &&
        Array.isArray(parsed.sources) &&
        Array.isArray(parsed.fires)
      ) {
        memory = parsed;
      }
    } catch {
      /* cold cache */
    }
  }

  async function fetchSatellite(key, now) {
    const satellite = SATELLITES[key];
    const granule = await latestGranuleKey(satellite.bucket, now, fetchImpl);
    if (!granule) throw new Error(`no ${satellite.name} granule found`);
    const signal = AbortSignal.timeout(60_000);
    const response = await fetchImpl(
      buildObjectUrl(satellite.bucket, granule),
      { signal },
    );
    if (!response.ok)
      throw new Error(`${satellite.name} granule HTTP ${response.status}`);
    const buffer = await readResponseBytesCapped(
      response,
      MAX_GRANULE_BYTES,
      signal,
    );
    const bytes = new Uint8Array(buffer);
    const grid = await decodeFireGrid(bytes);
    return { satellite, rows: toRows(grid, satellite.name) };
  }

  async function refresh() {
    const now = Date.now();
    const fires = [];
    const sources = [];
    for (const key of configuredSatellites()) {
      try {
        const { satellite, rows } = await fetchSatellite(key, now);
        fires.push(...rows);
        sources.push({ source: satellite.name, count: rows.length, ok: true });
      } catch (error) {
        console.warn(`[goes-fires] ${SATELLITES[key].name} failed:`, error);
        sources.push({ source: SATELLITES[key].name, count: 0, ok: false });
      }
    }
    // Partial success is still a cacheable snapshot, mirroring the FIRMS proxy.
    if (!sources.some((source) => source.ok))
      throw new Error('all GOES sources failed');
    return { version: CACHE_VERSION, at: now, sources, fires };
  }

  function snapshot(entry, stale) {
    return {
      fetchedAt: entry.at,
      stale,
      ttlMs: TTL_MS,
      sources: entry.sources,
      count: entry.fires.length,
      fires: entry.fires,
    };
  }

  function middleware(server) {
    server.middlewares.use('/api/goes-fires', async (_req, res) => {
      await loadDiskCache();
      const send = (status, body) => {
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(body));
      };

      if (memory && Date.now() - memory.at < TTL_MS)
        return send(200, snapshot(memory, false));

      if (!inflight)
        inflight = refresh()
          .then(async (entry) => {
            memory = entry;
            try {
              await fsp.mkdir(path.dirname(cachePath), { recursive: true });
              await fsp.writeFile(cachePath, JSON.stringify(entry), 'utf8');
            } catch (error) {
              console.warn(
                '[goes-fires] cache write failed:',
                error?.message || error,
              );
            }
            return entry;
          })
          .finally(() => {
            inflight = null;
          });

      try {
        send(200, snapshot(await inflight, false));
      } catch {
        if (memory) send(200, snapshot(memory, true));
        else send(502, { error: 'goes fires fetch failed' });
      }
    });
  }

  return {
    name: 'goes-fires-proxy',
    configureServer: middleware,
    configurePreviewServer: middleware,
  };
}
