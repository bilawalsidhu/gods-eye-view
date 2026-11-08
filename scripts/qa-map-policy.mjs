/** Install before navigation, without intercepting workers or ordinary tiles. */
export async function blockPaidQaMaps(page, { allowPaidMaps = false } = {}) {
  if (allowPaidMaps) return;
  const session = await page.createCDPSession();
  await session.send('Network.enable');
  await session.send('Network.setBlockedURLs', {
    urls: [
      '*://tile.googleapis.com/*',
      '*://*.googleapis.com/*3dtiles*',
      '*://api.cesium.com/v1/assets/2275207/*',
      '*/api/google/tiles*',
    ],
  });
  return session;
}

/**
 * Free public tile hosts the strict acceptance lets a page ask for. The page
 * never reaches them: the strict harness answers them from a disk cache
 * (scripts/qa/tileCache.mjs), and Node fetches a missing tile once, politely.
 * OpenStreetMap raster tiles, the keyless re:earth terrain, the EOX
 * Sentinel-2 cloudless mosaic and Esri World Imagery (the keyless Cesium
 * base imagery and the Navara startup imagery).
 */
export const STRICT_TILE_HOSTS = Object.freeze([
  'tile.openstreetmap.org',
  'terrain.reearth.land',
  'tiles.maps.eox.at',
  'services.arcgisonline.com',
]);

/**
 * Requests every keyless page makes on its own, answered by the strict
 * harness exactly as the keyless preview would (or with an empty stylesheet
 * for Google Fonts), so they reach neither the preview's paid routes nor
 * Google. Any other request under a paid route or host stays blocked.
 * Keys are URLPattern strings relative to the preview origin or absolute.
 */
export const KEYLESS_PROBES = Object.freeze([
  {
    pattern: '/api/openai/hud-summary/status',
    method: 'GET',
    status: 200,
    contentType: 'application/json',
    body: '{"configured":false}',
  },
  { pattern: '/api/google/tiles-token', method: 'GET', status: 204 },
  { pattern: '/api/realtime/debug-log', method: 'POST', status: 204 },
  {
    pattern: 'https://fonts.googleapis.com/css2*',
    method: 'GET',
    status: 200,
    contentType: 'text/css',
    body: '/* Google Fonts withheld by the strict QA policy */',
  },
]);

/** A probe's absolute URLPattern string. */
export const probePattern = (origin, probe) =>
  probe.pattern.startsWith('/')
    ? new URL(origin).origin + probe.pattern
    : probe.pattern;

/** Paid or keyed services: blocked first, whatever else a scenario allows. */
export const PAID_HOST_PATTERNS = Object.freeze([
  '*://*.googleapis.com/*',
  '*://googleapis.com/*',
  '*://*.google.com/*',
  '*://google.com/*',
  '*://maps.google.*/*',
  '*://*.gstatic.com/*',
  '*://*.cesium.com/*',
  '*://cesium.com/*',
]);

/** Preview routes that spend a key (OpenAI, Realtime, Google proxies). */
export const PAID_PREVIEW_PATHS = Object.freeze([
  '/api/openai/*',
  '/api/realtime/*',
  '/api/google/*',
]);

/**
 * The ordered Network.setBlockedURLs patterns of the strict policy (first
 * match wins): the keyless probes the harness answers are let through to
 * it, paid hosts and paid preview routes are blocked, then the
 * preview origin, the scenario's fixture URLs and the free tile hosts are
 * allowed, then everything else is blocked.
 *
 * @param {string} origin The preview origin, e.g. http://127.0.0.1:4208
 * @param {{fixtures?: string[], tileHosts?: readonly string[]}} [options]
 *   `fixtures` are URLPattern strings for requests the scenario answers.
 */
export function strictBlockPatterns(
  origin,
  { fixtures = [], tileHosts = STRICT_TILE_HOSTS } = {},
) {
  const preview = new URL(origin).origin;
  return [
    ...KEYLESS_PROBES.map((probe) => ({
      urlPattern: probePattern(origin, probe),
      block: false,
    })),
    ...PAID_HOST_PATTERNS.map((urlPattern) => ({ urlPattern, block: true })),
    ...PAID_PREVIEW_PATHS.map((path) => ({
      urlPattern: preview + path,
      block: true,
    })),
    { urlPattern: preview + '/*', block: false },
    ...fixtures.map((urlPattern) => ({ urlPattern, block: false })),
    ...tileHosts.map((host) => ({
      urlPattern: `https://${host}/*`,
      block: false,
    })),
    { urlPattern: '*://*:*/*', block: true },
  ];
}

/** Paid or live model endpoints no switch gate may reach. */
export const SESSION_BLOCKED_URLS = Object.freeze([
  '*://tile.googleapis.com/*',
  '*://*.googleapis.com/*3dtiles*',
  '*://api.cesium.com/*',
  '*://assets.ion.cesium.com/*',
  '*://maps.googleapis.com/*',
  '*/api/google/*',
  '*/api/openai/*',
  '*/api/realtime/*',
  '*/api/gemini/*',
  '*://api.openai.com/*',
  '*://generativelanguage.googleapis.com/*',
]);
