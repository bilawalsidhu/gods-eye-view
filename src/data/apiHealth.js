// Startup API health probes.
//
// The loading screen asks `/api/health` which upstreams are reachable and
// which optional keys are configured before the globe is revealed. Every
// probe is deliberately cheap: no billable Google call is ever made (the
// Maps key is only checked for presence and the tile host for reachability),
// and rate-budgeted APIs (Launch Library 2, OpenSky anonymous) are touched as
// lightly as their quotas allow.
//
// `runApiHealthProbes` is pure with respect to the network: `fetch`, `env`,
// `localFetch`, and helpers are injected so the node:test suite can exercise
// every state offline.

/** Per-probe upstream timeout. */
export const API_HEALTH_PROBE_TIMEOUT_MS = 6000;

/** Completed reports are reused for this long so reloads do not re-probe. */
export const API_HEALTH_REPORT_TTL_MS = 60_000;

const USER_AGENT = 'gods-eye-view-health/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)';

/**
 * Probe states, in display priority order.
 *   ok           reachable and (if keyed) the key was accepted
 *   configured   key present but deliberately not probed (billable)
 *   degraded     reachable but throttled / partial
 *   key-missing  optional provider not configured (layer runs keyless or empty)
 *   key-invalid  provider rejected the configured credential
 *   down         upstream unreachable, timed out, or errored
 */
export const API_HEALTH_STATES = Object.freeze([
  'ok', 'configured', 'degraded', 'key-missing', 'key-invalid', 'down',
]);

/**
 * Service catalog. `tier` drives copy on the loading screen:
 *   required  the app cannot start without it
 *   keyed     optional, needs a key for live data
 *   keyless   free public feed
 */
export const API_HEALTH_SERVICES = Object.freeze([
  { id: 'google-maps', label: 'Google Map Tiles', tier: 'required', envKeys: ['GOOGLE_MAPS_API_KEY'] },
  { id: 'google-places', label: 'Google Places', tier: 'keyed', envKeys: ['GOOGLE_MAPS_API_KEY'] },
  { id: 'cesium-ion', label: 'Cesium ion', tier: 'keyed', envKeys: ['CESIUM_ION_TOKEN'] },
  { id: 'openai', label: 'OpenAI Realtime', tier: 'keyed', envKeys: ['OPENAI_API_KEY'] },
  { id: 'opensky', label: 'OpenSky flights', tier: 'keyed', envKeys: ['OPENSKY_CLIENT_ID', 'OPENSKY_CLIENT_SECRET'] },
  { id: 'adsb-lol', label: 'adsb.lol', tier: 'keyless', envKeys: [] },
  { id: 'adsbdb', label: 'adsbdb registry', tier: 'keyless', envKeys: [] },
  { id: 'aisstream', label: 'AISStream vessels', tier: 'keyed', envKeys: ['AISSTREAM_API_KEY'] },
  { id: 'celestrak', label: 'CelesTrak TLEs', tier: 'keyless', envKeys: [] },
  { id: 'launch-library', label: 'Launch Library 2', tier: 'keyless', envKeys: ['LL2_API_TOKEN'] },
  { id: 'usgs', label: 'USGS earthquakes', tier: 'keyless', envKeys: [] },
  { id: 'firms', label: 'NASA FIRMS fires', tier: 'keyed', envKeys: ['FIRMS_MAP_KEY'] },
  { id: 'tomtom', label: 'TomTom traffic', tier: 'keyed', envKeys: ['TOMTOM_API_KEY'] },
  { id: 'overpass', label: 'OSM Overpass', tier: 'keyless', envKeys: [] },
  { id: 'nominatim', label: 'OSM Nominatim', tier: 'keyless', envKeys: [] },
  { id: 'osrm', label: 'OSM routing', tier: 'keyless', envKeys: [] },
  { id: 'open-meteo', label: 'Open-Meteo weather', tier: 'keyless', envKeys: [] },
  { id: 'news', label: 'Regional news', tier: 'keyless', envKeys: [] },
  { id: 'reearth-terrain', label: 'Re:Earth terrain', tier: 'keyless', envKeys: [] },
  { id: 'cctv-austin', label: 'CCTV Austin', tier: 'keyless', envKeys: [] },
  { id: 'cctv-caltrans', label: 'CCTV Caltrans', tier: 'keyless', envKeys: [] },
  { id: 'cctv-tfl', label: 'CCTV TfL London', tier: 'keyless', envKeys: ['TFL_APP_KEY'] },
  { id: 'gbfs', label: 'GBFS bikeshare', tier: 'keyless', envKeys: [] },
  { id: 'radio-browser', label: 'Radio Browser', tier: 'keyless', envKeys: [] },
]);

