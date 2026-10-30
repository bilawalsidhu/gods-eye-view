/**
 * Copernicus Emergency Management Service proxy — European civil protection
 * activations.
 *
 * Upstream: the Copernicus EMS mapping activation API on
 * mapping.emergency.copernicus.eu.
 *
 * WHAT THIS FEED ACTUALLY IS: a list of emergency activations with a
 * category (flood, fire, earthquake...), a disaster-risk-management phase and
 * a point centroid. It is NOT a live feed of the emergency itself and it
 * carries no damage telemetry; the layer shows WHERE an activation is and
 * WHAT KIND it is.
 *
 * DEAD ENDS (confirmed, not retried): activations.ems.europa.eu and
 * emsmapping.eu do not resolve; emergency.copernicus.eu/api/* 404s;
 * /api/v1/activations 404s; a WMS GetCapabilities on /ows 404s.
 *
 * Routes (the browser names a route, never a URL):
 *   GET /api/copernicus-ems/activations?closed=false
 *   GET /api/copernicus-ems/activations/{code}
 */

import { createOpenDataService } from '../../src/sources/openDataProxy.js';

/** The activation catalogue endpoint. */
export const EMS_ACTIVATIONS_ENDPOINT =
  'https://mapping.emergency.copernicus.eu/activations/api/activations/';

/** One upstream page holds 20 activations by default; ask for more. */
export const EMS_PAGE_SIZE = 100;

/** Activations change on the order of hours; a cached hour is fine. */
export const EMS_TTL_MS = 30 * 60_000;

/** Cap on how many activations one snapshot keeps. */
export const EMS_MAX_ACTIVATIONS = 500;

/**
 * Parse a WKT POINT centroid into lon/lat.
 *
 * The upstream writes the centroid as `POINT (lon lat)` — longitude FIRST,
 * which is the opposite of the usual GeoJSON order and an easy way to place
 * a hazard in the wrong hemisphere. The parser reads the pair in the
 * upstream's own order and hands it on in the app's lon/lat convention.
 *
 * @param {string|null|undefined} wkt The WKT string.
 * @returns {{lon: number, lat: number}|null} Null when unparsable.
 */
export function parseEmCentroid(wkt) {
  const text = String(wkt || '').trim();
  const match =
    /^POINT\s*\(\s*([-+]?\d+(?:\.\d+)?)\s+([-+]?\d+(?:\.\d+)?)\s*\)$/i.exec(
      text,
    );
  if (!match) return null;
  const lon = Number(match[1]);
  const lat = Number(match[2]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (Math.abs(lon) > 180 || Math.abs(lat) > 90) return null;
  return { lon, lat };
}

/**
 * The disaster-risk-management phases the upstream publishes, in the order
 * they escalate.
 */
export const EMS_DRM_PHASES = Object.freeze([
  Object.freeze({ id: 'preparedness', label: 'Preparedness' }),
  Object.freeze({ id: 'monitoring', label: 'Monitoring' }),
  Object.freeze({ id: 'alert', label: 'Alert' }),
  Object.freeze({ id: 'response', label: 'Response' }),
  Object.freeze({ id: 'recovery', label: 'Recovery' }),
]);

/**
 * The hazard categories the upstream publishes, with the colour each one is
 * drawn in.
 */
export const EMS_CATEGORIES = Object.freeze([
  Object.freeze({ id: 'flood', label: 'Flood', color: '#4cc9f0' }),
  Object.freeze({ id: 'fire', label: 'Fire', color: '#ff6b35' }),
  Object.freeze({ id: 'earthquake', label: 'Earthquake', color: '#ffd43b' }),
  Object.freeze({ id: 'storm', label: 'Storm', color: '#a78bfa' }),
  Object.freeze({ id: 'landslide', label: 'Landslide', color: '#c9a227' }),
  Object.freeze({ id: 'drought', label: 'Drought', color: '#e9c46a' }),
  Object.freeze({
    id: 'volcanic',
    label: 'Volcanic activity',
    color: '#f77f00',
  }),
  Object.freeze({ id: 'chemical', label: 'Chemical', color: '#48cae4' }),
  Object.freeze({ id: 'biological', label: 'Biological', color: '#80ed99' }),
  Object.freeze({ id: 'other', label: 'Other', color: '#adb5bd' }),
]);

const CATEGORY_BY_SLUG = new Map(
  EMS_CATEGORIES.map((entry) => [entry.id, entry]),
);

/** The colour a category is drawn in; unknown categories are neutral. */
export function emsCategoryColor(slug) {
  return (
    CATEGORY_BY_SLUG.get(String(slug || '').toLowerCase())?.color || '#adb5bd'
  );
}

/** The label for a category slug. */
export function emsCategoryLabel(slug) {
  const key = String(slug || '').toLowerCase();
  return (
    CATEGORY_BY_SLUG.get(key)?.label ||
    (key ? key.charAt(0).toUpperCase() + key.slice(1) : 'Other')
  );
}

/** The label for a DRM phase id. */
export function emsPhaseLabel(phase) {
  const key = String(phase || '').toLowerCase();
  return (
    EMS_DRM_PHASES.find((entry) => entry.id === key)?.label ||
    (key ? key.charAt(0).toUpperCase() + key.slice(1) : 'Unknown')
  );
}

/**
 * Normalize one activation record.
 *
 * @param {object} raw The upstream activation.
 * @param {number} index Record index (fallback id).
 * @returns {object|null} Normalized activation, or null without a usable
 *   centroid.
 */
export function normalizeEmActivation(raw, index = 0) {
  const code = String(raw?.code ?? '').trim();
  const position = parseEmCentroid(raw?.centroid);
  if (!position) return null;
  const categorySlug = String(raw?.category?.slug ?? '')
    .trim()
    .toLowerCase();
  const phase = String(raw?.drmPhase ?? '')
    .trim()
    .toLowerCase();
  const countries = Array.isArray(raw?.countries)
    ? raw.countries
        .map((entry) => String(entry?.short_name ?? '').trim())
        .filter(Boolean)
    : [];
  // The upstream writes naive local timestamps with no timezone suffix. They
  // are European local time, not UTC; treat them as such rather than
  // pretending a timezone the feed does not state.
  const activationTime = String(raw?.activationTime ?? '').trim();
  const lastUpdate = String(raw?.lastUpdate ?? '').trim();
  return {
    id: code || `ems-activation-${index + 1}`,
    code: code || null,
    name: String(raw?.name ?? '').trim() || null,
    category: categorySlug || 'other',
    categoryLabel: emsCategoryLabel(categorySlug),
    color: emsCategoryColor(categorySlug),
    phase: phase || null,
    phaseLabel: emsPhaseLabel(phase),
    closed: raw?.closed === true,
    countries,
    country: countries[0] || null,
    lon: position.lon,
    lat: position.lat,
    activationTime: activationTime || null,
    lastUpdate: lastUpdate || null,
    aoiCount: Number.isFinite(Number(raw?.n_aois)) ? Number(raw.n_aois) : null,
    productCount: Number.isFinite(Number(raw?.n_products))
      ? Number(raw.n_products)
      : null,
    snippet: String(raw?.search_snippet ?? '').trim() || null,
  };
}

/**
 * Normalize one activations page.
 *
 * @param {object} payload The upstream response.
 * @returns {{count: number, rows: object[]}}
 */
export function normalizeEmActivationsPage(payload) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  return {
    count: Number.isFinite(Number(payload?.count))
      ? Number(payload.count)
      : results.length,
    rows: results
      .map((row, index) => normalizeEmActivation(row, index))
      .filter(Boolean),
  };
}
/**
 * Sweep the activation catalogue.
 *
 * The response is PAGINATED (20 per page by default) and the upstream hands
 * back a `next` URL. The sweep follows `next` when it points at the same
 * origin, and stops at the activation cap.
 *
 * @param {typeof fetch} fetchImpl Injected fetch.
 * @param {AbortSignal} [signal] Abort signal.
 * @param {boolean} [closed] When true, ask for closed activations too.
 * @returns {Promise<{fetchedAt: number, count: number, activations: object[]}>}
 */
