#!/usr/bin/env node
/**
 * Import police / public-safety scanner feeds into config/scanner-feeds.json
 * from Radio Browser (worldwide live streams) and OpenMHz (US recorded calls).
 *
 *   --source radiobrowser|openmhz|both   (default both)
 *   --public-safety                      also import fire / EMS scanners
 *   --from-file systems.json             read the OpenMHz list from a saved file
 *   --include-inactive                   also import systems that are offline now
 *   --no-geocode                         skip lookups; use state/country centres
 *   --match "."                          keep every OpenMHz system, not just police
 *
 *   node scripts/import-openmhz-systems.mjs --inspect          # show raw fields
 *   node scripts/import-openmhz-systems.mjs --limit 100        # import up to 100
 *   node scripts/import-openmhz-systems.mjs --match "sheriff|police" --no-geocode
 *
 * OpenMHz's /systems endpoint is not a documented public contract, so field
 * names are read defensively. Systems with no usable coordinates (after the
 * optional Nominatim city lookup) are skipped. Existing feeds are kept.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const OPENMHZ_API = 'https://api.openmhz.com';
export const DEFAULT_MATCH =
  /police|\bpd\b|sheriff|dispatch|public safety|law enforcement|patrol|\bso\b/i;
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'GodsEyeView-scanner-import/1.0';

const num = (value) =>
  value === null || value === '' || value === undefined ? NaN : Number(value);

/** Pull `{lat, lon}` out of whichever shape the system record uses. */
export function systemCoordinates(system) {
  const pairs = [
    [system?.lat, system?.lon ?? system?.lng],
    [system?.latitude, system?.longitude],
    [system?.location?.lat, system?.location?.lon ?? system?.location?.lng],
    [system?.location?.latitude, system?.location?.longitude],
  ];
  const coords = system?.location?.coordinates ?? system?.coordinates;
  if (Array.isArray(coords) && coords.length >= 2)
    pairs.push([coords[1], coords[0]]); // GeoJSON is [lon, lat]
  for (const [rawLat, rawLon] of pairs) {
    const lat = num(rawLat);
    const lon = num(rawLon);
    if (
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      Math.abs(lat) <= 90 &&
      Math.abs(lon) <= 180 &&
      !(lat === 0 && lon === 0)
    )
      return { lat, lon };
  }
  return null;
}

export function isPublicSafetySystem(system, match = DEFAULT_MATCH) {
  const text = [system?.name, system?.shortName, system?.description]
    .filter(Boolean)
    .join(' ');
  return match.test(text);
}

// Approximate centres, used as a last-resort location for state-wide or
// unlocatable systems. [name, lat, lon]
export const US_STATES = {
  AL: ['Alabama', 32.8, -86.8], AK: ['Alaska', 63.6, -152.0], AZ: ['Arizona', 34.3, -111.7],
  AR: ['Arkansas', 34.9, -92.4], CA: ['California', 37.2, -119.7], CO: ['Colorado', 39.0, -105.5],
  CT: ['Connecticut', 41.6, -72.7], DE: ['Delaware', 39.0, -75.5], DC: ['District of Columbia', 38.9, -77.0],
  FL: ['Florida', 28.6, -82.4], GA: ['Georgia', 32.7, -83.4], HI: ['Hawaii', 20.8, -156.3],
  ID: ['Idaho', 44.4, -114.6], IL: ['Illinois', 40.0, -89.2], IN: ['Indiana', 39.9, -86.3],
  IA: ['Iowa', 42.1, -93.5], KS: ['Kansas', 38.5, -98.4], KY: ['Kentucky', 37.5, -85.3],
  LA: ['Louisiana', 31.1, -92.0], ME: ['Maine', 45.3, -69.2], MD: ['Maryland', 39.0, -76.8],
  MA: ['Massachusetts', 42.3, -71.8], MI: ['Michigan', 44.3, -85.4], MN: ['Minnesota', 46.3, -94.3],
  MS: ['Mississippi', 32.7, -89.7], MO: ['Missouri', 38.4, -92.5], MT: ['Montana', 47.0, -109.6],
  NE: ['Nebraska', 41.5, -99.8], NV: ['Nevada', 39.3, -116.6], NH: ['New Hampshire', 43.7, -71.6],
  NJ: ['New Jersey', 40.1, -74.7], NM: ['New Mexico', 34.4, -106.1], NY: ['New York', 42.9, -75.5],
  NC: ['North Carolina', 35.6, -79.4], ND: ['North Dakota', 47.5, -100.5], OH: ['Ohio', 40.3, -82.8],
  OK: ['Oklahoma', 35.6, -97.5], OR: ['Oregon', 43.9, -120.6], PA: ['Pennsylvania', 40.9, -77.8],
  RI: ['Rhode Island', 41.7, -71.5], SC: ['South Carolina', 33.9, -80.9], SD: ['South Dakota', 44.4, -100.2],
  TN: ['Tennessee', 35.9, -86.4], TX: ['Texas', 31.5, -99.3], UT: ['Utah', 39.3, -111.7],
  VT: ['Vermont', 44.1, -72.7], VA: ['Virginia', 37.5, -78.8], WA: ['Washington', 47.4, -120.5],
  WV: ['West Virginia', 38.6, -80.6], WI: ['Wisconsin', 44.6, -89.9], WY: ['Wyoming', 43.0, -107.5],
};
export const COUNTRY_CENTERS = {
  canada: [56.1, -106.3],
  australia: [-25.7, 134.5],
};
const COUNTYISH = /\b(county|counties|co\.?)\b/i;

