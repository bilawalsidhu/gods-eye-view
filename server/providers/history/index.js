import { onObservations } from '../common/observations.js';
import { isWatched, onWatchAdded } from '../common/watchRegistry.js';
import { getStore } from '../store/index.js';
import {
  sendJson,
  sendError,
  readJson,
  parseUrl,
  parseBbox,
  parseTime,
  route,
  badRequest,
} from '../common/json.js';
import { createRecorder, DEFAULT_RETENTION } from './recorder.js';
import { parseRegions, validRegion } from './thinning.js';
import { renderExport, EXPORT_TYPES } from './export.js';

/**
 * Vite plugin: persistent track history.
 *
 *   GET  /api/history/status
 *   GET  /api/history/track?domain=air&id=abc123&from=-6h&to=&format=json|geojson|csv|kml
 *   GET  /api/history/snapshot?at=<time>&window=300000&bbox=&domain=
 *   GET  /api/history/range?from=-30m&to=&bbox=&domain=   (span <= 6 h)
 *   GET  /api/history/assets?q=&domain=&limit=
 *   GET  /api/history/asset?domain=&id=
 *   GET  /api/history/regions        PUT /api/history/regions  {regions:[...]}
 *
 * Environment:
 *   GEV_HISTORY_ENABLED=0            turn recording and routes off
 *   GEV_HISTORY_REGIONS              "name:minLat,minLon,maxLat,maxLon;..."
 *   GEV_HISTORY_RECORD_ALL=0         record only regions + watchlisted assets
 *   GEV_HISTORY_PINNED_DAYS          default 30
 *   GEV_HISTORY_UNPINNED_HOURS       default 48
 */

const MAX_RANGE_MS = 6 * 3_600_000;
const DOMAINS = new Set(['air', 'sea']);
const SYSTEM_OWNER = '_system';

let runtime = null;

function envNumber(v, d) {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? x : d;
}

function retentionFromEnv(env) {
  return {
    ...DEFAULT_RETENTION,
    pinnedMs: envNumber(env.GEV_HISTORY_PINNED_DAYS, 30) * 86_400_000,
    unpinnedMs: envNumber(env.GEV_HISTORY_UNPINNED_HOURS, 48) * 3_600_000,
  };
}

/** Start the recorder once per process; both dev and preview hooks share it. */
export function startHistoryRuntime(env = process.env) {
  if (runtime) return runtime;
  const envRegions = parseRegions(env.GEV_HISTORY_REGIONS);
  for (const bad of envRegions.errors)
    console.warn('[history] ignoring invalid region:', bad);
  let storedRegions = [];
  const regions = () => [...envRegions.regions, ...storedRegions];
  const retention = retentionFromEnv(env);

  const recorder = createRecorder({
    getStore,
    regions,
    isWatched,
    recordUnpinned: env.GEV_HISTORY_RECORD_ALL !== '0',
  });

  const unsubscribe = onObservations((batch) => recorder.ingest(batch));
  const unWatch = onWatchAdded(async (keys) => {
    // Newly watched assets: keep what we already have for the pinned period.
    try {
      const store = await getStore();
      for (const key of keys) {
        const [domain, id] = key.split(':');
        await store.pinAsset(domain, id, Date.now() - retention.unpinnedMs);
      }
    } catch (error) {
      console.error('[history] pin failed:', error?.message);
    }
  });

  const timers = [
    setInterval(() => recorder.flush().catch(() => {}), 2000),
    setInterval(() => recorder.evictIdle(), 10 * 60_000),
    setInterval(async () => {
      try {
        const store = await getStore();
        await store.prune({ now: Date.now(), ...retention });
      } catch (error) {
        console.error('[history] prune failed:', error?.message);
      }
    }, 30 * 60_000),
  ];
  for (const t of timers) t.unref?.();

  getStore()
    .then((store) => store.listRecords('region', SYSTEM_OWNER))
    .then((rows) => {
      storedRegions = rows.map(validRegion).filter(Boolean);
    })
    .catch((error) =>
      console.error('[history] store unavailable:', error?.message),
    );

  runtime = {
    recorder,
    regions,
    envRegions: envRegions.regions,
    retention,
    setStoredRegions(list) {
      storedRegions = list;
    },
    async stop() {
      unsubscribe();
      unWatch();
      for (const t of timers) clearInterval(t);
      await recorder.flush().catch(() => {});
      runtime = null;
    },
  };
  return runtime;
}

function requireDomain(params) {
  const domain = params.get('domain');
  if (!DOMAINS.has(domain)) badRequest('domain must be air or sea');
  return domain;
}

function requireId(params) {
  const id = String(params.get('id') || '')
    .trim()
    .toLowerCase();
  if (!/^[0-9a-z]{1,16}$/.test(id))
    badRequest('id must be 1-16 letters or digits');
  return id;
}

function canAdmin(req) {
  return !req.gevUser || req.gevUser.admin === true;
}

