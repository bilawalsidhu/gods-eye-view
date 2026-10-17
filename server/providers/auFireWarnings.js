import { readResponseJsonCapped } from './common/http.js';

// Australian bushfire warning feeds (public, keyless, government open data):
//  - QLD QFES current bushfire alerts (Advice .. Emergency Warning levels)
//  - NSW RFS major incidents (Fires Near Me feed)
// Both publish GeoJSON feature collections. Warnings are polygons or points;
// the perimeters layer consumes polygons, so point-only advisories are dropped
// with the same fail-soft rule as WFIGS generalized-away geometry.

// The documented www.qfes.qld.gov.au URL sits behind an Incapsula JS
// challenge that rejects non-browser clients; the feed's own redirect
// target on the PSBA GIS origin serves the identical JSON keyless.
export const QLD_ALERTS_URL =
  'https://publiccontent.gis.psba.qld.gov.au/content/Feeds/BushfireCurrentIncidents/bushfireAlert.json';
const NSW_RFS_URL = 'https://www.rfs.nsw.gov.au/feeds/majorIncidents.json';

const MIB = 1024 * 1024;

// QFES classifies these as bushfire community warnings; "Information" rows
// are routine permit-burn or advice notes that still carry a warning area.
const QLD_WARNING_LEVELS = new Set([
  'Emergency Warning',
  'Watch and Act',
  'Advice',
  'Information',
]);

