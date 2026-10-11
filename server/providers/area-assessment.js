import {
  readResponseJsonCapped,
  readCappedResponseText,
} from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { resolveOverpassUpstreams } from './overpass/constants.js';
import { readGemHazard } from './area/hazard.js';
import { createNearbySearch } from './area/nearby.js';
import { createItalianHousingProvider } from './area/italianHousing.js';
import { enqueueNominatim } from './regional/place.js';
import {
  finiteValue,
  summarizeServices,
} from '../../src/data/areaAssessment.js';

const identity =
  'gods-eye-view/0.2 (+https://github.com/bilawalsidhu/gods-eye-view)';
const dvf =
  'https://tabular-api.data.gouv.fr/api/resources/03fba98d-885b-43c0-8986-d299cabc29da/data/';
const unavailable = (reason) => ({ status: 'unavailable', reason });

/** Fixed providers only: clients cannot choose a URL or read a local file. */
async function json(url, options = {}, cap = 4 * 1024 * 1024) {
  const signal = AbortSignal.timeout(25000);
  const response = await fetch(url, {
    ...options,
    redirect: 'error',
    signal,
    headers: { 'User-Agent': identity, ...options.headers },
  });
  if (!response.ok)
    throw new Error(`Source unavailable (HTTP ${response.status})`);
  return readResponseJsonCapped(response, cap, signal);
}

async function text(url) {
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(25000),
    headers: { 'User-Agent': identity },
  });
  if (!response.ok) throw new Error('OMI source unavailable');
  const result = await readCappedResponseText(response, 512000);
  if (result.tooLarge) throw new Error('OMI response too large');
  return result.text;
}
const italianHousing = createItalianHousingProvider({ json, text });

async function air(point) {
  const params = new URLSearchParams({
    latitude: point.lat,
    longitude: point.lon,
    current: 'us_aqi,pm2_5,pm10,nitrogen_dioxide,ozone',
    domains: 'auto',
  });
  const payload = await json(
    `https://air-quality-api.open-meteo.com/v1/air-quality?${params}`,
  );
  const current = payload.current;
  if (!current || finiteValue(current.us_aqi) == null || current.us_aqi < 0)
    return unavailable('The model does not provide a value at this point.');
  return {
    status: 'available',
    aqi: current.us_aqi,
    pm25: current.pm2_5,
    pm10: current.pm10,
    no2: current.nitrogen_dioxide,
    ozone: current.ozone,
    date: `${current.time}Z`,
    source: 'Open-Meteo · Copernicus CAMS',
    sourceUrl: 'https://open-meteo.com/en/docs/air-quality-api',
    resolution:
      'Atmospheric model: about 11 km in Europe, 45 km elsewhere; not a local monitoring station.',
    licence: 'CC BY 4.0 · CAMS attribution',
    modelPoint: { lat: payload.latitude, lon: payload.longitude },
  };
}

async function frenchHousing(point) {
  const communes = await json(
    `https://geo.api.gouv.fr/communes?lat=${point.lat}&lon=${point.lon}&fields=code,nom,codeDepartement&format=json`,
  );
  const commune = communes?.[0];
  if (!commune || !/^[0-9A-Z]{5}$/.test(commune.code)) return null;
  for (const [code, scale] of [
    [commune.code, 'commune'],
    [commune.codeDepartement, 'departement'],
  ]) {
    if (!code || !/^[0-9A-Z]{2,5}$/.test(code)) continue;
    const params = new URLSearchParams({
      code_geo__exact: code,
      echelle_geo__exact: scale,
      page_size: '200',
    });
    const payload = await json(`${dvf}?${params}`);
    const rows =
      payload.data?.filter(
        (row) =>
          finiteValue(row.med_prix_m2_apt_maison) > 0 &&
          row.nb_ventes_apt_maison >= 5,
      ) || [];
    if (payload.meta?.total > 200)
      throw new Error('DVF series too long: update the adapter.');
    rows.sort((a, b) =>
      String(b.annee_mois).localeCompare(String(a.annee_mois)),
    );
    const row = rows[0];
    if (!row) continue;
    return {
      status: 'available',
      value: row.med_prix_m2_apt_maison,
      unit: 'EUR/m²',
      date: row.annee_mois,
      area: row.libelle_geo,
      resolution:
        scale === 'commune'
          ? 'Municipality · median residential sale price for the month'
          : 'Department · municipal data unavailable; median sale price for the month',
      count: row.nb_ventes_apt_maison,
      source: 'DGFiP DVF · data.gouv.fr',
      sourceUrl: 'https://www.data.gouv.fr/datasets/statistiques-dvf',
      licence: 'Licence Ouverte 2.0',
    };
  }
  return unavailable(
    'No publishable municipal or departmental DVF statistics (at least 5 sales).',
  );
}

