import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_WORLD_CCTV_SOURCE_FILE,
  MLIT_RIVER_IMAGE_ORIGIN,
  TRIPCHECK_IMAGE_ORIGIN,
  WORLD_CCTV_SOURCE_COUNT,
} from './constants.js';
import { pinnedCameraUrl } from './normalize.js';

const SOURCE_POLICIES = Object.freeze({
  'tripcheck-odot': {
    idPrefix: 'world-or-',
    origin: TRIPCHECK_IMAGE_ORIGIN,
    bounds: [41, 47, -125, -116],
    filename: /^\/roadcams\/cams\/[^/]+\.jpe?g$/i,
    frameRefreshMs: 5 * 60 * 1000,
  },
  'mlit-river': {
    idPrefix: 'world-jp-river-',
    origin: MLIT_RIVER_IMAGE_ORIGIN,
    bounds: [24, 46, 122, 154],
    filename: /^\/cam\/now\/\d+\.jpg$/i,
    // The provider asks clients to avoid frequent repeated image collection.
    frameRefreshMs: 10 * 60 * 1000,
  },
});

// MLIT currently serves this fixed JPEG on cameras whose images are paused
// for maintenance (verified against two Yamagata cameras on 2026-11-02).
const MLIT_ADJUSTMENT_IMAGE_SHA256 =
  'dbd2c3790eb75edf9ca44162f7979f2a3799090e23f2c5142f63211a035cb191';

export function isMlitRiverAdjustmentImage(image) {
  return (
    image?.ok === true &&
    Buffer.isBuffer(image.body) &&
    createHash('sha256').update(image.body).digest('hex') ===
      MLIT_ADJUSTMENT_IMAGE_SHA256
  );
}

function safeFrameUrl(value, policy) {
  const normalized = pinnedCameraUrl(value, policy.origin);
  if (!normalized) return '';
  const url = new URL(normalized);
  return !url.search && !url.hash && policy.filename.test(url.pathname)
    ? url.href
    : '';
}

function inBounds(lat, lon, [minLat, maxLat, minLon, maxLon]) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= minLat &&
    lat <= maxLat &&
    lon >= minLon &&
    lon <= maxLon
  );
}

/**
 * Load only the new image-backed networks from the add-on export. Existing
 * Canadian networks, Québec entries, JMA placeholder images, and NZTA's
 * scraped Journey Planner rows are deliberately excluded. Vegagerðin (Iceland)
 * rows are excluded too: the Iceland pack loads the full live list of those
 * cameras, so a World copy would draw each one twice.
 */
export function loadWorldCameraSources({ sourceRoot = process.cwd() } = {}) {
  const filename = path.resolve(sourceRoot, DEFAULT_WORLD_CCTV_SOURCE_FILE);
  let rows;
  try {
    const payload = JSON.parse(fs.readFileSync(filename, 'utf8'));
    rows = Array.isArray(payload) ? payload : [];
  } catch (error) {
    console.warn('[CCTV] World camera catalog unavailable:', error?.message);
    return [];
  }

  const seen = new Set();
  const sources = [];
  for (const row of rows) {
    const sourceKind = String(row?.sourceKind || '');
    const policy = SOURCE_POLICIES[sourceKind];
    if (!policy) continue;

    const id = String(row.id || '').trim();
    const lat = Number(row.lat);
    const lon = Number(row.lon);
    const url = safeFrameUrl(row.url || row.snapshotUrl, policy);
    const snapshotUrl = safeFrameUrl(row.snapshotUrl || row.url, policy);
    if (
      !id.startsWith(policy.idPrefix) ||
      seen.has(id) ||
      !inBounds(lat, lon, policy.bounds) ||
      !url ||
      !snapshotUrl ||
      url !== snapshotUrl
    )
      continue;
    seen.add(id);
    sources.push({
      id,
      name: String(row.name || id)
        .trim()
        .slice(0, 180),
      city: String(row.city || row.country || 'World'),
      cityId: String(row.cityId || ''),
      provider: String(row.provider || 'World traffic camera'),
      lat,
      lon,
      headingDeg: Number.isFinite(Number(row.headingDeg))
        ? Number(row.headingDeg)
        : undefined,
      headingConfidence: String(row.headingConfidence || 'low'),
      feedType: 'image',
      sourceKind,
      url,
      snapshotUrl,
      frameRefreshMs: policy.frameRefreshMs,
      license: String(row.license || ''),
      credit: String(row.credit || row.provider || ''),
    });
  }

  console.log(
    `[CCTV] Loaded World camera image sources: ${sources.length}/${WORLD_CCTV_SOURCE_COUNT}`,
  );
  return sources;
}
