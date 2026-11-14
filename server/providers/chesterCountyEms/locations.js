import { readResponseJsonCapped } from '../common/http.js';

const ROOT =
  'https://services.arcgis.com/G4S1dGvn7PIgYd6Y/arcgis/rest/services/';
const ROAD_FIELDS =
  'ROAD_NAME_FULL,MUNI_NAME_ABRV_LEFT,MUNI_NAME_ABRV_RIGHT,FR_ZLEV,TO_ZLEV';
const quote = (value) => `'${value.replace(/'/g, "''")}'`;
const suffixes = {
  AVENUE: 'AV',
  LA: 'LN',
  HW: 'HWY',
  WY: 'WAY',
  WAY: 'WAY',
  AVE: 'AV',
  STREET: 'ST',
  ROAD: 'RD',
  DRIVE: 'DR',
  LANE: 'LN',
  COURT: 'CT',
  CIRCLE: 'CIR',
  BOULEVARD: 'BLVD',
  HIGHWAY: 'HWY',
  TERRACE: 'TER',
  PLACE: 'PL',
  PARKWAY: 'PKWY',
};
const directions = {
  NORTH: 'N',
  SOUTH: 'S',
  EAST: 'E',
  WEST: 'W',
  NORTHEAST: 'NE',
  NORTHWEST: 'NW',
  SOUTHEAST: 'SE',
  SOUTHWEST: 'SW',
};

/** Normalize county/CAD street abbreviations without fuzzy name guessing. */
export function normalizeRoad(value) {
  return String(value)
    .toUpperCase()
    .replace(/[.,]/g, '')
    .trim()
    .split(/\s+/)
    .map((word) => suffixes[word] || directions[word] || word)
    .join(' ');
}
function roadParts(value) {
  const words = normalizeRoad(value).split(' ');
  const direction = /^(N|S|E|W|NE|NW|SE|SW)$/.test(words[0])
    ? words.shift()
    : null;
  if (Object.values(suffixes).includes(words.at(-1))) words.pop();
  return { name: words.join(' '), direction };
}
function roadMatches(actual, wanted) {
  const a = normalizeRoad(actual),
    w = normalizeRoad(wanted);
  return (
    a === w ||
    (!roadParts(w).direction && a.replace(/^(N|S|E|W|NE|NW|SE|SW) /, '') === w)
  );
}
const inCounty = ([lon, lat]) =>
  Number.isFinite(lon) &&
  Number.isFinite(lat) &&
  lon >= -76.2 &&
  lon <= -75.3 &&
  lat >= 39.7 &&
  lat <= 40.3;
const meters = (a, b) =>
  Math.hypot((a[0] - b[0]) * 85000, (a[1] - b[1]) * 111000);
function uniquePosition(points, kind) {
  if (!points.length || points.some((p) => !inCounty(p))) return null;
  // A divided junction can have several nearby nodes. Distinct junctions are ambiguous.
  if (
    points.some(
      (p) => meters(p, points[0]) > (kind === 'intersection' ? 60 : 20),
    )
  )
    return null;
  return {
    lon: points.reduce((s, p) => s + p[0], 0) / points.length,
    lat: points.reduce((s, p) => s + p[1], 0) / points.length,
    kind,
    approximate: true,
  };
}

/** Use connected road endpoints and matching level codes, never an overpass crossing. */
export function matchIntersection(features, first, second) {
  const endpoints = (wanted) =>
    features
      .filter((f) => roadMatches(f.attributes?.ROAD_NAME_FULL || '', wanted))
      .flatMap((f) =>
        (f.geometry?.paths || []).flatMap((path) => {
          if (path.length < 2) return [];
          return [
            { point: path[0], level: f.attributes.FR_ZLEV },
            { point: path.at(-1), level: f.attributes.TO_ZLEV },
          ];
        }),
      );
  const points = [];
  for (const a of endpoints(first))
    for (const b of endpoints(second)) {
      if (
        Number.isFinite(a.level) &&
        a.level === b.level &&
        inCounty(a.point) &&
        inCounty(b.point) &&
        meters(a.point, b.point) <= 3
      )
        points.push([
          (a.point[0] + b.point[0]) / 2,
          (a.point[1] + b.point[1]) / 2,
        ]);
    }
  return uniquePosition(points, 'intersection');
}

/** One documented junction alias, never a county-wide road-name substitution.
 * Township: https://www.tredyffrin.org/files/assets/township/v/1/document-central/meeting-agendas/board-of-supervisors-agendas/2025-bos-agendas/11052025-bos-public-meeting-agenda.pdf
 * NPS: https://www.nps.gov/places/knox-covered-bridge.htm
 */
function correctedJunction(parts, municipality) {
  if (municipality.toUpperCase() !== 'TREDYFFRIN TOWNSHIP') return null;
  const normalized = parts.map(normalizeRoad);
  if (
    !normalized.includes('VALLEY FORGE RD') ||
    !normalized.includes('YELLOW SPRINGS RD')
  )
    return null;
  return normalized.map((name) =>
    name === 'VALLEY FORGE RD' ? 'VALLEY CREEK RD' : name,
  );
}