async function britishHousing(point) {
  const payload = await json(
    `https://api.postcodes.io/postcodes?lon=${point.lon}&lat=${point.lat}&limit=1&radius=1000`,
  );
  const district = payload.result?.[0];
  if (!district) return null;
  const slug = String(district.admin_district || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  if (!slug || slug.length > 100) return null;
  const result = await json(
    `https://landregistry.data.gov.uk/data/ukhpi/region/${slug}.json?_view=all&_pageSize=1`,
  );
  const row = result.result?.items?.[0];
  if (!(finiteValue(row?.averagePrice) > 0))
    return unavailable('No UK HPI price for this district.');
  return {
    status: 'available',
    value: row.averagePrice,
    unit: 'GBP/home',
    date: row.refMonth,
    area: district.admin_district,
    resolution:
      'Administrative district · UK HPI standardized average price per home',
    source: 'HM Land Registry · UK HPI',
    sourceUrl: 'https://landregistry.data.gov.uk/app/ukhpi/doc',
    licence: 'Open Government Licence',
  };
}

async function americanHousing(point) {
  const params = new URLSearchParams({
    x: point.lon,
    y: point.lat,
    benchmark: 'Public_AR_Current',
    vintage: 'Current_Current',
    format: 'json',
  });
  const result = await json(
    `https://geocoding.geo.census.gov/geocoder/geographies/coordinates?${params}`,
  );
  const geographies = result.result?.geographies;
  for (const [kind, prefix, resolution] of [
    ['Census Tracts', '14000US', 'Census tract'],
    ['Counties', '05000US', 'County · tract data unavailable'],
  ]) {
    const code = geographies?.[kind]?.[0]?.GEOID;
    if (!code || !/^\d{5,11}$/.test(code)) continue;
    const id = prefix + code;
    const data = await json(
      `https://api.censusreporter.org/1.0/data/show/latest?table_ids=B25077&geo_ids=${id}`,
    );
    const value = finiteValue(data.data?.[id]?.B25077?.estimate?.B25077001);
    if (value == null || value <= 0 || value === 2000001) continue;
    return {
      status: 'available',
      value,
      unit: 'USD/home',
      date: data.release?.years,
      area: data.geography?.[id]?.name,
      resolution: `${resolution} · median reported value of owner-occupied homes; not sale prices`,
      marginOfError: data.data?.[id]?.B25077?.error?.B25077001,
      release: data.release?.name,
      source: 'US Census ACS B25077 · Census Reporter',
      sourceUrl: 'https://censusreporter.org/tables/B25077/',
      licence: 'US Census public domain',
    };
  }
  return null;
}

async function housing(point) {
  if (
    point.lat >= 35 &&
    point.lat <= 47.5 &&
    point.lon >= 6.5 &&
    point.lon <= 19
  ) {
    const value = await italianHousing(point);
    if (value) return value;
  }
  // Wide candidate bounds identify adapters, not national borders; geocoding decides coverage.
  const frenchAreas = [
    [41, 51.2, -5.5, 9.7],
    [14, 17, -62, -60],
    [2, 6, -55, -51],
    [-22, -20, 55, 56],
    [-14, -12, 44, 46],
  ];
  if (
    frenchAreas.some(
      ([south, north, west, east]) =>
        point.lat >= south &&
        point.lat <= north &&
        point.lon >= west &&
        point.lon <= east,
    )
  ) {
    const value = await frenchHousing(point);
    if (value) return value;
  }
  if (
    point.lat >= 49.8 &&
    point.lat <= 61 &&
    point.lon >= -8.5 &&
    point.lon <= 2
  ) {
    const value = await britishHousing(point);
    if (value) return value;
  }
  if (
    point.lat >= 17 &&
    point.lat <= 73 &&
    point.lon >= -180 &&
    point.lon <= -60
  ) {
    const value = await americanHousing(point);
    if (value) return value;
  }
  return unavailable(
    'Housing sources cover Italy (OMI), France, UK and USA. No territorial source is connected for this area; no substitute estimate.',
  );
}

async function services(point) {
  try {
    return await overpassServices(point);
  } catch {
    return nominatimServices(point);
  }
}

async function nominatimServices(point) {
  const raw = process.env.AREA_SERVICES_NOMINATIM_URL;
  if (!raw)
    return unavailable(
      'OpenStreetMap source unavailable; configure another Overpass instance or AREA_SERVICES_NOMINATIM_URL.',
    );
  const endpoint = new URL(raw);
  if (
    !['https:', 'http:'].includes(endpoint.protocol) ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.username ||
    endpoint.password
  )
    throw new Error('Invalid Nominatim configuration');
  const dx = Math.min(
      180,
      0.0271 / Math.max(0.02, Math.cos((point.lat * Math.PI) / 180)),
    ),
    dy = 0.0271;
  if (Math.abs(point.lat) > 85 || point.lon - dx < -180 || point.lon + dx > 180)
    return unavailable(
      'Service search unavailable near the poles or the 180° meridian with this source.',
    );
  const viewbox = [
    point.lon - dx,
    Math.min(90, point.lat + dy),
    point.lon + dx,
    Math.max(-90, point.lat - dy),
  ].join(',');
  const elements = [];
  for (const [phrase, tag] of [
    ['hospital', { amenity: 'hospital' }],
    ['school', { amenity: 'school' }],
    ['supermarket', { shop: 'supermarket' }],
    ['bus stop', { highway: 'bus_stop' }],
  ]) {
    const params = new URLSearchParams({
      format: 'jsonv2',
      amenity: phrase,
      viewbox,
      bounded: '1',
      limit: '40',
    });
    const rows = await enqueueNominatim(() => json(`${endpoint}?${params}`), {
      bounded: true,
    });
    if (!Array.isArray(rows)) throw new Error('Invalid Nominatim response');
    for (const row of rows)
      elements.push({
        type: row.osm_type,
        id: row.osm_id,
        lat: row.lat,
        lon: row.lon,
        tags: { ...tag, name: row.name },
      });
  }
  return {
    ...summarizeServices(elements, point),
    status: 'available',
    complete: true,
    sample: true,
    source: 'OpenStreetMap · Nominatim search sample',
    sourceUrl: 'https://www.openstreetmap.org/copyright',
    licence: 'ODbL',
    date: new Date().toISOString(),
    resolution:
      'Sample within 3 km: hospitals, schools, supermarkets, bus stops; straight-line distances',
    warning:
      'Non-exhaustive search, up to 40 results per category. Distance is to the nearest result in the sample, not necessarily the nearest service overall. An unmapped category remains unscored.',
  };
}

async function overpassServices(point) {
  const endpoints = resolveOverpassUpstreams();
  if (!endpoints.length) throw new Error('Overpass not configured');
  const around = `(around:3000,${point.lat},${point.lon})`;
  const query = `[out:json][timeout:20];(nwr[amenity~"^(hospital|clinic|doctors|pharmacy|school|kindergarten|college|university)$"]${around};nwr[shop~"^(supermarket|convenience|greengrocer)$"]${around};nwr[highway=bus_stop]${around};nwr[railway~"^(station|halt|tram_stop)$"]${around};nwr[public_transport=platform]${around};);out center 5000;`;
  const payload = await json(endpoints[0], {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ data: query }).toString(),
  });
  if (!Array.isArray(payload.elements) || payload.remark)
    return unavailable('Incomplete OpenStreetMap response: try again later.');
  const data = summarizeServices(payload.elements, point);
  return {
    ...data,
    status: 'available',
    complete: payload.elements.length < 5000,
    source: 'OpenStreetMap · Overpass',
    sourceUrl: 'https://www.openstreetmap.org/copyright',
    licence: 'ODbL',
    date: payload.osm3s?.timestamp_osm_base,
    resolution:
      'Mapped services within 3 km · straight-line distance, not travel time',
    warning:
      'OSM coverage varies: an unmapped category does not mean the service does not exist.',
  };
}

