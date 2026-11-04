import { createHash } from 'node:crypto';
import { easternTime } from '../chesterCountyEms/parser.js';
import {
  createCachedCountyFeed,
  readPublicText,
  publicText,
} from './publicFeed.js';

export const LANCASTER_PAGE = 'https://www.lcwc911.us/live-incident-list';
export const LANCASTER_MAP =
  'https://utility.arcgis.com/usrsvcs/servers/a1f6aa7faab44b1582029509c46dce86/rest/services/Maps/Public_LiveFeeds/MapServer';
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
function localTime(value) {
  const m = publicText(value).match(
    /^\w{3}, (\w{3}) (\d{1,2}), (\d{4}) (\d{2}:\d{2})$/,
  );
  if (!m || !MONTHS.includes(m[1])) throw new Error('Invalid Lancaster clock');
  return easternTime(
    MONTHS.indexOf(m[1]) + 1 + '/' + m[2] + '/' + m[3] + ' ' + m[4] + ':00',
  );
}
const normalize = (value) => publicText(value).toUpperCase();
const locationKey = (value) =>
  normalize(value)
    .replaceAll('&', '/')
    .split('/')
    .map((part) => part.trim())
    .sort()
    .join(' & ');
const matchKey = (row) =>
  [
    normalize(row.type),
    locationKey(row.location),
    normalize(row.municipality),
    Math.floor(row.dispatchedAt / 60000),
  ].join('|');

