import { classifyRiverLevel } from '../../../src/layers/riverLevels/model.js';

/**
 * Rijkswaterstaat (Netherlands) water levels from the keyless DD-API 2.0
 * WaterWebservices, the service behind Waterinfo:
 * - `OphalenCatalogus`: every location with the series it publishes;
 * - `OphalenLaatsteWaarnemingen`: the newest reading of each location;
 * - `OphalenWaarnemingen`: one location's readings over a period.
 *
 * Levels are centimetres above NAP (Normaal Amsterdams Peil), the national
 * datum, measured and not quality controlled. Locations that also publish an
 * astronomical tide are left out: they are sea and estuary gauges, not river
 * gauges. Rijkswaterstaat publishes no reference or alert levels in this
 * service, so every Dutch gauge stays grey and shows its level and trend.
 *
 * Terms: rijkswaterstaatdata.nl allows reuse when the site is named as the
 * source and the date the information was taken is given; each reading
 * carries its own time.
 */
const DDAPI = 'https://ddapi20-waterwebservices.rijkswaterstaat.nl';
export const RWS_CATALOGUE_URL = `${DDAPI}/METADATASERVICES/OphalenCatalogus`;
export const RWS_LATEST_URL = `${DDAPI}/ONLINEWAARNEMINGENSERVICES/OphalenLaatsteWaarnemingen`;
export const RWS_SERIES_URL = `${DDAPI}/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen`;

export const RWS_CATALOGUE_BODY = Object.freeze({
  CatalogusFilter: {
    Grootheden: true,
    Eenheden: true,
    Compartimenten: true,
    Hoedanigheden: true,
    ProcesTypes: true,
  },
});

/** Measured surface water height above NAP, in centimetres. */
const WATER_HEIGHT = Object.freeze({
  Compartiment: { Code: 'OW' },
  Grootheid: { Code: 'WATHTE' },
  Hoedanigheid: { Code: 'NAP' },
  ProcesType: 'meting',
});

export const RWS_CODE = /^[a-z0-9][a-z0-9._-]{1,80}$/;
/** Readings older than this are not current. */
const READING_MAX_AGE_MS = 24 * 60 * 60_000;
/** Values beyond ±50 m above NAP are sentinels, not water. */
const MAX_ABS_CM = 5_000;
/** The Netherlands with its coast, with margin. */
const IN_NETHERLANDS = (lat, lon) =>
  lat > 50.6 && lat < 53.8 && lon > 3.2 && lon < 7.3;

const isWaterHeight = (m, processType = 'meting') =>
  m?.Compartiment?.Code === 'OW' &&
  m?.Grootheid?.Code === 'WATHTE' &&
  m?.Hoedanigheid?.Code === 'NAP' &&
  m?.ProcesType === processType;

/**
 * Catalogue → Map(code → {code, name, lat, lon}) of the non-tidal locations
 * that measure water height above NAP.
 * @param {object} payload
 */
export function normalizeRwsCatalogue(payload) {
  const metadata = payload?.AquoMetadataLijst;
  const links = payload?.AquoMetadataLocatieLijst;
  const locations = payload?.LocatieLijst;
  if (
    !Array.isArray(metadata) ||
    !Array.isArray(links) ||
    !Array.isArray(locations)
  )
    throw new Error('invalid_catalogue');
  const measured = new Set();
  const tidal = new Set();
  for (const m of metadata) {
    if (isWaterHeight(m)) measured.add(m.AquoMetadata_MessageID);
    if (isWaterHeight(m, 'astronomisch')) tidal.add(m.AquoMetadata_MessageID);
  }
  const measuring = new Set();
  const tide = new Set();
  for (const link of links) {
    const id = link?.AquoMetaData_MessageID ?? link?.AquoMetadata_MessageID;
    if (measured.has(id)) measuring.add(link.Locatie_MessageID);
    if (tidal.has(id)) tide.add(link.Locatie_MessageID);
  }
  const out = new Map();
  for (const location of locations) {
    const id = location?.Locatie_MessageID;
    if (!measuring.has(id) || tide.has(id)) continue;
    const code = String(location.Code || '');
    const lat = Number(location.Lat);
    const lon = Number(location.Lon);
    if (!RWS_CODE.test(code) || !IN_NETHERLANDS(lat, lon)) continue;
    out.set(code, {
      code,
      name: String(location.Naam || code).slice(0, 80),
      lat,
      lon,
    });
  }
  return out;
}

/** Request body for the newest reading of each of `codes`. */
export function rwsLatestBody(codes) {
  return {
    LocatieLijst: [...codes].map((Code) => ({ Code })),
    AquoPlusWaarnemingMetadataLijst: [{ AquoMetadata: WATER_HEIGHT }],
  };
}

const iso = (ms) => new Date(ms).toISOString().replace('Z', '+00:00');

/** Request body for one location's readings from `sinceMs` to `untilMs`. */
export function rwsSeriesBody(code, sinceMs, untilMs) {
  if (!RWS_CODE.test(String(code))) throw new Error('invalid_station');
  return {
    Locatie: { Code: code },
    AquoPlusWaarnemingMetadata: { AquoMetadata: WATER_HEIGHT },
    Periode: { Begindatumtijd: iso(sinceMs), Einddatumtijd: iso(untilMs) },
  };
}

/** One measurement → [epochMs, metres], or null. */
function point(measurement) {
  const at = Date.parse(measurement?.Tijdstip);
  const cm = measurement?.Meetwaarde?.Waarde_Numeriek;
  if (!Number.isFinite(at) || typeof cm !== 'number' || !Number.isFinite(cm))
    return null;
  if (Math.abs(cm) >= MAX_ABS_CM) return null;
  return [at, cm / 100];
}

/**
 * Newest readings → shared stations. A location may answer with several
 * series (other instruments, archived methods): its newest reading wins.
 * @param {Map<string, object>} register
 * @param {object} payload
 * @param {number} now
 */
export function normalizeRwsLatest(register, payload, now) {
  const series = payload?.WaarnemingenLijst;
  if (!Array.isArray(series)) throw new Error('invalid_snapshot');
  const newest = new Map();
  for (const entry of series) {
    if (!isWaterHeight(entry?.AquoMetadata)) continue;
    const code = String(entry?.Locatie?.Code || '');
    if (!register.has(code)) continue;
    for (const measurement of entry.MetingenLijst || []) {
      const p = point(measurement);
      if (!p || now - p[0] > READING_MAX_AGE_MS || p[0] - now > 3_600_000)
        continue;
      const known = newest.get(code);
      if (!known || p[0] > known[0]) newest.set(code, p);
    }
  }
  const out = [];
  for (const [code, [observedMs, level]] of newest) {
    const gauge = register.get(code);
    out.push({
      id: `rws:${code}`,
      provider: 'rws',
      code,
      name: gauge.name,
      river: '',
      lat: gauge.lat,
      lon: gauge.lon,
      level,
      observedMs,
      refs: {},
      band: classifyRiverLevel(level, {}),
    });
  }
  return out;
}

/** One location's readings → [[epochMs, metres], …] in time order. */
export function normalizeRwsSeries(payload) {
  const series = payload?.WaarnemingenLijst;
  if (!Array.isArray(series)) throw new Error('invalid_series');
  const byTime = new Map();
  for (const entry of series) {
    if (!isWaterHeight(entry?.AquoMetadata)) continue;
    for (const measurement of entry.MetingenLijst || []) {
      const p = point(measurement);
      if (p) byTime.set(p[0], p[1]);
    }
  }
  return [...byTime].sort((a, b) => a[0] - b[0]);
}