/** Public manifest rows (no env details). */
export function apiHealthManifest(services = API_HEALTH_SERVICES) {
  return services.map(({ id, label, tier }) => ({ id, label, tier }));
}

function hasValue(env, key) {
  return String(env?.[key] ?? '').trim().length > 0;
}

/** @returns {Record<string, string>} lowercase `id -> state` shorthand for tests. */
export function healthStateMap(results = []) {
  return Object.fromEntries(results.map((r) => [r.id, r.state]));
}

/** Summarize a completed result list for the loading screen. */
export function summarizeApiHealth(results = []) {
  const counts = Object.fromEntries(API_HEALTH_STATES.map((s) => [s, 0]));
  let requiredFailed = false;
  for (const r of results) {
    if (counts[r.state] === undefined) counts[r.state] = 0;
    counts[r.state] += 1;
    if (r.tier === 'required' && r.state !== 'ok' && r.state !== 'configured') requiredFailed = true;
  }
  return {
    total: results.length,
    live: counts.ok + counts.configured,
    degraded: counts.degraded,
    unconfigured: counts['key-missing'],
    failed: counts['key-invalid'] + counts.down,
    requiredFailed,
    counts,
  };
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Small fetch wrapper: adds UA, aborts on timeout, never throws on HTTP
 * status. Returns `{ status, text, json }` where `json` is best-effort.
 */
function makeRequest(fetchImpl, timeoutMs) {
  return async function request(url, { method = 'GET', headers = {}, body = undefined, readBody = true } = {}) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const res = await fetchImpl(url, {
        method,
        headers: { 'User-Agent': USER_AGENT, ...headers },
        body,
        redirect: 'follow',
        signal: controller?.signal,
      });
      let text = '';
      if (readBody && method !== 'HEAD') {
        try { text = await res.text(); } catch { text = ''; }
      }
      let json = null;
      if (text) {
        try { json = JSON.parse(text); } catch { json = null; }
      }
      return { status: res.status, ok: res.ok, text, json };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

function reachable(status) {
  return Number.isFinite(status) && status > 0;
}

/**
 * Build the probe table. Each probe returns `{ state, detail }`; thrown errors
 * are mapped to `down` by the runner.
 *
 * @param {object} deps
 * @param {(url: string, init?: object) => Promise<{status:number, ok:boolean, text:string, json:any}>} deps.request
 * @param {Record<string, string|undefined>} deps.env
 * @param {(path: string) => Promise<{status:number, ok:boolean, text:string, json:any}>} deps.localFetch
 * @param {() => Promise<string|null>} deps.getOpenSkyToken
 */
export function buildApiHealthProbes({ request, env, localFetch, getOpenSkyToken }) {
  const keyed = (key, probe, missingDetail) => async () => {
    if (!hasValue(env, key)) return { state: 'key-missing', detail: missingDetail };
    return probe();
  };

  const simpleGet = (url, okDetail, init) => async () => {
    const r = await request(url, init);
    if (r.ok) return { state: 'ok', detail: okDetail };
    if (r.status === 429) return { state: 'degraded', detail: 'rate limited' };
    return { state: 'down', detail: `HTTP ${r.status}` };
  };

  return {
    'google-maps': async () => {
      if (!hasValue(env, 'GOOGLE_MAPS_API_KEY')) {
        return { state: 'key-missing', detail: 'GOOGLE_MAPS_API_KEY not set' };
      }
      // Key presence + host reachability only. A keyed root.json request is
      // billable and counts against the daily root-request cap, so the
      // browser's own first tile request is the real validation.
      const r = await request('https://tile.googleapis.com/v1/3dtiles/root.json', { method: 'HEAD' });
      if (reachable(r.status)) return { state: 'ok', detail: 'key set · tile host reachable' };
      return { state: 'down', detail: 'tile host unreachable' };
    },

    'google-places': async () => {
      if (!hasValue(env, 'GOOGLE_MAPS_API_KEY')) return { state: 'key-missing', detail: 'uses Maps key' };
      return { state: 'configured', detail: 'billable · not probed' };
    },

    'cesium-ion': keyed('CESIUM_ION_TOKEN', async () => {
      const r = await request('https://api.cesium.com/v1/me', {
        headers: { Authorization: `Bearer ${env.CESIUM_ION_TOKEN}` },
      });
      if (r.ok) return { state: 'ok', detail: r.json?.username ? `as ${r.json.username}` : 'token accepted' };
      if (r.status === 401 || r.status === 403) return { state: 'key-invalid', detail: 'token rejected' };
      return { state: 'down', detail: `HTTP ${r.status}` };
    }, 'Bing stacks off'),

    openai: keyed('OPENAI_API_KEY', async () => {
      const r = await request('https://api.openai.com/v1/models?limit=1', {
        headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      });
      if (r.ok) return { state: 'ok', detail: 'key accepted' };
      if (r.status === 401) return { state: 'key-invalid', detail: 'key rejected' };
      if (r.status === 429) return { state: 'degraded', detail: 'rate limited or quota' };
      return { state: 'down', detail: `HTTP ${r.status}` };
    }, 'voice off'),

    opensky: async () => {
      const mode = String(env.OPENSKY_AUTH_MODE || 'oauth').toLowerCase();
      const hasOauth = hasValue(env, 'OPENSKY_CLIENT_ID') && hasValue(env, 'OPENSKY_CLIENT_SECRET');
      const hasBasic = hasValue(env, 'OPENSKY_USERNAME') && hasValue(env, 'OPENSKY_PASSWORD');
      const wantsOauth = mode === 'oauth' || (mode === 'auto' && hasOauth);
      const wantsBasic = mode === 'basic' || (mode === 'auto' && !hasOauth && hasBasic);
      if (wantsOauth) {
        if (!hasOauth) return { state: 'key-missing', detail: 'OAuth credentials not set' };
        const token = await getOpenSkyToken();
        if (token) return { state: 'ok', detail: 'OAuth token issued' };
        return { state: 'key-invalid', detail: 'OAuth token refused' };
      }
      // Anonymous and basic modes hit a tiny bounding box so a single probe
      // costs one credit at most.
      const headers = {};
      if (wantsBasic) {
        headers.Authorization = `Basic ${Buffer.from(`${env.OPENSKY_USERNAME}:${env.OPENSKY_PASSWORD}`).toString('base64')}`;
      }
      const r = await request(
        'https://opensky-network.org/api/states/all?lamin=37.7&lomin=-122.5&lamax=37.8&lomax=-122.4',
        { headers },
      );
      if (r.ok) return { state: 'ok', detail: wantsBasic ? 'basic auth accepted' : 'anonymous' };
      if (r.status === 401 || r.status === 403) return { state: 'key-invalid', detail: 'credentials rejected' };
      if (r.status === 429) return { state: 'degraded', detail: 'rate limited' };
      return { state: 'down', detail: `HTTP ${r.status}` };
    },

    'adsb-lol': simpleGet('https://api.adsb.lol/v2/hex/000000', 'reachable'),

    adsbdb: simpleGet('https://api.adsbdb.com/v0/online', 'reachable'),

    aisstream: keyed('AISSTREAM_API_KEY', async () => {
      // The dev server already holds the one allowed websocket; ask it rather
      // than opening a second upstream connection.
      const r = await localFetch('/api/ais-live?maxRows=1');
      const status = String(r.json?.status || '');
      if (status === 'live') return { state: 'ok', detail: 'stream live' };
      if (status === 'connecting' || status === 'starting' || status === 'idle') {
        return { state: 'degraded', detail: status };
      }
      if (r.json?.error) return { state: 'down', detail: String(r.json.error).slice(0, 80) };
      if (r.status === 503) return { state: 'key-missing', detail: 'not configured' };
      return { state: status ? 'degraded' : 'down', detail: status || `HTTP ${r.status}` };
    }, 'ships layer empty'),

    celestrak: async () => {
      const r = await request('https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=json');
      if (r.ok && Array.isArray(r.json) && r.json.length) return { state: 'ok', detail: 'ISS elements' };
      if (r.status === 403 || r.status === 429) return { state: 'degraded', detail: 'throttled' };
      return { state: r.ok ? 'degraded' : 'down', detail: r.ok ? 'empty response' : `HTTP ${r.status}` };
    },

    'launch-library': async () => {
      // Anonymous LL2 allows 15 API calls/hour, so only the site root is
      // touched; the launches proxy keeps a cached catalog for real use.
      const r = await request('https://ll.thespacedevs.com/', { method: 'HEAD' });
      if (!reachable(r.status)) return { state: 'down', detail: 'unreachable' };
      return {
        state: 'ok',
        detail: hasValue(env, 'LL2_API_TOKEN') ? 'token set · host reachable' : 'anonymous · host reachable',
      };
    },

    usgs: simpleGet('https://earthquake.usgs.gov/fdsnws/event/1/version', 'reachable'),

    firms: keyed('FIRMS_MAP_KEY', async () => {
      const r = await request(`https://firms.modaps.eosdis.nasa.gov/mapserver/mapkey_status/?MAP_KEY=${encodeURIComponent(env.FIRMS_MAP_KEY)}`);
      if (r.ok && r.json && Number.isFinite(Number(r.json.current_transactions))) {
        const used = Number(r.json.current_transactions);
        const limit = Number(r.json.transaction_limit);
        return { state: 'ok', detail: Number.isFinite(limit) ? `${used}/${limit} tx per 10 min` : 'key accepted' };
      }
      if (r.ok) return { state: 'key-invalid', detail: 'key not recognized' };
      return { state: 'down', detail: `HTTP ${r.status}` };
    }, 'fires layer empty'),

    tomtom: keyed('TOMTOM_API_KEY', async () => {
      const r = await request(`https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json?point=37.7749,-122.4194&key=${encodeURIComponent(env.TOMTOM_API_KEY)}`);
      if (r.ok) return { state: 'ok', detail: 'live flow' };
      if (r.status === 403 || r.status === 401) return { state: 'key-invalid', detail: 'key rejected' };
      if (r.status === 429) return { state: 'degraded', detail: 'quota exhausted' };
      return { state: 'down', detail: `HTTP ${r.status}` };
    }, 'simulated traffic'),

    overpass: async () => {
      const mirrors = ['https://overpass-api.de/api/status', 'https://overpass.kumi.systems/api/status'];
      let last = 'unreachable';
      for (const url of mirrors) {
        try {
          const r = await request(url);
          if (r.ok) return { state: 'ok', detail: new URL(url).host };
          last = `HTTP ${r.status}`;
        } catch (error) {
          last = error?.message || 'error';
        }
      }
      return { state: 'down', detail: last };
    },

    nominatim: simpleGet('https://nominatim.openstreetmap.org/status?format=json', 'reachable'),

    osrm: simpleGet('https://routing.openstreetmap.de/routed-car/nearest/v1/driving/-122.4194,37.7749', 'reachable'),

    'open-meteo': simpleGet('https://api.open-meteo.com/v1/forecast?latitude=37.77&longitude=-122.42&current=temperature_2m', 'reachable'),

    news: async () => {
      const r = await request('https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en', { method: 'HEAD' });
      if (r.ok) return { state: 'ok', detail: 'Google News RSS' };
      const g = await request('https://api.gdeltproject.org/api/v2/doc/doc?query=earth&mode=artlist&maxrecords=1&format=json');
      if (g.ok) return { state: 'degraded', detail: 'GDELT fallback only' };
      return { state: 'down', detail: `HTTP ${r.status}` };
    },

    'reearth-terrain': simpleGet('https://terrain.reearth.land/cesium-mesh/ellipsoid/layer.json', 'reachable'),

    'cctv-austin': async () => {
      const r = await request('https://data.austintexas.gov/resource/b4k4-adkb.json?$limit=1');
      if (r.ok) return { state: 'ok', detail: 'catalog reachable' };
      return { state: 'down', detail: `HTTP ${r.status}` };
    },

    'cctv-caltrans': async () => {
      const r = await request('https://cwwp2.dot.ca.gov/data/d4/cctv/cctvStatusD04.json', { method: 'HEAD' });
      if (r.ok) return { state: 'ok', detail: 'district feeds reachable' };
      return { state: 'down', detail: reachable(r.status) ? `HTTP ${r.status}` : 'unreachable' };
    },

    'cctv-tfl': async () => {
      const r = await request('https://api.tfl.gov.uk/Place/Meta/PlaceTypes');
      if (r.ok) return { state: 'ok', detail: hasValue(env, 'TFL_APP_KEY') ? 'app key set' : 'keyless' };
      if (r.status === 429) return { state: 'degraded', detail: 'rate limited' };
      return { state: 'down', detail: `HTTP ${r.status}` };
    },

    gbfs: simpleGet('https://gbfs.lyft.com/gbfs/2.3/bkn/en/station_status.json', 'Lyft feed reachable'),

    'radio-browser': simpleGet('https://all.api.radio-browser.info/json/stats', 'directory reachable'),
  };
}

/**
 * Run every probe in parallel. `onResult` fires as each settles so the
 * endpoint can stream progress; the resolved array is in catalog order.
 */
export async function runApiHealthProbes({
  fetchImpl = globalThis.fetch,
  env = process.env,
  localFetch = async () => ({ status: 0, ok: false, text: '', json: null }),
  getOpenSkyToken = async () => null,
  services = API_HEALTH_SERVICES,
  timeoutMs = API_HEALTH_PROBE_TIMEOUT_MS,
  now = () => Date.now(),
  onResult = () => {},
} = {}) {
  const request = makeRequest(fetchImpl, timeoutMs);
  const probes = buildApiHealthProbes({ request, env, localFetch, getOpenSkyToken });
  const results = await Promise.all(services.map(async (service) => {
    const startedAt = now();
    const probe = probes[service.id];
    let outcome;
    try {
      if (!probe) throw new Error(`no probe for ${service.id}`);
      outcome = await withTimeout(probe(), timeoutMs + 500, service.label);
    } catch (error) {
      const message = error?.name === 'AbortError' ? 'timed out' : (error?.message || 'error');
      outcome = { state: 'down', detail: message.slice(0, 120) };
    }
    const result = {
      id: service.id,
      label: service.label,
      tier: service.tier,
      state: API_HEALTH_STATES.includes(outcome?.state) ? outcome.state : 'down',
      detail: String(outcome?.detail || ''),
      ms: Math.max(0, now() - startedAt),
    };
    onResult(result);
    return result;
  }));
  return results;
}

/**
 * Vite plugin: `GET /api/health`.
 *
 * Default response is NDJSON so the loading screen can paint rows as probes
 * settle: a `manifest` line, one `result` line per service, then `done`.
 * `?format=json` waits for everything and returns one document (for scripts
 * and tests). Completed reports are cached for `API_HEALTH_REPORT_TTL_MS`;
 * `?fresh=1` bypasses the cache.
 *
 * @param {{ getOpenSkyToken?: () => Promise<string|null> }} [options]
 * @returns {import('vite').Plugin}
 */
export function apiHealthProxy({ getOpenSkyToken } = {}) {
  /** @type {{ at: number, results: object[] } | null} */
  let cached = null;
  /** @type {Promise<object[]> | null} */
  let inFlight = null;
  /** @type {Set<(result: object) => void>} */
  const listeners = new Set();

  function install(server) {
    const localFetch = async (pathname) => {
      const address = server.httpServer?.address();
      const port = typeof address === 'object' && address ? address.port : server.config?.server?.port;
      if (!port) return { status: 0, ok: false, text: '', json: null };
      // Bind address decides the loopback literal: `localhost` resolves to
      // ::1 first on modern Node, so 127.0.0.1 would be refused there.
      const bound = typeof address === 'object' && address ? String(address.address || '') : '';
      const host = bound === '::' || bound === '0.0.0.0' || bound === ''
        ? '127.0.0.1'
        : (bound.includes(':') ? `[${bound}]` : bound);
      const res = await fetch(`http://${host}:${port}${pathname}`, { headers: { 'User-Agent': USER_AGENT } });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { json = null; }
      return { status: res.status, ok: res.ok, text, json };
    };

    const start = () => {
      if (inFlight) return inFlight;
      inFlight = runApiHealthProbes({
        localFetch,
        getOpenSkyToken,
        onResult: (result) => { for (const fn of listeners) fn(result); },
      }).then((results) => {
        cached = { at: Date.now(), results };
        const summary = summarizeApiHealth(results);
        console.log(`[api-health] ${summary.live} live · ${summary.degraded} degraded · ${summary.unconfigured} no key · ${summary.failed} down`);
        for (const r of results) {
          if (r.state !== 'ok' && r.state !== 'configured') {
            console.warn(`[api-health] ${r.label}: ${r.state}${r.detail ? ` (${r.detail})` : ''}`);
          }
        }
        return results;
      }).finally(() => {
        inFlight = null;
        listeners.clear();
      });
      return inFlight;
    };

    server.middlewares.use('/api/health', async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' });
        res.end();
        return;
      }
      const url = new URL(req.url || '/', 'http://localhost');
      const wantJson = url.searchParams.get('format') === 'json';
      const fresh = url.searchParams.get('fresh') === '1';
      const warm = !fresh && cached && Date.now() - cached.at < API_HEALTH_REPORT_TTL_MS;

      if (wantJson) {
        const results = warm ? cached.results : await start();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({
          generatedAt: warm ? cached.at : Date.now(),
          cached: Boolean(warm),
          services: results,
          summary: summarizeApiHealth(results),
        }));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      });
      const write = (line) => { if (!res.writableEnded) res.write(`${JSON.stringify(line)}\n`); };
      write({ type: 'manifest', services: apiHealthManifest() });
      if (warm) {
        for (const result of cached.results) write({ type: 'result', ...result });
        write({ type: 'done', cached: true, summary: summarizeApiHealth(cached.results) });
        res.end();
        return;
      }
      const seen = new Set();
      const onResult = (result) => {
        seen.add(result.id);
        write({ type: 'result', ...result });
      };
      listeners.add(onResult);
      // Late joiners on an in-flight run: replay what already settled.
      // (The run only knows results once it resolves, so replay from the
      // final array for anything the listener missed.)
      try {
        const results = await start();
        for (const result of results) if (!seen.has(result.id)) write({ type: 'result', ...result });
        write({ type: 'done', cached: false, summary: summarizeApiHealth(results) });
      } catch (error) {
        write({ type: 'error', message: error?.message || 'health run failed' });
      } finally {
        listeners.delete(onResult);
        res.end();
      }
    });
  }

  return {
    name: 'api-health',
    configureServer: install,
    configurePreviewServer: install,
  };
}
