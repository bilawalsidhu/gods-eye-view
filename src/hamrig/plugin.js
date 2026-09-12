/**
 * Vite plugin wiring for the HamRig proxy (`/api/hamrig/*`). Contract §1.6.
 *
 * `hamrigProxyPlugin(env)` reads the HAMRIG_* block from `.env` and installs
 * one Connect middleware on both the dev and the preview server. The heavy
 * pieces (HamRig client, cty.dat resolver, geolocator, live spot feed) are
 * built exactly once and lazily — on the first `/api/hamrig/*` request — so a
 * developer who never opens a ham-radio layer pays nothing (no cty.dat
 * download, no WebSocket to the cluster feed).
 *
 * `HAMRIG_ENABLED=0` short-circuits everything: the middleware answers 503
 * `{ error: 'HamRig integration disabled' }` for every `/api/hamrig/*` path
 * and no upstream object is ever constructed.
 *
 * HAMRIG_BASE_URL is operator configuration, not user input, so no DNS pinning
 * is required (the web-receivers proxy pins because its targets come from a
 * public directory). User-supplied values only ever reach upstream URLs as
 * validated callsigns, Maidenhead grids and range-checked numbers.
 */

import { isValidGrid } from '../data/maidenhead.js';
import { DEFAULT_CTY_URL, createCtyResolver } from './ctyDat.js';
import { createHamrigClient, normalizeHamrigBaseUrl } from './hamrigClient.js';
import { createHamrigProxyMiddleware } from './proxy.js';

export const HAMRIG_DEFAULT_BASE_URL = 'https://hamrig.com';
export const HAMRIG_DEFAULT_SPOTS_WS_URL = 'wss://hamrig.com:8777';
export const HAMRIG_MOUNT_PATH = '/api/hamrig';

const FALSE_WORDS = new Set(['0', 'false', 'no', 'off', 'disabled']);

