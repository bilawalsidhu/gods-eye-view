import { JERSEY_PARISHES } from '../../src/sources/jerseyParishes.js';
import {
  readResponseTextCapped,
  readResponseJsonCapped,
} from '../../src/sources/httpBody.js';

const MINUTE = 60000;
const OPEN = 'https://api.opendata.je/v1/';
const ROAD =
  'https://roadworks.gov.je/arcgis/rest/services/JSW/MapServer/3/query';
const SOURCES = {
  'parish-news': [
    null,
    60 * MINUTE,
    'Jersey parish websites',
    'https://comite.je/jerseys-12-parishes/',
  ],
  buses: [
    OPEN + 'bus/live-updates?secondsAgo=300',
    MINUTE,
    'Jersey Open Data / LibertyBus',
    'https://opendata.je/docs/endpoints/buses/updates/',
  ],
  stops: [
    OPEN + 'bus/stops',
    30 * MINUTE,
    'Jersey Open Data / LibertyBus',
    'https://opendata.je/docs/endpoints/buses/stops/',
  ],
  parking: [
    OPEN + 'carparks',
    60 * MINUTE,
    'Jersey Open Data / Government of Jersey',
    'https://opendata.je/docs/endpoints/carparks/',
  ],
  spaces: [
    OPEN + 'carparks/spaces',
    MINUTE,
    'Government of Jersey / Jersey Open Data',
    'https://opendata.je/docs/endpoints/carparks/parking-spaces/',
  ],
  toilets: [
    OPEN + 'toilets',
    60 * MINUTE,
    'Government of Jersey / Jersey Open Data',
    'https://opendata.je/docs/endpoints/toilets/',
  ],
  eatsafe: [
    OPEN + 'eatsafe',
    60 * MINUTE,
    'Government of Jersey / Jersey Open Data',
    'https://opendata.je/docs/endpoints/eatsafe/',
  ],
  recycling: [
    OPEN + 'recycling',
    60 * MINUTE,
    'Government of Jersey / Jersey Open Data',
    'https://opendata.je/docs/endpoints/recycling/',
  ],
  defibrillators: [
    OPEN + 'defibrillators',
    60 * MINUTE,
    'Government of Jersey / Jersey Open Data',
    'https://opendata.je/docs/endpoints/defibrillators/',
  ],
  forecast: [
    'https://prodgojweatherstorage.blob.core.windows.net/data/jerseyForecast.json',
    5 * MINUTE,
    'Jersey Met',
    'https://www.gov.je/weather/',
  ],
  marine: [
    'https://pojcdn.blob.core.windows.net/data/weather.json',
    5 * MINUTE,
    'Ports of Jersey / Jersey Met',
    'https://www.ports.je/weather/',
  ],
  buoy: [
    'https://pojsftp.blob.core.windows.net/bouydata/DataBuoy1/latest.json',
    5 * MINUTE,
    'Ports of Jersey / Jersey Coastguard',
    'https://www.ports.je/weather/',
  ],
  roadworks: [
    ROAD,
    15 * MINUTE,
    'Government of Jersey / Jersey RoadWorkx',
    'https://roadworks.gov.je/',
  ],
};

