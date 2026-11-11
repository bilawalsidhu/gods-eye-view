// Wildlife Sightings without the network: the app's own iNaturalist and
// Acartia proxies (server/providers) answer the preview's /api routes in
// this process, over upstream feeds faked here. Four sightings over the
// Salish Sea: three iNaturalist observations (one with an obscured
// location, drawn as its privacy cell) and one Acartia orca report.
import { installInatProxy } from '../../server/providers/inaturalist/proxy.fixture.mjs';
import { syntheticGrid } from '../../server/providers/inaturalist/grid.fixture.mjs';
import { acartiaProxy } from '../../server/providers/acartia.js';

/** The view the scenario frames (straight down). */
export const WILDLIFE_VIEW = Object.freeze({
  lat: 48.4,
  lon: -123.1,
  alt: 200000,
});

const HOUR_MS = 3_600_000;
// iNaturalist iconic taxon ids, as the UTFGrid carries them.
const ICONIC_IDS = { Aves: 3, Mammalia: 40151, Plantae: 47126 };

/**
 * The sightings as the browser draws them (`lat`/`lon` after the proxy's
 * projection: an obscured record sits at the centre of its 0.2° cell, an
 * Acartia report is rounded to 0.01°), with what the upstream feeds send.
 */
export const WILDLIFE_SIGHTINGS = Object.freeze([
  {
    id: 'inat:910001',
    name: 'Bald Eagle',
    scientific: 'Haliaeetus leucocephalus',
    iconic: 'Aves',
    raw: [48.4, -123.1],
    lat: 48.4,
    lon: -123.1,
  },
  {
    id: 'inat:910002',
    name: "Douglas's Squirrel",
    scientific: 'Tamiasciurus douglasii',
    iconic: 'Mammalia',
    raw: [48.46, -122.92],
    lat: 48.46,
    lon: -122.92,
  },
  {
    id: 'inat:910003',
    name: 'Western Redcedar',
    scientific: 'Thuja plicata',
    iconic: 'Plantae',
    obscured: true,
    raw: [48.31, -123.29],
    lat: 48.3,
    lon: -123.3,
    cell: { south: 48.2, west: -123.4, north: 48.4, east: -123.2 },
  },
  {
    id: 'acartia:qa-orca-1',
    name: 'Orca',
    origin: 'acartia',
    raw: [48.5234, -123.2167],
    lat: 48.52,
    lon: -123.22,
  },
]);

const inat = WILDLIFE_SIGHTINGS.filter((s) => s.id.startsWith('inat:'));
const acartia = WILDLIFE_SIGHTINGS.filter((s) => s.origin === 'acartia');

/** An API v2 observation, with the fields the proxy asks for. */
function observation(sighting, nowMs) {
  const id = Number(sighting.id.slice(5));
  const [lat, lon] = sighting.raw;
  const time = new Date(nowMs - 3 * HOUR_MS);
  return {
    id,
    uri: `https://www.inaturalist.org/observations/${id}`,
    location: `${lat},${lon}`,
    geojson: { type: 'Point', coordinates: [lon, lat] },
    geoprivacy: sighting.obscured ? 'obscured' : null,
    taxon_geoprivacy: null,
    obscured: sighting.obscured === true,
    quality_grade: 'research',
    observed_on: time.toISOString().slice(0, 10),
    time_observed_at: time.toISOString(),
    faves_count: 1,
    num_identification_agreements: 2,
    // The feed asks for observations with photos; these carry no open
    // licence, so no thumbnail is fetched.
    photos: [
      {
        url: `https://inaturalist-open-data.s3.amazonaws.com/photos/${id}/square.jpeg`,
        attribution: '(c) QA observer, all rights reserved',
        license_code: null,
      },
    ],
    taxon: {
      name: sighting.scientific,
      preferred_common_name: sighting.name,
      iconic_taxon_name: sighting.iconic,
      threatened: false,
    },
  };
}

/** Web Mercator tile coordinates of a point at zoom z (fractional). */
function tileOf(lat, lon, z) {
  const count = 2 ** z;
  const sin = Math.sin((lat * Math.PI) / 180);
  return {
    x: ((lon + 180) / 360) * count,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * count,
  };
}

/**
 * The faked upstream feeds: iNaturalist observations (filtered by the
 * request's box), its UTFGrid density tiles, and the Acartia snapshot.
 * `calls` counts what each upstream was asked.
 */