async function seismic(point) {
  try {
    const value = await readGemHazard(point.lat, point.lon);
    if (!value)
      return unavailable(
        'GEM does not cover this point; this does not imply zero hazard.',
      );
    return {
      ...value,
      status: 'available',
      date: '2023.1',
      source: 'GEM Global Seismic Hazard Map',
      sourceUrl: 'https://doi.org/10.5281/zenodo.8409647',
      licence: 'CC BY-NC-SA 4.0 · noncommercial use',
      resolution:
        '0.05° grid (~6 km); PGA on rock, 10% probability of exceedance in 50 years',
      warning:
        'Ground-shaking hazard, not individual building risk or administrative seismic classification.',
    };
  } catch (error) {
    if (error.code === 'ENOENT')
      return unavailable(
        'GEM map not installed: run scripts/install-gem-hazard.py on the server.',
      );
    throw error;
  }
}

export const areaProviders = { air, housing, services, seismic };
const nearbySearch = createNearbySearch(areaProviders);

/** Bounded cache/coalescing and independent failures for each selected parameter. */
export function areaAssessmentProxy() {
  const cache = new Map(),
    pending = new Map();
  const allow = makeRateLimiter({ windowMs: 60000, max: 40, globalMax: 120 });
  const install = (server) => {
    server.middlewares.use('/api/area-assessment', async (req, res) => {
      const send = (status, body) => {
        res.writeHead(status, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(body));
      };
      if (req.method !== 'GET') return send(405, { error: 'GET required' });
      const url = new URL(req.url, 'http://localhost');
      const lat = url.searchParams.get('lat'),
        lon = url.searchParams.get('lon'),
        metric = url.searchParams.get('metric');
      const point = { lat: finiteValue(lat), lon: finiteValue(lon) };
      if (
        point.lat == null ||
        point.lon == null ||
        Math.abs(point.lat) > 90 ||
        Math.abs(point.lon) > 180 ||
        (metric !== 'nearby' && !Object.hasOwn(areaProviders, metric))
      )
        return send(400, { error: 'Invalid coordinates or parameter' });
      if (!allow(clientKey(req)))
        return send(429, { error: 'Too many requests: wait one minute.' });
      const metrics = [
        ...new Set((url.searchParams.get('metrics') || '').split(',')),
      ];
      const radius = finiteValue(url.searchParams.get('radius'));
      if (
        metric === 'nearby' &&
        (!metrics.length ||
          metrics.length > 4 ||
          metrics.some((id) => !Object.hasOwn(areaProviders, id)) ||
          radius == null ||
          radius < 300 ||
          radius > 3000)
      )
        return send(400, {
          error:
            'Select valid parameters and a radius from 300 to 3000 meters.',
        });
      const key = `${metric}:${point.lat.toFixed(4)}:${point.lon.toFixed(4)}${metric === 'nearby' ? ':' + metrics.sort().join(',') + ':' + radius : ''}`;
      const saved = cache.get(key);
      if (saved && Date.now() < saved.expires) return send(200, saved.body);
      if (!pending.has(key)) {
        if (pending.size >= 8)
          return send(503, { error: 'Sources busy: try again later.' });
        const request = (
          metric === 'nearby'
            ? nearbySearch(point, { metrics, radius })
            : areaProviders[metric](point)
        )
          .catch(() =>
            unavailable('Source temporarily unavailable. Try again later.'),
          )
          .then((observation) => {
            const body = {
              metric,
              point,
              ...observation,
              fetchedAt: new Date().toISOString(),
            };
            if (cache.size >= 250) cache.delete(cache.keys().next().value);
            const ttl =
              observation.status !== 'available'
                ? 30000
                : metric === 'air' || metric === 'nearby'
                  ? 15 * 60000
                  : 6 * 3600000;
            cache.set(key, { expires: Date.now() + ttl, body });
            return body;
          })
          .finally(() => pending.delete(key));
        pending.set(key, request);
      }
      return send(200, await pending.get(key));
    });
  };
  return {
    name: 'area-assessment-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}
