/**
 * Record normalization for ABYSS deep-sea data.
 * Pure logic: validates geographic coordinates, depth values, and source metadata.
 */

import { FEATURE_KINDS } from './model.js';

/**
 * Validate latitude and longitude in standard WGS84 bounds.
 * @param {number} lon
 * @param {number} lat
 * @returns {boolean}
 */
export function isValidCoordinate(lon, lat) {
  return (
    Number.isFinite(lon) &&
    Number.isFinite(lat) &&
    lon >= -180 &&
    lon <= 180 &&
    lat >= -90 &&
    lat <= 90
  );
}

/**
 * Cleanly sanitize and truncate string fields.
 * @param {unknown} val
 * @param {string|null} fallback
 * @returns {string|null}
 */
function cleanString(val, fallback = null) {
  if (typeof val !== 'string') return fallback;
  const trimmed = val.replace(/\s+/g, ' ').trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

/**
 * Parse depth in meters safely from number or string.
 * @param {unknown} val
 * @returns {number|null}
 */
export function parseDepthMeters(val) {
  if (typeof val === 'number' && Number.isFinite(val)) {
    return Math.abs(val);
  }
  if (typeof val === 'string') {
    const cleaned = val.trim();
    if (!cleaned) return null;
    // Check if it's a range like "500-382" or "60-0"
    const parts = cleaned
      .split('-')
      .map((p) => parseFloat(p.trim()))
      .filter((n) => Number.isFinite(n));
    if (parts.length > 0) {
      return Math.max(...parts.map(Math.abs));
    }
  }
  return null;
}

/**
 * Normalize a single hydrothermal vent record from NOAA PMEL.
 * @param {object} raw
 * @param {number} [index]
 * @returns {object|null}
 */
export function normalizeVentRecord(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null;

  const lon = Number(raw.lon ?? raw.longitude);
  const lat = Number(raw.lat ?? raw.latitude);

  if (!isValidCoordinate(lon, lat)) return null;

  const id = cleanString(raw.id) || `vent-${index + 1}`;
  const name = cleanString(raw.name) || 'Unnamed Hydrothermal Vent';
  const siteActivity = cleanString(raw.siteActivity) || 'Unknown';
  const rawActivity = String(raw.activity || '')
    .trim()
    .toLowerCase();
  const activity = ['active', 'inactive', 'unconfirmed'].includes(rawActivity)
    ? rawActivity
    : 'unconfirmed';

  const tectonicSetting = cleanString(raw.tectonicSetting) || 'Unknown';
  const spreadingRate = cleanString(raw.spreadingRate) || 'Unknown';
  const depthM = parseDepthMeters(raw.depthM ?? raw.depth ?? raw.rawDepth);

  return Object.freeze({
    id,
    kind: FEATURE_KINDS.VENT,
    name,
    lon,
    lat,
    depthM,
    activity,
    siteActivity,
    tectonicSetting,
    spreadingRate,
    source: 'NOAA PMEL Earth-Ocean Interactions',
    sourceUrl:
      cleanString(raw.sourceUrl) ||
      'https://www.pmel.noaa.gov/eoi/PlumeStudies/global-vents/global-vents-text.html',
    evidenceUrl: cleanString(raw.evidenceUrl) || null,
  });
}

/**
 * Normalize an entire snapshot of hydrothermal vent records.
 * @param {unknown} data
 * @returns {object[]|null}
 */
export function normalizeVentSnapshot(data) {
  if (!Array.isArray(data)) return null;
  const records = [];
  const seenIds = new Set();

  for (let i = 0; i < data.length; i++) {
    const norm = normalizeVentRecord(data[i], i);
    if (!norm) continue;
    let finalId = norm.id;
    if (seenIds.has(finalId)) {
      finalId = `${norm.id}-${i + 1}`;
    }
    seenIds.add(finalId);
    records.push(
      finalId === norm.id ? norm : Object.freeze({ ...norm, id: finalId }),
    );
  }

  return Object.freeze(records);
}

/**
 * Normalize a single NOAA Ocean Exploration ROV dive location record.
 * @param {object} raw
 * @param {number} [index]
 * @returns {object|null}
 */
export function normalizeDiveRecord(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null;

  const attrs = raw.attributes || raw;
  const geom = raw.geometry || {};

  const lon = Number(geom.x ?? attrs.longitude ?? attrs.lon);
  const lat = Number(geom.y ?? attrs.latitude ?? attrs.lat);

  if (!isValidCoordinate(lon, lat)) return null;

  const cruiseDiveId =
    cleanString(attrs.cruise_dive_id ?? attrs.CruiseDiveID) ||
    `EX_DIVE_${attrs.OBJECTID || index + 1}`;
  const cruiseId = cleanString(attrs.cruise_id ?? attrs.CruiseID);
  const diveId = cleanString(attrs.dive_id ?? attrs.DiveID);
  const cruiseTitle =
    cleanString(attrs.Cruise ?? attrs.cruiseTitle) ||
    'Okeanos Explorer Expedition';
  const vessel =
    cleanString(attrs.vessel ?? attrs.Vessel) || 'NOAA Ship Okeanos Explorer';
  const platform =
    cleanString(attrs.platform ?? attrs.Platform) || 'ROV Deep Discoverer';
  const year = Number.isFinite(Number(attrs.Year)) ? Number(attrs.Year) : null;
  const cruiseDates = cleanString(attrs.Cruise_Dates ?? attrs.cruiseDates);
  const summary = cleanString(attrs.Summary ?? attrs.summary);
  const maxDepthM = parseDepthMeters(
    attrs.MaxDepth ?? attrs.MaxVehicleDepth ?? attrs.maxDepthM,
  );
  const diveDuration = cleanString(attrs.DiveDuration ?? attrs.diveDuration);

  // Extract official scientific links
  const expeditionUrl = cleanString(attrs.OE_Link ?? attrs.expeditionUrl);
  const mediaUrl = cleanString(attrs.ROV_Summary_Products ?? attrs.mediaUrl);
  const archiveUrl = cleanString(attrs.Archive ?? attrs.archiveUrl);

  return Object.freeze({
    id: `dive-${cruiseDiveId}`,
    kind: FEATURE_KINDS.DIVE,
    cruiseDiveId,
    cruiseId,
    diveId,
    name: diveId ? `${vessel} · ${diveId}` : cruiseTitle,
    cruiseTitle,
    vessel,
    platform,
    year,
    cruiseDates,
    lon,
    lat,
    depthM: maxDepthM,
    diveDuration,
    summary,
    expeditionUrl,
    mediaUrl,
    archiveUrl,
    source: 'NOAA Ocean Exploration',
    sourceUrl: 'https://oceanexplorer.noaa.gov/',
  });
}

/**
 * Normalize an array or FeatureSet of dive location records.
 * @param {unknown} data
 * @returns {object[]|null}
 */
export function normalizeDiveSnapshot(data) {
  const items = Array.isArray(data)
    ? data
    : Array.isArray(data?.features)
      ? data.features
      : null;
  if (!items) return null;

  const records = [];
  const seenIds = new Set();

  for (let i = 0; i < items.length; i++) {
    const norm = normalizeDiveRecord(items[i], i);
    if (!norm) continue;
    if (seenIds.has(norm.id)) continue;
    seenIds.add(norm.id);
    records.push(norm);
  }

  return Object.freeze(records);
}

/**
 * Normalize an ROV dive track polyline from NOAA Ocean Exploration.
 * @param {object} raw
 * @returns {object|null}
 */
export function normalizeDiveTrackRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const attrs = raw.attributes || raw;
  const geom = raw.geometry || {};
  const paths = geom.paths || raw.paths;

  if (!Array.isArray(paths) || paths.length === 0) return null;

  // Validate coordinates in polyline paths and split across antimeridian jumps
  const validPaths = [];
  for (const path of paths) {
    if (!Array.isArray(path)) continue;
    let currentSegment = [];
    for (const pt of path) {
      if (Array.isArray(pt) && pt.length >= 2) {
        const lon = Number(pt[0]);
        const lat = Number(pt[1]);
        if (isValidCoordinate(lon, lat)) {
          if (currentSegment.length > 0) {
            const prevLon = currentSegment[currentSegment.length - 1][0];
            // Split across antimeridian jumps to prevent 360-degree wrap chords
            if (Math.abs(lon - prevLon) > 180) {
              if (currentSegment.length >= 2) {
                validPaths.push(currentSegment);
              }
              currentSegment = [];
            }
          }
          currentSegment.push([lon, lat]);
        }
      }
    }
    if (currentSegment.length >= 2) {
      validPaths.push(currentSegment);
    }
  }

  if (validPaths.length === 0) return null;

  const cruiseDiveId = cleanString(attrs.CruiseDiveID ?? attrs.cruise_dive_id);
  const id = `track-${cruiseDiveId || attrs.OBJECTID || Math.random().toString(36).slice(2, 7)}`;
  const lengthM = Number.isFinite(Number(attrs.Shape__Length))
    ? Math.round(Number(attrs.Shape__Length))
    : null;

  return Object.freeze({
    id,
    cruiseDiveId,
    paths: validPaths,
    lengthM,
    source: 'NOAA Ocean Exploration',
  });
}

/**
 * Validate GEBCO WMS bathymetry configuration parameters.
 * @param {object} [options]
 * @returns {object}
 */
export function normalizeBathymetryConfig(options = {}) {
  const baseUrl = cleanString(options.url) || 'https://wms.gebco.net/mapserv?';
  const defaultLayer = cleanString(options.layer) || 'GEBCO_LATEST_2';
  const format = cleanString(options.format) || 'image/jpeg';
  const version = cleanString(options.version) || '1.3.0';

  return Object.freeze({
    url: baseUrl,
    layer: defaultLayer,
    format,
    version,
    credit: 'Bathymetry: GEBCO Compilation Group (2025/2026)',
    creditUrl: 'https://www.gebco.net',
  });
}