/** Resolve public CAD locations using bounded, cached queries to county GIS only. */
export function createCountyLocationResolver({
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  const cache = new Map();
  async function query(service, where, outFields, signal, layer = 0) {
    const url =
      ROOT +
      service +
      `/FeatureServer/${layer}/query?` +
      new URLSearchParams({
        where,
        outFields,
        outSR: '4326',
        returnGeometry: 'true',
        resultRecordCount: '2000',
        f: 'json',
      });
    const response = await fetchImpl(url, { signal, redirect: 'error' });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('County GIS unavailable');
    }
    const data = await readResponseJsonCapped(response, 2000000, signal);
    if (
      !Array.isArray(data.features) ||
      data.exceededTransferLimit ||
      data.features.length > 2000
    )
      throw new Error('Incomplete county GIS result');
    return data.features;
  }
  async function resolveDetailed(row, { signal } = {}) {
    const key = `${row.municipality}|${row.location}`;
    const previous = cache.get(key);
    if (previous && now() < previous.expires) return previous.result;
    const combined = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(8000)])
      : AbortSignal.timeout(8000);
    let value = null;
    let unavailable = false;
    try {
      const parts = row.location
        .split(/\s*[&/]\s*/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (
        parts.length === 2 &&
        normalizeRoad(parts[0]) !== normalizeRoad(parts[1])
      ) {
        const muni = row.municipality
          .replace(/ Township$/i, ' Twp')
          .replace(/ Borough$/i, ' Boro')
          .toUpperCase();
        const names = [...new Set(parts.map((p) => roadParts(p).name))];
        const where = `UPPER(ROAD_NAME) IN (${names.map(quote).join(',')}) AND (UPPER(MUNI_NAME_ABRV_LEFT)=${quote(muni)} OR UPPER(MUNI_NAME_ABRV_RIGHT)=${quote(muni)})`;
        value = matchIntersection(
          await query('Road_Centerlines', where, ROAD_FIELDS, combined),
          ...parts,
        );
        const correction = !value && correctedJunction(parts, row.municipality);
        if (correction) {
          const correctedNames = correction.map((p) => roadParts(p).name);
          const correctedWhere = `UPPER(ROAD_NAME) IN (${correctedNames.map(quote).join(',')}) AND (UPPER(MUNI_NAME_ABRV_LEFT)=${quote(muni)} OR UPPER(MUNI_NAME_ABRV_RIGHT)=${quote(muni)})`;
          value = matchIntersection(
            await query(
              'Road_Centerlines',
              correctedWhere,
              ROAD_FIELDS,
              combined,
            ),
            ...correction,
          );
          if (value)
            value = {
              ...value,
              matchedLocation: correction.join(' & '),
              method: 'documented-junction-alias',
            };
        }
      } else if (parts.length === 1) {
        const address = parts[0].match(
          /^(\d+[A-Z]?)\s+(.+?)(?:\s+(?:APT|UNIT|SUITE|#)\s*\S+)?$/i,
        );
        if (address) {
          const where = `UPPER(ADDR_NUM)=${quote(address[1].toUpperCase())} AND UPPER(ROAD_NAME)=${quote(roadParts(address[2]).name)} AND UPPER(MUNI_NAME_FULL)=${quote(row.municipality.toUpperCase())}`;
          const features = await query(
            'Site_Address_Points',
            where,
            'ADDR_NUM,ROAD_NAME_FULL,MUNI_NAME_FULL',
            combined,
          );
          value = uniquePosition(
            features
              .filter(
                (f) =>
                  roadMatches(f.attributes.ROAD_NAME_FULL, address[2]) &&
                  String(f.attributes.ADDR_NUM).toUpperCase() ===
                    address[1].toUpperCase() &&
                  String(f.attributes.MUNI_NAME_FULL).toUpperCase() ===
                    row.municipality.toUpperCase(),
              )
              .map((f) => [f.geometry?.x, f.geometry?.y]),
            'address',
          );
        } else if (/^[a-z0-9 '\-]{2,120}$/i.test(parts[0])) {
          const name = parts[0].toUpperCase().replace(/\s+/g, ' ');
          const candidates = [
            name,
            ...['CONDOS', 'CONDOMINIUMS', 'APARTMENTS'].map(
              (suffix) => `${name} ${suffix}`,
            ),
          ];
          const where = `UPPER(Common_Place_Name) IN (${candidates.map(quote).join(',')}) AND UPPER(Municipality_Name)=${quote(row.municipality.toUpperCase())} AND Primary_YN='Y' AND Sensitive_YN='N'`;
          const places = await query(
            'Common_Place',
            where,
            'Common_Place_Name,Municipality_Name,Primary_YN,Sensitive_YN',
            combined,
            1,
          );
          const matches = places.filter(
            (f) =>
              candidates.includes(
                String(f.attributes?.Common_Place_Name).toUpperCase(),
              ) &&
              String(f.attributes.Municipality_Name).toUpperCase() ===
                row.municipality.toUpperCase() &&
              f.attributes.Primary_YN === 'Y' &&
              f.attributes.Sensitive_YN === 'N',
          );
          // A named campus/complex is a place, never an inferred house or intersection.
          if (
            new Set(
              matches.map((f) => f.attributes.Common_Place_Name.toUpperCase()),
            ).size === 1
          ) {
            value = uniquePosition(
              matches.map((f) => [f.geometry?.x, f.geometry?.y]),
              'place',
            );
            if (value)
              value = {
                ...value,
                matchedLocation: matches[0].attributes.Common_Place_Name,
                method: 'county-common-place',
              };
          }
        }
      }
    } catch {
      unavailable = true;
    }
    if (cache.size >= 512) cache.delete(cache.keys().next().value);
    const result = {
      position: value,
      status: value ? 'matched' : unavailable ? 'unavailable' : 'unmatched',
    };
    cache.set(key, {
      result,
      expires: now() + (value ? 86400000 : unavailable ? 60000 : 300000),
    });
    return result;
  }
  const resolve = async (row, options) =>
    (await resolveDetailed(row, options)).position;
  resolve.resolveDetailed = resolveDetailed;
  return resolve;
}