export async function loadEmActivations(fetchImpl, signal, closed = false) {
  const params = new URLSearchParams({
    limit: String(EMS_PAGE_SIZE),
  });
  if (!closed) params.set('closed', 'false');
  let url = EMS_ACTIVATIONS_ENDPOINT + '?' + params.toString();
  const activations = [];
  const seen = new Set();
  let pages = 0;
  while (url && pages < 10) {
    signal?.throwIfAborted();
    pages += 1;
    const response = await fetchImpl(url, {
      signal,
      redirect: 'manual',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      const error = new Error(`upstream HTTP ${response.status}`);
      error.upstreamStatus = response.status;
      throw error;
    }
    const payload = await response.json();
    const page = normalizeEmActivationsPage(payload);
    for (const row of page.rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      activations.push(row);
    }
    if (activations.length >= EMS_MAX_ACTIVATIONS) break;
    // Follow `next` only when it stays on the upstream's own origin.
    const next = String(payload?.next || '').trim();
    if (!next) break;
    let nextUrl;
    try {
      nextUrl = new URL(next);
    } catch {
      break;
    }
    if (nextUrl.origin !== new URL(EMS_ACTIVATIONS_ENDPOINT).origin) break;
    url = nextUrl.toString();
  }
  return {
    fetchedAt: Date.now(),
    count: activations.length,
    activations: activations.slice(0, EMS_MAX_ACTIVATIONS),
  };
}

/**
 * Build the Copernicus EMS open-data service.
 * @param {{fetchImpl?: typeof fetch}} [options]
 * @returns {{handle: Function, close: Function}}
 */
export function createCopernicusEmsService({ fetchImpl = fetch } = {}) {
  return createOpenDataService({
    id: 'copernicus-ems',
    routes: new Map([
      ['activations', EMS_ACTIVATIONS_ENDPOINT],
      ['active', EMS_ACTIVATIONS_ENDPOINT],
    ]),
    loader: async (route, fetchImplArg, signal) => {
      if (route === 'activations')
        return loadEmActivations(fetchImplArg, signal, true);
      if (route === 'active')
        return loadEmActivations(fetchImplArg, signal, false);
      throw new Error(`unknown route ${route}`);
    },
    ttlMs: EMS_TTL_MS,
    maxBytes: 4_000_000,
    maxPerWindow: 4,
    globalMaxPerWindow: 12,
    timeoutMs: 30_000,
    fetchImpl,
  });
}

/**
 * Vite plugin wrapping the Copernicus EMS proxy.
 * @param {{fetchImpl?: typeof fetch}} [options]
 * @returns {import('vite').Plugin}
 */
export function copernicusEmsProxy(options = {}) {
  const service = createCopernicusEmsService(options);
  function install(server) {
    server.middlewares.use('/api/copernicus-ems', async (req, res) => {
      const response = await service.handle({
        url: 'http://localhost/api/copernicus-ems' + (req.url || '/'),
        method: req.method,
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    });
    server.httpServer?.once('close', service.close);
  }
  return {
    name: 'copernicus-ems-proxy',
    closeBundle: service.close,
    configureServer: install,
    configurePreviewServer: install,
  };
}
