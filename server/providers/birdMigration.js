import { mergeMotion } from '../../src/layers/birdMigration/model.js';
import {
  MAX_TICKS,
  isScanTime,
  parseManifest,
  parseMotion,
} from '../../src/layers/birdMigration/wire.js';
import { coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { createRadarUpstream } from './birdMigration/upstream.js';
import { decodeLevel3 } from './birdMigration/level3.js';
import { reduceStation, VAD_POLICY } from './birdMigration/vad.js';

const MINUTE = 60_000;
const HISTORY_MS = 12 * 60 * MINUTE;
// IEM's USCOMP composite extent; a radar counts only inside it.
const COMPOSITE_BOUNDS = Object.freeze({
  west: -126,
  south: 23,
  east: -65,
  north: 50,
});
const MANIFEST_TTL_MS = 5 * MINUTE;
const MANIFEST_STALE_MS = 60 * MINUTE;
const LISTING_TTL_MS = 5 * MINUTE;
const SITES_TTL_MS = 24 * 60 * MINUTE;
// Volumes reach tgftp a few minutes after the scan starts.
const FINAL_AFTER_MS = 10 * MINUTE;
const PROVISIONAL_TTL_MS = 3 * MINUTE;
const SCAN_BEFORE_TICK_MS = 12 * MINUTE;
const SCAN_AFTER_TICK_MS = 5 * MINUTE;
const PAIR_ARRIVAL_MS = 3 * MINUTE;
const MAX_REDUCING_TICKS = 3;

const inside = ({ lat, lon }) =>
  lon >= COMPOSITE_BOUNDS.west &&
  lon <= COMPOSITE_BOUNDS.east &&
  lat >= COMPOSITE_BOUNDS.south &&
  lat <= COMPOSITE_BOUNDS.north;

const motionDocument = (time, motion) => ({ schemaVersion: 1, time, motion });

async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

/** :00 and :30 composite scans over twelve hours, plus the newest scan. */
function selectTicks(scans) {
  const sorted = [...new Set(scans.filter(isScanTime))].sort();
  const latest = sorted.at(-1);
  if (!latest) return [];
  const ticks = sorted.filter(
    (scan) =>
      Date.parse(latest) - Date.parse(scan) <= HISTORY_MS &&
      new Date(scan).getUTCMinutes() % 30 === 0,
  );
  if (ticks.at(-1) !== latest) ticks.push(latest);
  return ticks.slice(-MAX_TICKS);
}

/** Same-origin manifest and per-tick motion reduced from NWS Level III N0U/N0C. */
export function birdMigrationProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  upstream = createRadarUpstream({ fetchImpl }),
  decode = decodeLevel3,
  holdMs = 25_000,
  concurrency = 8,
} = {}) {
  const allow = makeRateLimiter({
    windowMs: MINUTE,
    max: 120,
    globalMax: 1200,
  });
  const cached = new Map();
  const loads = new Map();
  const reducing = new Map();
  const positions = new Map();
  const reductions = new Map();
  let manifest = null;

  function remember(key, ttl, load) {
    const entry = cached.get(key);
    if (entry && now() - entry.savedAt < ttl)
      return Promise.resolve(entry.value);
    return coalesceProxyRequest(loads, key, async () => {
      const value = await load();
      cached.set(key, { value, savedAt: now() });
      return value;
    }).promise;
  }

  async function loadManifest() {
    if (manifest && now() - manifest.savedAt < MANIFEST_TTL_MS)
      return manifest.wire;
    try {
      return await coalesceProxyRequest(loads, 'manifest', async () => {
        const at = now();
        const ticks = selectTicks(
          await upstream.compositeScans(
            at - HISTORY_MS - 30 * MINUTE,
            at,
            AbortSignal.timeout(15_000),
          ),
        );
        const wire = {
          schemaVersion: 1,
          ticks,
          latest: ticks.at(-1),
          bounds: COMPOSITE_BOUNDS,
          stale: false,
        };
        parseManifest(wire);
        manifest = { wire, savedAt: now() };
        for (const tick of reductions.keys())
          if (!ticks.includes(tick)) reductions.delete(tick);
        return wire;
      }).promise;
    } catch {
      if (manifest && now() - manifest.savedAt < MANIFEST_STALE_MS)
        return { ...manifest.wire, stale: true };
      return {
        schemaVersion: 1,
        unavailable: true,
        reason: 'Composite scan list unavailable',
      };
    }
  }

  const listing = (site, product, signal) =>
    remember(`${site}:${product}`, LISTING_TTL_MS, () =>
      upstream.files(site, product, signal),
    );

  const nearest = (files, target, window) =>
    files
      .filter(({ arrivedAt }) => Math.abs(arrivedAt - target) <= window)
      .sort(
        (a, b) =>
          Math.abs(a.arrivedAt - target) - Math.abs(b.arrivedAt - target),
      )[0] ?? null;

  async function reduceSite(site, tick) {
    const noScan = () => {
      const position = positions.get(site);
      return position && inside(position)
        ? { kind: 'no-scan', site, position }
        : null;
    };
    const signal = AbortSignal.timeout(30_000);
    const at = Date.parse(tick);
    try {
      const [velocityFiles, correlationFiles] = await Promise.all([
        listing(site, 'N0U', signal),
        listing(site, 'N0C', signal),
      ]);
      const velocityRef = velocityFiles
        .filter(
          ({ arrivedAt }) =>
            arrivedAt <= at + SCAN_AFTER_TICK_MS &&
            arrivedAt >= at - SCAN_BEFORE_TICK_MS,
        )
        .sort((a, b) => a.arrivedAt - b.arrivedAt)
        .at(-1);
      const correlationRef =
        velocityRef &&
        nearest(correlationFiles, velocityRef.arrivedAt, PAIR_ARRIVAL_MS);
      if (!correlationRef) return noScan();
      const [velocity, correlation] = await Promise.all([
        upstream
          .bytes(site, 'N0U', velocityRef.file, signal)
          .then((bytes) => decode(bytes, 'N0U')),
        upstream
          .bytes(site, 'N0C', correlationRef.file, signal)
          .then((bytes) => decode(bytes, 'N0C')),
      ]);
      positions.set(site, velocity.position);
      if (!inside(velocity.position)) return null;
      const scan = Date.parse(velocity.scanTime);
      if (
        velocity.scanTime !== correlation.scanTime ||
        scan < at - SCAN_BEFORE_TICK_MS ||
        scan > at + SCAN_AFTER_TICK_MS
      )
        return noScan();
      return reduceStation(site, { velocity, correlation });
    } catch {
      return noScan();
    }
  }

  /** Commits a reduced tick atomically, or returns an unavailable document. */
  async function reduceTick(tick) {
    try {
      const sites = await remember('sites', SITES_TTL_MS, () =>
        upstream.sites(AbortSignal.timeout(15_000)),
      );
      const earlier = new Map(
        (reductions.get(tick)?.wire.motion.stations ?? []).map((station) => [
          station.site,
          station,
        ]),
      );
      // A failed fetch on re-reduction must not erase a scan already reduced.
      const stations = (
        await mapLimit(sites, concurrency, (site) => reduceSite(site, tick))
      )
        .filter(Boolean)
        .map((station) =>
          station.kind === 'no-scan' && earlier.has(station.site)
            ? earlier.get(station.site)
            : station,
        );
      const wire = motionDocument(tick, {
        kind: 'reduced',
        reducedAt: new Date(now()).toISOString(),
        final: now() - Date.parse(tick) > FINAL_AFTER_MS,
        sampleRadiusKm: VAD_POLICY.annulusKm[1],
        stations,
      });
      const motion = parseMotion(JSON.parse(JSON.stringify(wire)), tick);
      if (mergeMotion(reductions.get(tick)?.motion, motion) === motion)
        reductions.set(tick, { wire, motion, savedAt: now() });
      return null;
    } catch {
      return motionDocument(tick, {
        kind: 'unavailable',
        reason: 'NWS radar files unavailable',
      });
    }
  }

  async function motionFor(tick) {
    const entry = reductions.get(tick);
    if (
      entry &&
      (entry.motion.final || now() - entry.savedAt < PROVISIONAL_TTL_MS)
    )
      return entry.wire;
    if (!reducing.has(tick) && reducing.size >= MAX_REDUCING_TICKS) {
      if (entry) return entry.wire;
      throw Object.assign(new Error('busy'), { status: 429 });
    }
    const { promise } = coalesceProxyRequest(reducing, tick, () =>
      reduceTick(tick),
    );
    let timer;
    const failure = await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), holdMs);
        timer.unref?.();
      }),
    ]).finally(() => clearTimeout(timer));
    return (
      reductions.get(tick)?.wire ??
      failure ??
      motionDocument(tick, { kind: 'pending' })
    );
  }

  async function handler(req, res) {
    const json = (status, value) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...(status === 429 ? { 'Retry-After': '30' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const url = new URL(req.url || '/', 'http://local');
    if (url.pathname !== '/manifest' && url.pathname !== '/motion')
      return json(404, { error: 'unknown_route' });
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    try {
      const current = await loadManifest();
      if (url.pathname === '/manifest') return json(200, current);
      const time = url.searchParams.get('time');
      if (!current.ticks?.includes(time))
        return json(400, { error: 'unknown_tick' });
      return json(200, await motionFor(time));
    } catch (error) {
      json(error.status === 429 ? 429 : 502, {
        error: 'bird_migration_unavailable',
      });
    }
  }

  return {
    name: 'bird-migration',
    configureServer({ middlewares }) {
      middlewares.use('/api/migration', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/migration', handler);
    },
  };
}
