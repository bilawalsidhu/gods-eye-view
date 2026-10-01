import { cameraCatalog, onCameraHealth } from '../common/cameraHooks.js';
import { getStore } from '../store/index.js';
import { sendJson, sendError, parseUrl, parseBbox, parseTime, route, badRequest } from '../common/json.js';
import { coverageGrid } from '../../../src/sources/cameraCoverage.js';

/**
 * Vite plugin: camera coverage and camera health history.
 *
 *   GET /api/cameras/coverage?bbox=minLat,minLon,maxLat,maxLon&cell=25&confident=1
 *   GET /api/cameras/health?from=-24h            uptime per camera
 *   GET /api/cameras/health/series?camera=&from=-7d&bucket=3600000
 *
 * Health samples are recorded passively from the CCTV proxy's own frame and
 * media outcomes (what viewers already requested), at most one sample per
 * camera per five minutes. Nothing polls the public camera hosts on its own.
 */

const SAMPLE_GAP_MS = 5 * 60_000;
const MAX_BOX_DEG = 1.0;

export function createCameraService({ getStore: storeOf = getStore, catalog = cameraCatalog, now = Date.now } = {}) {
  const lastSampleAt = new Map();
  let pending = [];

  function record(sample) {
    const prev = lastSampleAt.get(sample.camera);
    // Always keep a state change; otherwise thin to one per gap.
    if (prev && sample.t - prev.t < SAMPLE_GAP_MS && prev.ok === sample.ok) return;
    lastSampleAt.set(sample.camera, { t: sample.t, ok: sample.ok });
    if (lastSampleAt.size > 20_000) lastSampleAt.delete(lastSampleAt.keys().next().value);
    pending.push(sample);
    if (pending.length > 10_000) pending.shift();
  }

  async function flush() {
    if (!pending.length) return 0;
    const batch = pending;
    pending = [];
    try {
      return await (await storeOf()).insertCamSamples(batch);
    } catch (error) {
      pending = batch.concat(pending).slice(-10_000);
      throw error;
    }
  }

  const handler = route('cameras', async (req, res, next) => {
    const { path, params } = parseUrl(req);
    if (req.method !== 'GET') return typeof next === 'function' ? next() : sendError(res, 405, 'method');

    if (path === '/coverage') {
      const bbox = parseBbox(params.get('bbox'));
      if (!bbox) badRequest('bbox=minLat,minLon,maxLat,maxLon required');
      if (bbox.maxLat - bbox.minLat > MAX_BOX_DEG || bbox.maxLon - bbox.minLon > MAX_BOX_DEG)
        badRequest(`bbox may span at most ${MAX_BOX_DEG} degree`);
      const cell = Math.min(500, Math.max(10, Number(params.get('cell')) || 25));
      const cams = await catalog();
      const grid = coverageGrid(cams, bbox, {
        cellM: cell,
        includeLowConfidence: params.get('confident') !== '1',
      });
      return sendJson(res, 200, { ...grid, catalogSize: cams.length });
    }

    if (path === '/health') {
      const to = parseTime(params.get('to'), now()) ?? now();
      const from = parseTime(params.get('from'), now()) ?? to - 86_400_000;
      const cams = await catalog();
      const names = new Map(cams.map((c) => [String(c.id), { name: c.name, provider: c.provider, lat: c.lat, lon: c.lon }]));
      const rows = await (await storeOf()).camUptime({ from, to });
      return sendJson(res, 200, {
        from,
        to,
        cameras: rows
          .map((r) => ({ ...r, ...(names.get(r.camera) || {}) }))
          .sort((a, b) => (a.uptime ?? 1) - (b.uptime ?? 1)),
      });
    }

    if (path === '/health/series') {
      const camera = String(params.get('camera') || '');
      if (!camera || camera.length > 128) badRequest('camera required');
      const to = parseTime(params.get('to'), now()) ?? now();
      const from = parseTime(params.get('from'), now()) ?? to - 7 * 86_400_000;
      const bucketMs = Math.max(300_000, Number(params.get('bucket')) || 3_600_000);
      const series = await (await storeOf()).camSeries({ camera, from, to, bucketMs });
      return sendJson(res, 200, { camera, from, to, bucketMs, series });
    }

    return typeof next === 'function' ? next() : sendError(res, 404, 'not_found');
  });

  return { handler, record, flush };
}

let service = null;

export function startCameraService() {
  if (service) return service;
  service = createCameraService();
  onCameraHealth((s) => service.record(s));
  setInterval(() => service.flush().catch((e) => console.error('[cameras] flush:', e?.message)), 10_000).unref?.();
  return service;
}

export function camerasProvider({ env = process.env } = {}) {
  const install = (server) => {
    if (env.GEV_CAMERAS_ENABLED === '0') return;
    server.middlewares.use('/api/cameras', startCameraService().handler);
  };
  return { name: 'gev-cameras', configureServer: install, configurePreviewServer: install };
}