/** The official HTML gives categories and units even when a report has no map point. */
export function parseLancasterList(html) {
  const clock = html.match(/Last refreshed time:\s*([^<]+)/i);
  if (!clock || !/Live Incident List/i.test(html))
    throw new Error('Invalid Lancaster list');
  const rows = [],
    seen = new Set();
  const tables = [
    ...html.matchAll(
      /<h2>\s*Active (Fire|Medical|Traffic) Incidents\s*<\/h2>\s*<table\b[^>]*>([\s\S]*?)<\/table>/gi,
    ),
  ];
  if (
    (html.match(/<table\b[^>]*class=["']live-incidents["']/gi) || []).length !==
    tables.length
  )
    throw new Error('Unknown Lancaster section');
  for (const table of tables) {
    const category = { fire: 'fire', medical: 'ems', traffic: 'traffic' }[
      table[1].toLowerCase()
    ];
    const records = [...table[2].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
    const cells = (row) =>
      [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => m[1]);
    if (
      JSON.stringify(cells(records.shift()?.[1] || '').map(publicText)) !==
      JSON.stringify([
        'Date/Time',
        'Incident Type',
        'Location',
        'Units Assigned',
      ])
    )
      throw new Error('Unknown Lancaster table');
    for (const record of records) {
      const values = cells(record[1]);
      if (values.length === 1 && /^No active\b/i.test(publicText(values[0])))
        continue;
      if (values.length !== 4) throw new Error('Invalid Lancaster row');
      const places = values[2]
        .split(/<br\s*\/?>/i)
        .map(publicText)
        .filter(Boolean);
      if (places.length > 2) throw new Error('Unknown Lancaster location');
      const municipality = places.at(-1) || '',
        location = places.length > 1 ? places[0] : '';
      const dispatched = publicText(values[0]),
        type = publicText(values[1]);
      if (
        !type ||
        !municipality ||
        [type, location, municipality, dispatched].some((s) => s.length > 500)
      )
        throw new Error('Invalid Lancaster summary');
      const row = {
        category,
        type,
        municipality,
        location,
        dispatched,
        dispatchedAt: localTime(dispatched),
        timePrecision: 'minute',
      };
      const key = matchKey(row);
      if (seen.has(key)) throw new Error('Duplicate Lancaster summary');
      seen.add(key);
      const digest = createHash('sha256')
        .update(key)
        .digest('hex')
        .slice(0, 24);
      const assignedUnits = values[3]
        .split(/<br\s*\/?>/i)
        .map(publicText)
        .filter(Boolean);
      if (
        assignedUnits.length > 128 ||
        assignedUnits.some((s) => s.length > 200)
      )
        throw new Error('Too many Lancaster units');
      rows.push({
        ...row,
        id: 'lancaster-pa:' + category + ':' + digest,
        incidentNumber: null,
        station: '',
        assignedUnits,
        detailUrl: LANCASTER_PAGE,
        countyId: 'lancaster-pa',
        county: 'Lancaster County, PA',
        mapPosition: null,
        locationStatus: 'unmatched',
      });
    }
  }
  if (rows.length > 500) throw new Error('Too many Lancaster reports');
  return { rows, observedAt: localTime(clock[1]) };
}
/** Match public map records without guessing coordinates for unmatched list reports. */
export function locateLancasterRows(rows, layers) {
  const mapped = new Map(),
    successful = new Set();
  layers.forEach((result, index) => {
    const category = ['fire', 'ems', 'traffic'][index];
    if (
      result.status !== 'fulfilled' ||
      !Array.isArray(result.value?.features) ||
      result.value.error ||
      result.value.exceededTransferLimit ||
      result.value.features.length > 500
    )
      return;
    successful.add(category);
    for (const feature of result.value.features) {
      const a = feature.attributes;
      if (a?.IsPublic !== 1 || !Number.isFinite(a.IncidentOrigination))
        continue;
      const key =
        category +
        '|' +
        matchKey({
          type: a.PublicType,
          location: a.PublicLocation,
          municipality: a.IncidentMunicipality,
          dispatchedAt: a.IncidentOrigination,
        });
      if (mapped.has(key)) {
        mapped.set(key, null);
        continue;
      }
      mapped.set(key, feature);
    }
  });
  return rows.map((row) => {
    const feature = mapped.get(row.category + '|' + matchKey(row)),
      a = feature?.attributes,
      p = feature?.geometry;
    const valid =
      p &&
      Number.isFinite(p.x) &&
      Number.isFinite(p.y) &&
      p.x >= -76.75 &&
      p.x <= -75.85 &&
      p.y >= 39.65 &&
      p.y <= 40.4;
    const number = String(a?.IncidentNumber || '');
    return {
      ...row,
      incidentNumber:
        valid && /^[A-Za-z0-9-]{1,24}$/.test(number) ? number : null,
      station: valid ? publicText(a.PrimaryAgency || '') : '',
      mapPosition: valid
        ? { lon: p.x, lat: p.y, kind: 'county-published', approximate: true }
        : null,
      locationStatus: valid
        ? 'matched'
        : successful.has(row.category)
          ? 'unmatched'
          : 'unavailable',
    };
  });
}
/** Query only the public layers embedded by LCWC's official incident map. */
export function createLancasterCountyFeed({
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  return createCachedCountyFeed({
    now,
    unavailable: 'Lancaster County incidents unavailable',
    load: async () => {
      const [html, ...layers] = await Promise.allSettled([
        readPublicText(fetchImpl, LANCASTER_PAGE),
        ...[0, 1, 2].map((id) =>
          readPublicText(
            fetchImpl,
            LANCASTER_MAP +
              '/' +
              id +
              '/query?where=IsPublic%3D1&outFields=IncidentNumber,IncidentMunicipality,IncidentOrigination,PrimaryAgency,CurrentUnits,PublicLocation,PublicType,IsPublic&returnGeometry=true&outSR=4326&f=json',
          ).then(JSON.parse),
        ),
      ]);
      if (html.status !== 'fulfilled') throw html.reason;
      const snapshot = parseLancasterList(html.value);
      const rows = locateLancasterRows(snapshot.rows, layers);
      return {
        ...snapshot,
        rows,
        locationCoverage: {
          matched: rows.filter((r) => r.mapPosition).length,
          unmatched: rows.filter((r) => r.locationStatus === 'unmatched')
            .length,
          unavailable: rows.filter((r) => r.locationStatus === 'unavailable')
            .length,
        },
      };
    },
  });
}