function textOrNull(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function validRing(ring) {
  if (!Array.isArray(ring) || ring.length < 4) return false;
  for (const position of ring) {
    if (!Array.isArray(position) || position.length < 2) return false;
    const [lon, lat] = position;
    if (!Number.isFinite(lon) || Math.abs(lon) > 180) return false;
    if (!Number.isFinite(lat) || Math.abs(lat) > 90) return false;
  }
  return true;
}

/** Polygon/MultiPolygon → array of polygons (each an array of rings), or null. */
function normalizePolygons(geometry) {
  if (!geometry || typeof geometry !== 'object') return null;
  let polygons;
  if (geometry.type === 'Polygon') polygons = [geometry.coordinates];
  else if (geometry.type === 'MultiPolygon') polygons = geometry.coordinates;
  else return null;
  if (!Array.isArray(polygons)) return null;
  const result = [];
  for (const rings of polygons) {
    if (!Array.isArray(rings)) return null;
    if (!rings.length) continue;
    if (!rings.every(validRing)) return null;
    result.push(rings);
  }
  return result;
}

/** Flatten a GeoJSON GeometryCollection to its polygon members, or null. */
function polygonsFromGeometryCollection(geometry) {
  if (geometry?.type !== 'GeometryCollection') return null;
  const polygons = [];
  for (const member of geometry.geometries || []) {
    const normalized = normalizePolygons(member);
    if (normalized) polygons.push(...normalized);
  }
  return polygons.length ? polygons : null;
}

function polygonsForFeature(feature) {
  const direct = normalizePolygons(feature?.geometry);
  if (direct) return direct;
  return polygonsFromGeometryCollection(feature?.geometry);
}

// --- QLD QFES -----------------------------------------------------------

/**
 * Normalize the QFES bushfire alerts feed into perimeter rows. Point-only
 * advisory features are skipped; a payload that is not a feature collection
 * at all rejects the whole snapshot (null), matching WFIGS semantics.
 * Warning levels ride in `complexity`; no feed field maps to containment,
 * so `containedPct` stays null rather than inventing a percentage.
 */
export function normalizeQldBushfireAlerts(geojson) {
  if (!Array.isArray(geojson?.features)) return null;
  const rows = [];
  const ids = new Set();
  for (const feature of geojson.features) {
    const properties = feature?.properties;
    if (!properties || typeof properties !== 'object') continue;
    const eventType = String(properties.EventType || '').trim();
    if (eventType && eventType.toLowerCase() !== 'fire') continue;
    const warningLevel = textOrNull(properties.WarningLevel);
    if (warningLevel && !QLD_WARNING_LEVELS.has(warningLevel)) continue;
    const polygons = polygonsForFeature(feature);
    if (!polygons) continue;
    const stableId = textOrNull(properties.UniqueID);
    if (stableId == null || ids.has(stableId)) continue;
    ids.add(stableId);
    const updatedMs = Date.parse(properties.ItemDateTimeLocal_ISO || '');
    rows.push({
      stableId: `qld:${stableId}`,
      name: textOrNull(properties.WarningTitle) || stableId,
      acres: null,
      containedPct: null,
      state: 'QLD',
      category: textOrNull(properties.GroupedType),
      discoveredTime: null,
      // The feed's *_UTM timestamps are W3C/DMTF "20261014031508.630000";
      // the paired *_Local_ISO field carries the same instant in ISO 8601.
      updatedTime: Number.isFinite(updatedMs) ? updatedMs : null,
      cause: null,
      behavior: textOrNull(properties.CallToAction),
      personnel: null,
      county: textOrNull(properties.WarningArea),
      costToDate: null,
      complexity: warningLevel,
      complexName: null,
      polygons,
    });
  }
  return rows;
}

// --- NSW RFS ------------------------------------------------------------

/** Parse the RFS dd/mm/yyyy h:mm:ss AM/PM pubDate (Sydney local) into ms. */
function parseRfsPubDate(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(
    /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)?$/i,
  );
  if (!match) return null;
  const [, day, month, year, hour, minute, second, meridiem] = match;
  let hours = Number(hour);
  if (meridiem) {
    const upper = meridiem.toUpperCase();
    if (upper === 'PM' && hours !== 12) hours += 12;
    if (upper === 'AM' && hours === 12) hours = 0;
  }
  const iso = `${year}-${month}-${day}T${String(hours).padStart(2, '0')}:${minute}:${second}`;
  // The feed publishes Sydney local time with no zone designator; +10:00
  // (AEST) is used — a one-hour skew during AEDT only affects display age.
  const ms = Date.parse(`${iso}+10:00`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Normalize the NSW RFS major incidents feed into perimeter rows. The
 * Fires Near Me GeoJSON wraps polygons in GeometryCollections; alert level,
 * size (ha) and status ride in RSS-style properties and an HTML description.
 */
export function normalizeNswRfsIncidents(geojson) {
  if (!Array.isArray(geojson?.features)) return null;
  const rows = [];
  const ids = new Set();
  for (const feature of geojson.features) {
    const properties = feature?.properties;
    if (!properties || typeof properties !== 'object') continue;
    const polygons = polygonsForFeature(feature);
    if (!polygons) continue;
    const stableId =
      textOrNull(properties.guid) || textOrNull(properties.title);
    if (stableId == null || ids.has(stableId)) continue;
    ids.add(stableId);
    const alertLevel = textOrNull(properties.category);
    const description = textOrNull(properties.description) || '';
    const sizeHa = finiteOrNull(
      Number(
        (description.match(/SIZE:\s*([\d,.]+)\s*ha/i) || [])[1]?.replace(
          /,/g,
          '',
        ),
      ),
    );
    const status = (description.match(/STATUS:\s*([^<]+)/i) || [])[1]?.trim();
    const council = (description.match(/COUNCIL AREA:\s*([^<]+)/i) ||
      [])[1]?.trim();
    rows.push({
      stableId: `nsw:${stableId}`,
      name: textOrNull(properties.title) || stableId,
      acres: sizeHa == null ? null : sizeHa * 2.47105,
      containedPct: null,
      state: 'NSW',
      category: alertLevel,
      discoveredTime: null,
      updatedTime: parseRfsPubDate(properties.pubDate),
      cause: null,
      behavior: status ? String(status) : null,
      personnel: null,
      county: council || null,
      costToDate: null,
      complexity: alertLevel,
      complexName: null,
      polygons,
    });
  }
  return rows;
}

// --- Fetch helper ---------------------------------------------------------

const feedEnabled = (name) => String(process.env[name] || '1').trim() !== '0';

async function upstreamJson(fetchImpl, url, cap, timeout) {
  const signal = AbortSignal.timeout(timeout);
  const response = await fetchImpl(url, { signal, redirect: 'follow' });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('upstream_unavailable');
  }
  return readResponseJsonCapped(response, cap, signal);
}

/**
 * Fetch both AU feeds in parallel and return merged perimeter rows.
 * One feed failing (or disabled) must never blank the other or the US
 * snapshot: every failure degrades to an empty contribution.
 */
export async function fetchAuFireWarningRows({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  const feed = async (envName, url, normalize, cap) => {
    if (!feedEnabled(envName)) return [];
    try {
      const rows = normalize(await upstreamJson(fetchImpl, url, cap, 30_000));
      return rows || [];
    } catch {
      return [];
    }
  };
  const [qld, nsw] = await Promise.all([
    feed(
      'FIRE_AU_QLD_ENABLED',
      QLD_ALERTS_URL,
      normalizeQldBushfireAlerts,
      8 * MIB,
    ),
    feed('FIRE_AU_NSW_ENABLED', NSW_RFS_URL, normalizeNswRfsIncidents, 8 * MIB),
  ]);
  return [...qld, ...nsw];
}