function cleanCounty(value) {
  const first = String(value ?? '').split(/\s+and\s+|,|\//i)[0];
  return first.replace(/\b(county|counties|co\.?)\s*$/i, '').trim();
}

/** Ordered geocoding queries, most specific first. */
export function placeQueries(system) {
  const rawCity = String(system?.city ?? '').trim();
  const stateCode = String(system?.state ?? '').trim().toUpperCase();
  const stateName = US_STATES[stateCode]?.[0] ?? String(system?.state ?? '').trim();
  const country =
    String(system?.country ?? '').trim() || (US_STATES[stateCode] ? 'USA' : '');
  const countyRaw = COUNTYISH.test(rawCity) ? rawCity : system?.county;
  const city = COUNTYISH.test(rawCity) ? '' : rawCity;
  const county = cleanCounty(countyRaw);
  const queries = [];
  if (city) queries.push([city, stateName, country]);
  if (county) queries.push([`${county} County`, stateName, country]);
  if (stateName) queries.push([stateName, country]);
  else if (country) queries.push([country]);
  return queries.map((parts) => parts.filter(Boolean).join(', '));
}

export function placeQuery(system) {
  return placeQueries(system)[0] ?? '';
}

function hash01(text) {
  let h = 2166136261;
  for (const ch of String(text)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

/** State / country centre with a stable offset so markers don't stack. */
export function fallbackCoordinates(system) {
  const code = String(system?.state ?? '').trim().toUpperCase();
  const center = US_STATES[code]
    ? [US_STATES[code][1], US_STATES[code][2]]
    : COUNTRY_CENTERS[String(system?.country ?? '').trim().toLowerCase()];
  if (!center) return null;
  const seed = system.shortName ?? system.name ?? '';
  return {
    lat: center[0] + (hash01(`${seed}a`) - 0.5) * 1.2,
    lon: center[1] + (hash01(`${seed}b`) - 0.5) * 1.6,
  };
}

export function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function buildFeed(system, coords) {
  const shortName = String(system.shortName ?? '');
  return {
    id: `openmhz-${slugify(shortName)}`,
    name: String(system.name || shortName).slice(0, 100),
    agency: [system.city || system.county, system.state || system.country]
      .filter(Boolean)
      .join(', '),
    lat: coords.lat,
    lon: coords.lon,
    type: 'openmhz',
    system: shortName,
    attribution: 'OpenMHz',
  };
}

async function geocode(query, fetchImpl) {
  const url = `${NOMINATIM}?format=json&limit=1&q=${encodeURIComponent(query)}`;
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!response.ok) return null;
  const [hit] = await response.json();
  return hit ? { lat: Number(hit.lat), lon: Number(hit.lon) } : null;
}

/**
 * Turn a /systems payload into feeds. Pure apart from the injected geocoder
 * and sleep, so it can be tested without a network.
 */
export async function buildFeedsFromSystems(
  payload,
  {
    match = DEFAULT_MATCH,
    limit = 100,
    useGeocoder = true,
    includeInactive = false,
    existingIds = new Set(),
    fetchImpl = (...args) => globalThis.fetch(...args),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log = () => {},
  } = {},
) {
  const systems = Array.isArray(payload) ? payload : payload?.systems ?? [];
  const feeds = [];
  const cache = new Map();
  const ids = new Set(existingIds);
  for (const system of systems) {
    if (feeds.length >= limit) break;
    if (!system?.shortName || !isPublicSafetySystem(system, match)) continue;
    if (system.active === false && !includeInactive) continue;
    const id = buildFeed(system, { lat: 0, lon: 0 }).id;
    if (ids.has(id)) continue;
    let coords = systemCoordinates(system);
    let precise = Boolean(coords);
    if (!coords && useGeocoder) {
      for (const query of placeQueries(system)) {
        if (!cache.has(query)) {
          await sleep(1100); // Nominatim usage policy: at most 1 request/second
          cache.set(query, await geocode(query, fetchImpl).catch(() => null));
        }
        coords = cache.get(query);
        if (coords) {
          precise = true;
          break;
        }
      }
    }
    if (!coords) coords = fallbackCoordinates(system);
    if (!coords) {
      log(`skip ${system.shortName}: no location`);
      continue;
    }
    ids.add(id);
    feeds.push(buildFeed(system, coords));
    log(`add  ${system.shortName}${precise ? '' : ' (approximate location)'}`);
  }
  return feeds;
}

// ---------------------------------------------------------------------------
// Radio Browser (https://api.radio-browser.info): free, worldwide, no key.
// Each station has a checked stream URL and, for many, map coordinates.
// ---------------------------------------------------------------------------
export const RADIO_BROWSER_HOSTS = ['de1', 'de2', 'nl1', 'at1'];
const SCANNER_TEXT =
  /police|polic[ií]a|polícia|polizei|politie|polisi|\bpolis\b|gendarm|carabinieri|carabineros|警察|полиц|милиц|scanner|dispatch|sheriff|public.?safety|law enforcement|emergency|\bems\b/i;
const SAFETY_TEXT =
  /fire|rescue|ambulan|bomberos|feuerwehr|pompier|vigili|paramedic|911|112/i;
const POLICE_TERMS = [
  'police', 'polizei', 'policia', 'policía', 'polícia', 'politie', 'polisi',
  'gendarmerie', 'carabinieri', 'carabineros', 'sheriff', '警察', 'полиция',
  'scanner', 'dispatch', 'public safety', 'emergency',
];
const SAFETY_TERMS = ['fire', 'rescue', 'ems', 'ambulance', 'bomberos', 'feuerwehr', 'pompiers'];
const MUSIC_TAGS =
  /(^|,)\s*(rock|pop|jazz|oldies|hits|music|dance|electronic|hip hop|classic)\s*(,|$)/i;

export function isScannerStation(station, { publicSafety = false } = {}) {
  const text = `${station?.name ?? ''} ${station?.tags ?? ''}`;
  if (!SCANNER_TEXT.test(text) && !(publicSafety && SAFETY_TEXT.test(text)))
    return false;
  // "The Police" the band, "Emergency" the song: music tags without scanner words.
  if (MUSIC_TAGS.test(String(station?.tags ?? '')) && !/scanner|dispatch/i.test(text))
    return false;
  return true;
}

export function stationToFeed(station, coords) {
  const uuid = String(station.stationuuid ?? '').replace(/[^a-z0-9]/gi, '');
  return {
    id: `rb-${slugify(station.name).slice(0, 40)}-${uuid.slice(0, 6).toLowerCase()}`,
    name: String(station.name).trim().slice(0, 100),
    agency: [station.state, station.country].filter(Boolean).join(', '),
    lat: coords.lat,
    lon: coords.lon,
    type: 'stream',
    url: station.url_resolved || station.url,
    attribution: 'Radio Browser',
  };
}

export async function buildFeedsFromStations(
  stations,
  {
    limit = 150,
    useGeocoder = true,
    publicSafety = false,
    existingIds = new Set(),
    geocodeFn = (query) => geocode(query, (...args) => globalThis.fetch(...args)),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log = () => {},
  } = {},
) {
  const feeds = [];
  const seenUuids = new Set();
  const cache = new Map();
  for (const station of stations) {
    if (feeds.length >= limit) break;
    const uuid = station?.stationuuid;
    if (!uuid || seenUuids.has(uuid)) continue;
    seenUuids.add(uuid);
    if (!/^https?:\/\//i.test(station.url_resolved || station.url || '')) continue;
    if (!station.name || !isScannerStation(station, { publicSafety })) continue;
    let coords = systemCoordinates({ lat: station.geo_lat, lon: station.geo_long });
    if (!coords && useGeocoder) {
      const query = [station.state, station.country].filter(Boolean).join(', ');
      if (query) {
        if (!cache.has(query)) {
          await sleep(1100);
          cache.set(query, await geocodeFn(query).catch(() => null));
        }
        coords = cache.get(query);
      }
    }
    if (!coords) {
      log(`skip ${station.name}: no coordinates`);
      continue;
    }
    const feed = stationToFeed(station, coords);
    if (existingIds.has(feed.id)) continue;
    feeds.push(feed);
    log(`add  ${feed.name} [${feed.agency}]`);
  }
  return feeds;
}

async function fetchRadioBrowser(path) {
  let lastError = null;
  for (const host of RADIO_BROWSER_HOSTS) {
    try {
      const response = await fetch(`https://${host}.api.radio-browser.info${path}`, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
      if (response.ok) return await response.json();
      lastError = new Error(`Radio Browser ${host} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('Radio Browser unreachable');
}

async function collectRadioBrowserStations(useGeocoder, publicSafety = false) {
  const terms = publicSafety ? [...POLICE_TERMS, ...SAFETY_TERMS] : POLICE_TERMS;
  const queries = terms.flatMap((term) => [
    `tag=${encodeURIComponent(term)}`,
    `name=${encodeURIComponent(term)}`,
  ]);
  const stations = [];
  for (const geoOnly of useGeocoder ? [true, false] : [true]) {
    for (const query of queries) {
      const path =
        `/json/stations/search?${query}&hidebroken=true&limit=500` +
        `&order=clickcount&reverse=true${geoOnly ? '&has_geo_info=true' : ''}`;
      try {
        stations.push(...(await fetchRadioBrowser(path)));
      } catch (error) {
        console.warn(`Radio Browser query failed (${query}): ${error.message}`);
      }
    }
  }
  return stations;
}

function parseArgs(argv) {
  const args = {
    out: 'config/scanner-feeds.json',
    limit: 150,
    useGeocoder: true,
    source: 'both',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--inspect') args.inspect = true;
    else if (arg === '--no-geocode') args.useGeocoder = false;
    else if (arg === '--public-safety') args.publicSafety = true;
    else if (arg === '--include-inactive') args.includeInactive = true;
    else if (arg === '--limit') args.limit = Number(argv[++i]);
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--source') args.source = argv[++i];
    else if (arg === '--from-file') args.fromFile = argv[++i];
    else if (arg === '--match') args.match = new RegExp(argv[++i], 'i');
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const wanted =
    args.source === 'openmhz'
      ? ['openmhz']
      : args.source === 'radiobrowser'
        ? ['radiobrowser']
        : ['radiobrowser', 'openmhz'];
  const outPath = new URL(args.out, pathToFileURL(`${process.cwd()}/`));
  const existing = existsSync(outPath)
    ? JSON.parse(readFileSync(outPath, 'utf8'))
    : { feeds: [] };
  const kept = Array.isArray(existing.feeds) ? existing.feeds : [];
  const existingIds = new Set(kept.map((feed) => feed.id));
  const added = [];
  const log = (line) => console.log(line);

  if (wanted.includes('radiobrowser')) {
    const stations = await collectRadioBrowserStations(
      args.useGeocoder,
      args.publicSafety,
    );
    console.log(`Radio Browser returned ${stations.length} candidate stations.`);
    if (args.inspect) {
      console.log(JSON.stringify(stations.slice(0, 2), null, 2));
    } else {
      const feeds = await buildFeedsFromStations(stations, {
        limit: args.limit,
        useGeocoder: args.useGeocoder,
        publicSafety: args.publicSafety,
        existingIds,
        log,
      });
      feeds.forEach((feed) => existingIds.add(feed.id));
      added.push(...feeds);
    }
  }

  if (wanted.includes('openmhz')) {
    let payload = null;
    if (args.fromFile) {
      payload = JSON.parse(readFileSync(args.fromFile, 'utf8'));
    } else {
      const response = await fetch(`${OPENMHZ_API}/systems`, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
      if (response.ok) payload = await response.json();
      else
        console.warn(
          `OpenMHz /systems returned ${response.status}. Open ${OPENMHZ_API}/systems in your browser, save it as systems.json, and re-run with --from-file systems.json`,
        );
    }
    if (payload) {
      const systems = Array.isArray(payload) ? payload : payload?.systems ?? [];
      console.log(`OpenMHz returned ${systems.length} systems.`);
      if (args.inspect) {
        console.log('Fields on the first system:', Object.keys(systems[0] ?? {}));
        console.log(JSON.stringify(systems.slice(0, 2), null, 2));
      } else {
        const feeds = await buildFeedsFromSystems(payload, {
          match: args.match,
          limit: args.limit,
          useGeocoder: args.useGeocoder,
          includeInactive: args.includeInactive,
          existingIds,
          log,
        });
        added.push(...feeds);
      }
    }
  }

  if (args.inspect) return;
  writeFileSync(
    outPath,
    `${JSON.stringify({ ...existing, feeds: [...kept, ...added] }, null, 2)}\n`,
  );
  console.log(`Added ${added.length} feeds (${kept.length} kept) -> ${args.out}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