/** Inverse of the provider's NewJTM (EPSG:3109), using its published GRS80 parameters. */
export function jerseyGridToDegrees(x, y) {
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 20000 ||
    x > 60000 ||
    y < 45000 ||
    y > 85000
  )
    return null;
  const a = 6378137,
    f = 1 / 298.257222101,
    e2 = f * (2 - f),
    e4 = e2 * e2,
    e6 = e4 * e2,
    k = 0.9999999;
  const p0 = (49.225 * Math.PI) / 180;
  const arc = (p) =>
    a *
    ((1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * p -
      ((3 * e2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * p) +
      ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * p) -
      ((35 * e6) / 3072) * Math.sin(6 * p));
  const mu =
    (arc(p0) + (y - 70000) / k) /
    (a * (1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const p =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const ep = e2 / (1 - e2),
    t = Math.tan(p) ** 2,
    c = ep * Math.cos(p) ** 2;
  const n = a / Math.sqrt(1 - e2 * Math.sin(p) ** 2),
    r = (a * (1 - e2)) / (1 - e2 * Math.sin(p) ** 2) ** 1.5,
    d = (x - 40000) / (n * k);
  const lat =
    p -
    ((n * Math.tan(p)) / r) *
      (d ** 2 / 2 -
        ((5 + 3 * t + 10 * c - 4 * c ** 2 - 9 * ep) * d ** 4) / 24 +
        ((61 + 90 * t + 298 * c + 45 * t ** 2 - 252 * ep - 3 * c ** 2) *
          d ** 6) /
          720);
  const lon =
    (-2.135 * Math.PI) / 180 +
    (d -
      ((1 + 2 * t + c) * d ** 3) / 6 +
      ((5 - 2 * c + 28 * t - 3 * c ** 2 + 8 * ep + 24 * t ** 2) * d ** 5) /
        120) /
      Math.cos(p);
  return [(lon * 180) / Math.PI, (lat * 180) / Math.PI];
}

function inJersey(row) {
  return (
    Number.isFinite(row?.latitude) &&
    Number.isFinite(row?.longitude) &&
    row.latitude >= 49.05 &&
    row.latitude <= 49.3 &&
    row.longitude >= -2.3 &&
    row.longitude <= -2
  );
}

/** Normalize public road geometry without trusting the service's incorrect outSR metadata. */
export function normalizeJerseyRoadworks(payload) {
  if (
    payload.error ||
    !Array.isArray(payload.features) ||
    payload.exceededTransferLimit
  )
    throw new Error('Incomplete roadworks feed');
  const seen = new Set();
  return payload.features.flatMap((feature) => {
    const p = feature.attributes;
    if (!p || /cancel|reject|complete/i.test(p.STATUS || '')) return [];
    const key = [p.NAME, p.Location, p.S_DATE, p.E_DATE].join('|');
    if (seen.has(key)) return [];
    const paths = (feature.geometry?.paths || [])
      .map((path) =>
        path
          .map((pair) => jerseyGridToDegrees(pair[0], pair[1]))
          .filter(Boolean),
      )
      .filter((path) => path.length > 1);
    if (!paths.length) return [];
    seen.add(key);
    const mid = paths[0][Math.floor(paths[0].length / 2)];
    return [
      {
        id: String(p.FID),
        name: p.Location || p.NAME,
        latitude: mid[1],
        longitude: mid[0],
        paths,
        start: p.S_DATE,
        end: p.E_DATE,
        status: p.STATUS,
        description: [p.Type, p.WorkType, p.Timing, p.DESCRIPT]
          .filter(Boolean)
          .join(' · '),
      },
    ];
  });
}

/** Read only public RSS headlines, links and dates; do not redistribute article bodies. */
export function parseParishHeadlines(xml, parish, domain) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || !/<rss[\s>]/i.test(xml))
    throw new Error('Invalid parish feed');
  const decode = (text) =>
    text
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(
        /&(?:amp|quot|apos|lt|gt);/g,
        (entity) =>
          ({
            '&amp;': '&',
            '&quot;': '"',
            '&apos;': "'",
            '&lt;': '<',
            '&gt;': '>',
          })[entity],
      )
      .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_, number) => {
        const n =
          number[0].toLowerCase() === 'x'
            ? parseInt(number.slice(1), 16)
            : Number(number);
        return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
      })
      .replace(/<[^>]*>/g, '')
      .trim();
  const results = [];
  for (const item of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const field = (key) =>
      decode(
        item[0].match(
          new RegExp(
            '<' + key + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + key + '>',
            'i',
          ),
        )?.[1] || '',
      );
    const title = field('title').slice(0, 300),
      link = field('link'),
      time = Date.parse(field('pubDate'));
    let url;
    try {
      url = new URL(link);
    } catch {
      continue;
    }
    if (
      !title ||
      url.protocol !== 'https:' ||
      url.hostname !== domain ||
      url.username ||
      url.password ||
      url.port ||
      !Number.isFinite(time)
    )
      continue;
    results.push({
      parish,
      title,
      url: url.href,
      publishedAt: new Date(time).toISOString(),
    });
    if (results.length === 10) break;
  }
  return results;
}

async function loadParishNews(fetchImpl) {
  const results = [],
    unavailable = [];
  // Bounded fan-out: three official websites at a time, then cache the island snapshot.
  for (let offset = 0; offset < JERSEY_PARISHES.length; offset += 3) {
    const batch = JERSEY_PARISHES.slice(offset, offset + 3);
    const responses = await Promise.allSettled(
      batch.map(async ([name, , , domain]) => {
        const signal = AbortSignal.timeout(4000);
        const response = await fetchImpl('https://' + domain + '/feed/', {
          redirect: 'error',
          signal,
          headers: { 'User-Agent': 'Gods-Eye-View-Jersey/1.0' },
        });
        if (!response.ok) throw new Error('Unavailable');
        return parseParishHeadlines(
          await readResponseTextCapped(response, 512 * 1024, signal),
          name,
          domain,
        );
      }),
    );
    responses.forEach((result, index) => {
      if (result.status === 'fulfilled') results.push(...result.value);
      else unavailable.push(batch[index][0]);
    });
  }
  if (unavailable.length === 12) throw new Error('Parish feeds unavailable');
  results.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  return { results, unavailable };
}