function envString(env, key) {
  const value = env?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Parse the HAMRIG_* environment block into a config object.
 *
 * @param {Record<string, string|undefined>} [env=process.env]
 * @returns {{ enabled: boolean, baseUrl: string, username: string, password: string, spotsWsUrl: string, ctyUrl: string, homeGrid: string|null, sotaEnabled: boolean }}
 */
export function parseHamrigEnv(env = process.env) {
  const enabledRaw = envString(env, 'HAMRIG_ENABLED').toLowerCase();
  const enabled = enabledRaw === '' ? true : !FALSE_WORDS.has(enabledRaw);
  const baseUrl = envString(env, 'HAMRIG_BASE_URL') || HAMRIG_DEFAULT_BASE_URL;
  const spotsWsUrl = envString(env, 'HAMRIG_SPOTS_WS_URL') || HAMRIG_DEFAULT_SPOTS_WS_URL;
  const ctyUrl = envString(env, 'HAMRIG_CTY_URL') || DEFAULT_CTY_URL;
  // SOTA's API terms require prior approval before AI-written software may
  // connect; GEV's SOTA client was AI-assisted, so the program stays off
  // until the operator has that approval and opts in explicitly.
  const sotaRaw = envString(env, 'HAMRIG_SOTA_ENABLED').toLowerCase();
  const sotaEnabled = sotaRaw !== '' && !FALSE_WORDS.has(sotaRaw);
  const homeGridRaw = envString(env, 'HAMRIG_HOME_GRID');
  const homeGrid = homeGridRaw && isValidGrid(homeGridRaw)
    ? homeGridRaw.slice(0, 2).toUpperCase() + homeGridRaw.slice(2, 4) + homeGridRaw.slice(4, 6).toLowerCase() + homeGridRaw.slice(6)
    : null;
  return {
    enabled,
    baseUrl,
    username: envString(env, 'HAMRIG_USERNAME'),
    password: typeof env?.HAMRIG_PASSWORD === 'string' ? env.HAMRIG_PASSWORD : '',
    spotsWsUrl,
    ctyUrl,
    homeGrid,
    sotaEnabled,
  };
}

/** Whether a spot-feed URL is an acceptable secure WebSocket target (ws:// only to loopback). */
function acceptableWsUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'wss:') return true;
    if (url.protocol === 'ws:') {
      const host = url.hostname.toLowerCase();
      return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Build the runtime pieces once. `geolocate.js` and `spotFeed.js` are loaded
 * dynamically so a checkout without them (or one where they fail to import)
 * still serves the station/activation/propagation routes; the dependent
 * routes then answer 502 with a clear message instead of taking the dev
 * server down.
 */
async function buildRuntime(config, { log = console, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const warn = (message) => { try { log?.warn?.(message); } catch { /* no-op */ } };
  const client = createHamrigClient({
    baseUrl: config.baseUrl,
    username: config.username,
    password: config.password,
    fetchImpl,
    now,
    log,
  });
  if (!client.configured) {
    warn(`[hamrig] HAMRIG_BASE_URL is not an https URL (${config.baseUrl}); HamRig routes will answer 502`);
  }
  const cty = createCtyResolver({ fetchImpl, url: config.ctyUrl, now, log });
  // Start the cty.dat load in the background; the middleware awaits `ready()` where it matters.
  cty.ready().catch(() => null);

  let geolocator = null;
  try {
    const mod = await import('./geolocate.js');
    if (typeof mod.createGeolocator === 'function') {
      geolocator = mod.createGeolocator({ cty, client, now, log });
    }
  } catch (error) {
    warn(`[hamrig] geolocator unavailable (${error?.message ?? error}); falling back to cty-only positions`);
  }

  let spotFeed = null;
  if (!acceptableWsUrl(config.spotsWsUrl)) {
    warn(`[hamrig] HAMRIG_SPOTS_WS_URL must be wss:// (or ws:// to localhost); live spots disabled`);
  } else {
    try {
      const mod = await import('./spotFeed.js');
      if (typeof mod.createSpotFeed === 'function') {
        spotFeed = mod.createSpotFeed({ wsUrl: config.spotsWsUrl, client, geolocator, now, log });
      }
    } catch (error) {
      warn(`[hamrig] live spot feed unavailable (${error?.message ?? error}); /api/hamrig/spots will answer 502`);
    }
  }

  return { client, cty, geolocator, spotFeed };
}

/**
 * Create the plugin. `options` exist for tests (inject fetch/log/clock and
 * observe the lazily built runtime); production callers pass nothing.
 *
 * @param {Record<string, string|undefined>} [env=process.env]
 * @param {{ fetchImpl?: typeof fetch, log?: object, now?: () => number, buildRuntimeImpl?: Function }} [options]
 */
export function hamrigProxyPlugin(env = process.env, options = {}) {
  const config = parseHamrigEnv(env);
  const log = options.log ?? console;
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const build = options.buildRuntimeImpl ?? buildRuntime;

  let runtimePromise = null;
  let runtime = null;
  let middleware = null;

  const disabledMiddleware = createHamrigProxyMiddleware({ config: { ...config, enabled: false }, now, log });

  /** Build (once) the real middleware around the lazily constructed runtime. */
  function ensureMiddleware() {
    if (!runtimePromise) {
      runtimePromise = Promise.resolve()
        .then(() => build(config, { log, fetchImpl, now }))
        .then((built) => {
          runtime = built;
          middleware = createHamrigProxyMiddleware({
            ...built,
            fetchImpl,
            now,
            log,
            config: {
              enabled: true,
              homeGrid: config.homeGrid,
              baseUrl: normalizeHamrigBaseUrl(config.baseUrl) ?? config.baseUrl,
              spotsWsUrl: config.spotsWsUrl,
              sotaEnabled: config.sotaEnabled,
            },
          });
          return middleware;
        })
        .catch((error) => {
          runtimePromise = null;
          throw error;
        });
    }
    return runtimePromise;
  }

  async function handler(req, res, next) {
    if (!config.enabled) return disabledMiddleware(req, res, next);
    let active = middleware;
    if (!active) {
      try {
        active = await ensureMiddleware();
      } catch (error) {
        try { log?.warn?.(`[hamrig] runtime failed to start: ${error?.message ?? error}`); } catch { /* no-op */ }
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'HamRig integration failed to start', generatedAt: new Date(now()).toISOString(), sources: [] }));
        return undefined;
      }
    }
    return active(req, res, next);
  }

  const install = (server) => {
    server.middlewares.use(HAMRIG_MOUNT_PATH, handler);
  };

  return {
    name: 'hamrig-proxy',
    configureServer: install,
    configurePreviewServer: install,
    /** Test hook: the parsed configuration (password redacted). */
    get hamrigConfig() {
      return { ...config, password: config.password ? '***' : '' };
    },
    /** Test hook: resolves `{ client, cty, geolocator, spotFeed }` (builds it when needed; null when disabled). */
    hamrigRuntime() {
      if (!config.enabled) return Promise.resolve(null);
      return ensureMiddleware().then(() => runtime);
    },
  };
}