/** Build the connect handler (exported for tests and the hosted server). */
export function historyHandler(rt = startHistoryRuntime()) {
  return route('history', async (req, res, next) => {
    const { path, params } = parseUrl(req);
    const now = Date.now();
    const store = await getStore();

    if (req.method === 'GET' && path === '/status') {
      return sendJson(res, 200, {
        recorder: rt.recorder.stats(),
        store: { dialect: store.dialect, ...(await store.stats()) },
        regions: rt.regions(),
        retention: rt.retention,
      });
    }

    if (req.method === 'GET' && path === '/track') {
      const domain = requireDomain(params);
      const id = requireId(params);
      const from = parseTime(params.get('from'), now) ?? now - 6 * 3_600_000;
      const to = parseTime(params.get('to'), now) ?? now;
      if (to < from) badRequest('to must be after from');
      const fixes = await store.track({
        domain,
        id,
        from,
        to,
        limit: params.get('limit'),
      });
      const asset = (await store.asset(domain, id)) || {
        domain,
        id,
        label: null,
      };
      const format = params.get('format') || 'json';
      if (format === 'json')
        return sendJson(res, 200, { asset, from, to, fixes });
      const body = renderExport(format, [{ asset, fixes }]);
      if (body === null) badRequest('format must be json, geojson, csv or kml');
      const type = EXPORT_TYPES[format];
      res.writeHead(200, {
        'Content-Type': type.type,
        'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="${domain}-${id}.${type.ext}"`,
      });
      return res.end(body);
    }

    if (req.method === 'GET' && path === '/snapshot') {
      const at = parseTime(params.get('at'), now) ?? now;
      const windowMs = Math.min(
        3_600_000,
        envNumber(params.get('window'), 300_000),
      );
      const domain = params.get('domain');
      if (domain && !DOMAINS.has(domain)) badRequest('bad domain');
      const fixes = await store.snapshot({
        at,
        windowMs,
        bbox: parseBbox(params.get('bbox')),
        domain: domain || null,
        limit: params.get('limit'),
      });
      return sendJson(res, 200, { at, windowMs, count: fixes.length, fixes });
    }

    if (req.method === 'GET' && path === '/range') {
      const to = parseTime(params.get('to'), now) ?? now;
      const from = parseTime(params.get('from'), now) ?? to - 30 * 60_000;
      if (to < from) badRequest('to must be after from');
      if (to - from > MAX_RANGE_MS) badRequest('range is limited to 6 hours');
      const domain = params.get('domain');
      if (domain && !DOMAINS.has(domain)) badRequest('bad domain');
      const fixes = await store.range({
        from,
        to,
        bbox: parseBbox(params.get('bbox')),
        domain: domain || null,
        limit: params.get('limit'),
      });
      // Group per asset to keep the payload compact for the time machine.
      const tracks = new Map();
      for (const f of fixes) {
        const key = `${f.domain}:${f.id}`;
        let t = tracks.get(key);
        if (!t) {
          t = { domain: f.domain, id: f.id, fixes: [] };
          tracks.set(key, t);
        }
        t.fixes.push([f.t, f.lat, f.lon, f.alt, f.course, f.speed]);
      }
      return sendJson(res, 200, {
        from,
        to,
        fields: ['t', 'lat', 'lon', 'alt', 'course', 'speed'],
        tracks: [...tracks.values()],
      });
    }

    if (req.method === 'GET' && path === '/assets') {
      const domain = params.get('domain');
      if (domain && !DOMAINS.has(domain)) badRequest('bad domain');
      const assets = await store.searchAssets({
        q: params.get('q') || '',
        domain: domain || null,
        limit: params.get('limit'),
      });
      return sendJson(res, 200, { assets });
    }

    if (req.method === 'GET' && path === '/asset') {
      const asset = await store.asset(requireDomain(params), requireId(params));
      if (!asset) return sendError(res, 404, 'not_found');
      return sendJson(res, 200, { asset });
    }

    if (path === '/regions') {
      if (req.method === 'GET')
        return sendJson(res, 200, {
          fromEnvironment: rt.envRegions,
          stored: await store.listRecords('region', SYSTEM_OWNER),
        });
      if (req.method === 'PUT') {
        if (!canAdmin(req)) return sendError(res, 403, 'forbidden');
        const body = await readJson(req);
        const list = Array.isArray(body?.regions) ? body.regions : null;
        if (!list || list.length > 50)
          badRequest('regions must be an array of at most 50');
        const valid = list.map(validRegion);
        if (valid.some((r) => !r))
          badRequest('each region needs name and a valid box');
        for (const old of await store.listRecords('region', SYSTEM_OWNER))
          await store.deleteRecord('region', SYSTEM_OWNER, old.id);
        for (const [i, r] of valid.entries())
          await store.putRecord('region', SYSTEM_OWNER, `r${i}`, r);
        rt.setStoredRegions(valid);
        return sendJson(res, 200, { stored: valid });
      }
    }

    if (typeof next === 'function') return next();
    return sendError(res, 404, 'not_found');
  });
}

export function historyProvider({ env = process.env } = {}) {
  const enabled = env.GEV_HISTORY_ENABLED !== '0';
  const install = (server) => {
    if (!enabled) return;
    server.middlewares.use(
      '/api/history',
      historyHandler(startHistoryRuntime(env)),
    );
  };
  return {
    name: 'gev-history',
    configureServer: install,
    configurePreviewServer: install,
  };
}

/** Flush buffered fixes and stop timers (server shutdown). */
export async function stopHistoryRuntime() {
  if (runtime) await runtime.stop();
}
