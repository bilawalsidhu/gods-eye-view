import { UK_FEEDS } from '../../src/regional/ukCatalog.js';
import {
  normalizeUkFeed,
  rssRows,
  inUkBounds,
  isoTime,
  text,
} from '../../src/regional/ukDataModel.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

const EA = 'https://environment.data.gov.uk/flood-monitoring';
export const UK_UPSTREAMS = Object.freeze({
  'ea-floods': `${EA}/id/floods`,
  'ea-rivers': `${EA}/id/stations?_limit=10000`,
  'ea-readings': `${EA}/data/readings?latest&parameter=level&_limit=10000`,
  'sepa-rivers':
    'https://timeseries.sepa.org.uk/KiWIS/KiWIS?service=kisters&type=queryServices&datasource=0&request=getTimeseriesValueLayer&timeseriesgroup_id=41804&format=geojson&returnfields=timestamp,ts_value,q_code&metadata=true&md_returnfields=station_name,station_no,ts_path',
  air: 'https://uk-air.defra.gov.uk/sos-ukair/api/v1/stations?expanded=true',
  weather:
    'https://aviationweather.gov/api/data/metar?bbox=49.8,-8.6,61,2&format=json',
  'london-roads': 'https://api.tfl.gov.uk/Road/all/Disruption',
  'london-rail':
    'https://api.tfl.gov.uk/Line/Mode/tube,dlr,overground,elizabeth-line,tram/Status',
  'wales-incidents': 'https://traffic.wales/feeds/incidents-events/rss.xml',
  'wales-roadworks': 'https://traffic.wales/feeds/roadworks/rss.xml',
  'ni-incidents':
    'https://rss.trafficwatchni.com/trafficwatchni_incidents_rss.xml',
  'ni-roadworks':
    'https://rss.trafficwatchni.com/trafficwatchni_roadworks_rss.xml',
  'ni-events': 'https://rss.trafficwatchni.com/trafficwatchni_events_rss.xml',
});

export function createUkDataService({
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  const cache = new Map(),
    pending = new Map(),
    controllers = new Set();
  let closed = false;
  async function read(url) {
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetchImpl(url, {
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Accept: 'application/json, application/rss+xml, application/xml',
          'User-Agent':
            'GodsEyeView UK public data (https://github.com/bilawalsidhu/gods-eye-view)',
        },
      });
      if (!response.ok) throw new Error('Provider unavailable');
      if (response.status === 204) return '[]';
      const chunks = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > 12 * 1024 * 1024) {
          controller.abort();
          throw new Error('Provider response too large');
        }
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks).toString('utf8');
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
    }
  }
  function cached(key, ttl, load) {
    if (closed) return Promise.reject(new Error('Service closed'));
    const old = cache.get(key);
    if (old && now() - old.at < ttl) return Promise.resolve(old.value);
    if (pending.has(key)) return pending.get(key);
    const promise = Promise.resolve()
      .then(load)
      .then((value) => {
        if (!closed) {
          if (cache.size >= 80 && !cache.has(key))
            cache.delete(cache.keys().next().value);
          cache.set(key, { at: now(), value });
        }
        return value;
      })
      .finally(() => pending.delete(key));
    pending.set(key, promise);
    return promise;
  }
  async function feed(id) {
    const info = UK_FEEDS.find((f) => f.id === id);
    if (!info || !Object.hasOwn(UK_UPSTREAMS, id))
      throw new Error('Unknown feed');
    try {
      return await cached(id, info.interval, async () => {
        const raw = await read(UK_UPSTREAMS[id]);
        const extra =
          id === 'ea-rivers'
            ? JSON.parse(await read(UK_UPSTREAMS['ea-readings']))
            : {};
        const rows =
          id.startsWith('ni-') || id.startsWith('wales-')
            ? rssRows(raw, info.page)
            : normalizeUkFeed(id, JSON.parse(raw), extra);
        return {
          id,
          status: 'available',
          retrievedAt: new Date(now()).toISOString(),
          coverage: info.coverage,
          credit: info.credit,
          source: info.page,
          message: rows.truncated
            ? 'The provider response exceeded the 5,000-record safety limit; some records are omitted.'
            : '',
          rows,
        };
      });
    } catch {
      const old = cache.get(id);
      if (old && now() - old.at < 6 * 3600000)
        return {
          ...old.value,
          status: 'stale',
          message:
            'Provider unavailable; showing the previous retrieval with its original time',
        };
      return {
        id,
        status: 'unavailable',
        retrievedAt: null,
        coverage: info.coverage,
        credit: info.credit,
        source: info.page,
        message:
          'The official provider could not be reached. This is not an empty or all-clear result.',
        rows: [],
      };
    }
  }
  async function airSeries(id) {
    if (!/^\d{1,12}$/.test(id)) return null;
    const stations = await feed('air');
    if (!stations.rows.some((row) => row.series?.includes(id))) return null;
    return cached(`air:${id}`, 3600000, async () => {
      const data = JSON.parse(
        await read(
          `https://uk-air.defra.gov.uk/sos-ukair/api/v1/timeseries/${id}?expanded=true`,
        ),
      );
      const coords = data.station?.geometry?.coordinates || [];
      if (
        !inUkBounds(coords[0], coords[1]) &&
        !inUkBounds(coords[1], coords[0])
      )
        throw new Error('Station outside UK extent');
      return {
        id,
        status: 'available',
        time: isoTime(data.lastValue?.timestamp),
        value: Number.isFinite(data.lastValue?.value)
          ? data.lastValue.value
          : null,
        unit: text(data.uom, 100),
        retrievedAt: new Date(now()).toISOString(),
      };
    });
  }
  return {
    feed,
    airSeries,
    close() {
      closed = true;
      for (const controller of controllers) controller.abort();
      cache.clear();
      pending.clear();
    },
  };
}

export function ukDataProxy(options = {}) {
  const service = createUkDataService(options);
  const allow = makeRateLimiter({ windowMs: 60000, max: 50, globalMax: 200 });
  function install(server) {
    server.middlewares.use('/api/uk-data', async (req, res) => {
      const send = (status, data) => {
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(data));
      };
      if (req.method !== 'GET')
        return send(405, { error: 'Method not allowed' });
      if (!allow(clientKey(req)))
        return send(429, { error: 'Please wait before refreshing again' });
      const route = new URL(req.url || '/', 'http://localhost');
      if (route.search)
        return send(400, { error: 'Unexpected query parameters' });
      try {
        const air = route.pathname.match(/^\/air\/(\d{1,12})$/);
        if (air) {
          const value = await service.airSeries(air[1]);
          return send(
            value ? 200 : 404,
            value || { error: 'Unknown station series' },
          );
        }
        const id = route.pathname.slice(1);
        if (!Object.hasOwn(UK_UPSTREAMS, id) || id === 'ea-readings')
          return send(404, { error: 'Unknown UK feed' });
        send(200, await service.feed(id));
      } catch {
        send(502, { error: 'The public data provider is unavailable' });
      }
    });
    server.httpServer?.once('close', service.close);
  }
  return {
    name: 'uk-public-data',
    configureServer: install,
    configurePreviewServer: install,
    closeBundle: service.close,
  };
}