export function wildlifeUpstream({ now = () => Date.now() } = {}) {
  const calls = { observations: 0, grid: 0, acartia: 0 };
  async function fetchImpl(href) {
    const url = new URL(href);
    if (url.host === 'acartia.io') {
      calls.acartia++;
      const created = new Date(now() - 2 * HOUR_MS)
        .toISOString()
        .slice(0, 19)
        .replace('T', ' ');
      return Response.json(
        acartia.map((s) => ({
          entry_id: s.id.slice(8),
          latitude: s.raw[0],
          longitude: s.raw[1],
          created,
          type: s.name,
          no_sighted: '3',
          data_source_name: 'QA Whale Network',
          data_source_entity: 'Community reports',
          trusted: true,
        })),
      );
    }
    if (url.host !== 'api.inaturalist.org')
      throw Error('unexpected upstream ' + url.host);
    const grid = /^\/v1\/grid\/(\d+)\/(\d+)\/(\d+)\.grid\.json$/.exec(
      url.pathname,
    );
    if (grid) {
      calls.grid++;
      const [z, x, y] = grid.slice(1).map(Number);
      const cells = [];
      for (const s of inat) {
        const at = tileOf(s.raw[0], s.raw[1], z);
        if (Math.floor(at.x) !== x || Math.floor(at.y) !== y) continue;
        cells.push({
          row: Math.min(63, Math.floor((at.y - y) * 64)),
          column: Math.min(63, Math.floor((at.x - x) * 64)),
          count: 4,
          iconic: ICONIC_IDS[s.iconic],
        });
      }
      return Response.json(syntheticGrid({ z, x, y, cells }));
    }
    if (url.pathname === '/v2/observations') {
      calls.observations++;
      const box = ['swlat', 'swlng', 'nelat', 'nelng'].map((key) =>
        url.searchParams.has(key) ? Number(url.searchParams.get(key)) : null,
      );
      const inside = ({ raw: [lat, lon] }) =>
        box[0] === null ||
        (lat >= box[0] && lat <= box[2] && lon >= box[1] && lon <= box[3]);
      const results = inat.filter(inside).map((s) => observation(s, now()));
      return Response.json({
        total_results: results.length,
        page: 1,
        per_page: 200,
        results,
      });
    }
    throw Error('unexpected upstream path ' + url.pathname);
  }
  return { fetchImpl, calls };
}

/** Mount an /api/acartia proxy over synthetic HTTP objects. */
function installAcartiaProxy(options) {
  let handler;
  acartiaProxy({ warn() {}, ...options }).configurePreviewServer({
    middlewares: {
      use(mount, callback) {
        if (mount !== '/api/acartia') throw Error('acartia mount ' + mount);
        handler = callback;
      },
    },
  });
  return async (url, { headers = {} } = {}) => {
    const res = {
      headers: {},
      writeHead(status, values) {
        this.status = status;
        Object.assign(this.headers, values);
      },
      setHeader(key, value) {
        this.headers[key] = value;
      },
      end(value) {
        this.status ??= this.statusCode;
        this.body = JSON.parse(value);
      },
    };
    await handler(
      { url, method: 'GET', headers, socket: { remoteAddress: '127.0.0.1' } },
      res,
    );
    return res;
  };
}

/**
 * Strict-harness routes for the preview's wildlife API: each request is
 * answered by the app's own proxy in this process (it never reaches the
 * preview, so the preview never calls the real providers). `asked` counts
 * the browser's requests per route.
 */
export function wildlifeRoutes(origin, options = {}) {
  const upstream = wildlifeUpstream(options);
  const proxies = {
    '/api/inaturalist': installInatProxy('/observations', {
      fetchImpl: upstream.fetchImpl,
      now: options.now ?? (() => Date.now()),
    }),
    '/api/acartia': installAcartiaProxy({
      fetchImpl: upstream.fetchImpl,
      now: options.now ?? (() => Date.now()),
    }),
  };
  const asked = { observations: 0, grid: 0, acartia: 0 };
  const route = (mount) => ({
    pattern: `${origin}${mount}/*`,
    async respond(request) {
      const url = new URL(request.url);
      const path = url.pathname.slice(mount.length);
      asked[mount === '/api/acartia' ? 'acartia' : path.slice(1)]++;
      const headers = { host: url.host };
      for (const [name, value] of Object.entries(request.headers ?? {}))
        headers[name.toLowerCase()] = value;
      const res = await proxies[mount](path + url.search, { headers });
      return {
        status: res.status,
        contentType: 'application/json',
        body: JSON.stringify(res.body),
      };
    },
  });
  return {
    routes: [route('/api/inaturalist'), route('/api/acartia')],
    asked,
    upstream: upstream.calls,
  };
}
