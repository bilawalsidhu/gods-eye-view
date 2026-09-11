import { SIGNAL_LIMIT, parseSignalSnapshot } from './data/trafficSignalsModel.js';
import { PUBLIC_SIGNAL_PROVIDERS, fetchPublicSignalSnapshot, readSignalJson } from './trafficSignalsProviders.js';

export function trafficSignalsProxy(env = {}, fetchImpl = fetch) {
  let active = 0;
  const endpoint = env.TRAFFIC_SIGNALS_FEED_URL;
  const install = (server) => {
    server.middlewares.use('/api/traffic-signals', async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET') return reply(405, { error: 'GET required' });
    const request = new URL(req.url, 'http://localhost');
    if (request.pathname === '/status') return reply(200, { configured: true,
      customFeedConfigured: Boolean(endpoint), worldwideLiveCoverage: false, providers: PUBLIC_SIGNAL_PROVIDERS });
    if (request.pathname !== '/snapshot') return reply(404, { error: 'Unknown signal endpoint' });
    const names = ['south', 'west', 'north', 'east'];
    const values = names.map((name) => request.searchParams.get(name));
    if (values.some((value) => value == null || !value.trim())) return reply(400, { error: 'Bounds required' });
    const [south, west, north, east] = values.map(Number);
    if (![south, west, north, east].every(Number.isFinite)
      || south < -90 || north > 90 || west < -180 || east > 180
      || north <= south || east <= west || north - south > 0.051 || east - west > 0.051) {
      return reply(400, { error: 'Invalid bounds (maximum span 0.05 degrees)' });
    }
    if (active >= 4) return reply(429, { error: 'Signal feed busy' });
    active++;
    try {
      if (!endpoint) return reply(200, await fetchPublicSignalSnapshot({ south, west, north, east }, fetchImpl));
      const url = new URL(endpoint);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
        throw new Error('Feed requires HTTPS or loopback HTTP');
      }
      names.forEach((name, index) => url.searchParams.set(name, String([south, west, north, east][index])));
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(2500), redirect: 'error', cache: 'no-store',
        headers: { Accept: 'application/json', ...(env.TRAFFIC_SIGNALS_FEED_TOKEN
          ? { Authorization: `Bearer ${env.TRAFFIC_SIGNALS_FEED_TOKEN}` } : {}) },
      });
      const payload = await readSignalJson(response);
      const parsed = parseSignalSnapshot(payload, 0, 0);
      if (payload.signals.length > SIGNAL_LIMIT) throw new Error('Too many signals');
      // Return only contract fields. Provider-specific fields may contain credentials.
      const signals = [...parsed.signals.values()]
        .filter((s) => s.lat >= south && s.lat <= north && s.lon >= west && s.lon <= east)
        .map((s) => Object.fromEntries([
          'id', 'lat', 'lon', 'name', 'source', 'movement', 'state', 'observedAtEpochMs',
          'validUntilEpochMs', 'changeAtEpochMs', 'uncertaintyMs', 'resolutionMs', 'observationOnly',
        ].filter((key) => s[key] !== undefined).map((key) => [key, s[key]])));
      reply(200, { serverTimeEpochMs: payload.serverTimeEpochMs, clockUncertaintyMs: payload.clockUncertaintyMs, signals });
    } catch {
      reply(502, { error: 'Live signal feed unavailable or invalid' });
    } finally {
      active--;
    }
    });
  };
  return { name: 'traffic-signals-proxy', configureServer: install, configurePreviewServer: install };
}
