import { normalizeFirePerimeterSnapshot } from '../../src/layers/perimeters/records.js';
import {
  readResponseJsonCapped,
  readResponseTextCapped,
  coalesceProxyRequest,
} from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// NIFC WFIGS current interagency fire perimeters (public, keyless).
// maxAllowableOffset trades ~100 m of boundary fidelity for a payload small
// enough to refresh continuously (~1 MB for a typical fire season).
const API_URL =
  'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/' +
  'WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query?' +
  new URLSearchParams({
    where: '1=1',
    outFields: [
      'poly_IncidentName',
      'attr_UniqueFireIdentifier',
      'attr_IncidentSize',
      'attr_PercentContained',
      'attr_POOState',
      'attr_IncidentTypeCategory',
      'attr_FireDiscoveryDateTime',
      'poly_DateCurrent',
      'attr_FireCause',
      'attr_FireBehaviorGeneral',
      'attr_TotalIncidentPersonnel',
      'attr_POOCounty',
      'attr_EstimatedCostToDate',
      'attr_IncidentComplexityLevel',
      'attr_CpxName',
    ].join(','),
    maxAllowableOffset: '0.001',
    outSR: '4326',
    f: 'geojson',
  }).toString();

// The service caps a single response at its maxRecordCount (2000); a peak
// season can exceed that, so follow exceededTransferLimit with offset pages.
const MAX_PAGES = 5;

const exceededTransferLimit = (payload) =>
  payload?.exceededTransferLimit === true ||
  payload?.properties?.exceededTransferLimit === true;

const MIB = 1024 * 1024;

/** Fixed-origin, bounded WFIGS and InciWeb routes for dev and preview. */
export function firePerimetersProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  const cache = new Map();
  const publications = new Map();
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 1200 });

  async function upstream(url, cap, timeout, options = {}) {
    const signal = AbortSignal.timeout(timeout);
    const response = await fetchImpl(url, {
      ...options,
      signal,
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('upstream_unavailable');
    }
    return readResponseJsonCapped(response, cap, signal);
  }

  async function fetchPerimeters() {
    const features = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const url =
        page === 0 ? API_URL : `${API_URL}&resultOffset=${features.length}`;
      const payload = await upstream(url, 16 * MIB, 30_000);
      if (!Array.isArray(payload?.features))
        throw new Error('invalid_snapshot');
      features.push(...payload.features);
      if (!exceededTransferLimit(payload) || !payload.features.length) break;
    }
    const rows = normalizeFirePerimeterSnapshot({ features });
    return { fetchedAt: now(), rows };
  }

  async function fetchIndex() {
    const rows = await upstream(
      'https://inciweb.wildfire.gov/api/single-publication/',
      4 * MIB,
      20_000,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '' }),
      },
    );
    if (!Array.isArray(rows)) throw new Error('invalid_index');
    return rows;
  }

  // InciWeb's publication API was retired; incident pages carry origin and update times.
  async function fetchPublication(id) {
    const signal = AbortSignal.timeout(15_000);
    let response = await fetchImpl(`https://inciweb.wildfire.gov/node/${id}`, {
      signal,
      redirect: 'manual',
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location || /\.\.|[?%\\]/.test(location))
        throw new Error('invalid_redirect');
      const url = new URL(location, 'https://inciweb.wildfire.gov/');
      if (
        url.hostname !== 'inciweb.wildfire.gov' ||
        !/^\/[a-z0-9-]+(?:\/[a-z0-9-]+)?$/.test(url.pathname) ||
        !['http:', 'https:'].includes(url.protocol) ||
        url.port ||
        url.username ||
        url.password
      )
        throw new Error('invalid_redirect');
      url.protocol = 'https:';
      url.search = '';
      url.hash = '';
      response = await fetchImpl(url.href, { signal, redirect: 'error' });
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error('upstream_unavailable');
    }
    const html = await readResponseTextCapped(response, 2 * MIB, signal);
    const changed = Date.parse(
      html.match(/<meta\s+property="og:updated_time"\s+content="([^"]+)"/)?.[1],
    );
    const created = Date.parse(
      html.match(
        /Date of Origin<\/th>\s*<td[^>]*>\s*<time\s+datetime="([^"]+)"/,
      )?.[1],
    );
    const createdMs = Number.isFinite(created) ? created : null;
    const changedMs = Number.isFinite(changed) ? changed : null;
    if (createdMs === null && changedMs === null)
      throw new Error('invalid_incident_page');
    return { createdMs, changedMs };
  }

  async function acquire(key, ttl, load, store) {
    const previous = store.get(key);
    if (previous && now() - previous.savedAt < ttl)
      return { value: previous.value, stale: false };
    // Bound distinct concurrent publication requests as well as retained entries.
    if (!inFlight.has(key) && inFlight.size >= 256)
      throw Object.assign(new Error('busy'), { status: 429 });
    try {
      const { promise } = coalesceProxyRequest(inFlight, key, async () => {
        const value = await load();
        store.delete(key);
        store.set(key, { value, savedAt: now() });
        if (store === publications && store.size > 256)
          store.delete(store.keys().next().value);
        return value;
      });
      return { value: await promise, stale: false };
    } catch (error) {
      if (previous) return { value: previous.value, stale: true };
      throw error;
    }
  }

  async function handler(req, res) {
    const json = (status, value, stale = false) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...(status === 429 ? { 'Retry-After': '60' } : {}),
        ...(stale ? { 'X-Data-Stale': 'true' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const path = (req.url || '/').split('?')[0];
    let key,
      ttl,
      load,
      store = cache;
    if (path === '/' || path === '') {
      key = 'perimeters';
      ttl = 300_000;
      load = fetchPerimeters;
    } else if (path === '/inciweb/index') {
      key = 'index';
      ttl = 3_600_000;
      load = fetchIndex;
    } else if (path.startsWith('/inciweb/publication/')) {
      const id = path.slice('/inciweb/publication/'.length);
      if (!/^\d{1,9}$/.test(id))
        return json(400, { error: 'invalid_publication_id' });
      key = `publication:${id}`;
      ttl = 1_800_000;
      load = () => fetchPublication(id);
      store = publications;
    } else return json(404, { error: 'unknown_route' });
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    try {
      const { value, stale } = await acquire(key, ttl, load, store);
      json(
        200,
        key === 'perimeters' && stale ? { ...value, stale: true } : value,
        stale,
      );
    } catch (error) {
      json(error.status === 429 ? 429 : 502, {
        error: 'fire_perimeters_unavailable',
      });
    }
  }

  return {
    name: 'fire-perimeters',
    configureServer({ middlewares }) {
      middlewares.use('/api/fire-perimeters', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/fire-perimeters', handler);
    },
  };
}