/** Fixed-source, cached public Jersey feeds. No caller-supplied URL or precise user location leaves the browser. */
export function jerseyLocalPlugin({ fetchImpl = fetch, now = Date.now } = {}) {
  const cache = new Map(),
    pending = new Map();
  async function load(type, stop) {
    const definition =
      type === 'departures'
        ? [
            OPEN + 'bus/stops/' + stop,
            MINUTE,
            'Jersey Open Data / LibertyBus',
            'https://opendata.je/docs/endpoints/buses/stop-info/',
          ]
        : SOURCES[type];
    const key = type + (stop || '');
    const previous = cache.get(key);
    if (previous && now() - previous.at < definition[1]) return previous.body;
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= 32) throw new Error('Public feed busy');
    const request = (async () => {
      if (type === 'parish-news') {
        const payload = await loadParishNews(fetchImpl);
        const body = JSON.stringify({
          ...payload,
          fetchedAt: now(),
          source: definition[2],
          sourceUrl: definition[3],
          type,
        });
        cache.set(key, { at: now(), body });
        return body;
      }
      let url = definition[0];
      if (type === 'roadworks') {
        const date = new Date(now());
        const start = date.toISOString().slice(0, 10).replaceAll('-', '');
        date.setUTCDate(date.getUTCDate() + 30);
        const end = date.toISOString().slice(0, 10).replaceAll('-', '');
        url +=
          '?' +
          new URLSearchParams({
            where: `E_DATE >= '${start}' AND S_DATE <= '${end}'`,
            outFields:
              'FID,NAME,S_DATE,E_DATE,STATUS,DESCRIPT,Location,Type,WorkType,Timing',
            f: 'json',
          });
      }
      const signal = AbortSignal.timeout(15000);
      const response = await fetchImpl(url, {
        redirect: 'error',
        signal,
        headers: { 'User-Agent': 'Gods-Eye-View-Jersey/1.0' },
      });
      if (!response.ok) throw new Error('Public feed unavailable');
      const payload = await readResponseJsonCapped(
        response,
        4 * 1024 * 1024,
        signal,
      );
      let results;
      if (type === 'roadworks') results = normalizeJerseyRoadworks(payload);
      else if (['forecast', 'marine', 'buoy'].includes(type)) {
        const valid =
          type === 'forecast'
            ? Array.isArray(payload.forecastDay)
            : type === 'marine'
              ? payload.CurrentTide && payload.ShippingForecast
              : payload.latest && payload.sites;
        if (!valid) throw new Error('Invalid public feed');
        results = payload;
      } else if (type === 'departures') {
        if (
          !inJersey(payload.results) ||
          !Array.isArray(payload.results.departures)
        )
          throw new Error('Invalid stop');
        results = payload.results;
      } else {
        if (!Array.isArray(payload.results))
          throw new Error('Invalid public feed');
        results =
          type === 'spaces'
            ? payload.results
            : payload.results.filter(inJersey);
      }
      const body = JSON.stringify({
        results,
        fetchedAt: now(),
        source: definition[2],
        sourceUrl: definition[3],
        type,
      });
      if (cache.size >= 1000) cache.delete(cache.keys().next().value);
      cache.set(key, { at: now(), body });
      return body;
    })();
    pending.set(key, request);
    try {
      return await request;
    } finally {
      pending.delete(key);
    }
  }
  const middleware = async (req, res, next) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/api/transit/jersey-local') return next();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    const type = url.searchParams.get('type') || 'buses',
      stop = url.searchParams.get('stop');
    const keys = [...url.searchParams.keys()];
    if (
      req.method !== 'GET' ||
      (!Object.hasOwn(SOURCES, type) && type !== 'departures') ||
      keys.length !== new Set(keys).size ||
      keys.some(
        (key) => key !== 'type' && !(type === 'departures' && key === 'stop'),
      ) ||
      (type === 'departures' && !/^\d{1,5}$/.test(stop || ''))
    ) {
      res.statusCode = 400;
      return res.end('{"error":"Invalid Jersey request"}');
    }
    try {
      res.end(await load(type, stop));
    } catch {
      res.statusCode = 503;
      res.end('{"error":"Jersey feed temporarily unavailable"}');
    }
  };
  const install = (server) => {
    server.middlewares.use(middleware);
  };
  return {
    name: 'jersey-local-public-data',
    configureServer: install,
    configurePreviewServer: install,
  };
}
