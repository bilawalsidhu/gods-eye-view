import fs from 'node:fs';
import path from 'node:path';
import { positionKey } from './roadHeadings.js';

/** Sidecar written by scripts/precompute-ne511-headings.mjs. */
export const DEFAULT_NE511_HEADINGS_FILE =
  'src/data/local_data/ne511_headings/ne511_headings.json';

/** @type {{path:string, mtimeMs:number, cameras:object}|null} */
let _cache = null;

/**
 * Load the precomputed road-heading sidecar, cached by file mtime. A missing
 * or malformed file means "no shipped headings", never an error.
 *
 * @param {string} [sourceRoot]
 * @returns {Record<string, object>} camera id → sidecar entry
 */
export function loadRoadHeadings(sourceRoot = process.cwd()) {
  const file =
    process.env.CCTV_NE511_HEADINGS_FILE || DEFAULT_NE511_HEADINGS_FILE;
  const resolved = path.isAbsolute(file)
    ? file
    : path.resolve(sourceRoot, file);
  try {
    const stat = fs.statSync(resolved);
    if (_cache && _cache.path === resolved && _cache.mtimeMs === stat.mtimeMs) {
      return _cache.cameras;
    }
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    const cameras =
      parsed && typeof parsed === 'object' && parsed.cameras
        ? parsed.cameras
        : {};
    _cache = { path: resolved, mtimeMs: stat.mtimeMs, cameras };
    return cameras;
  } catch {
    _cache = null;
    return {};
  }
}

/**
 * Replace id-hash priors with precomputed road-aligned headings.
 *
 * Applied only where the camera still sits where the heading was computed.
 * `headingConfidence` stays 'low': the axis is measured but its direction is
 * inferred, so the calibration badge still reports a raw prior.
 *
 * @param {Array<object>} sources - Normalized served sources (mutated).
 * @param {Record<string, object>} entries - Sidecar cameras map.
 * @returns {Array<object>} The same sources, aligned where an entry was valid.
 */
export function joinRoadHeadings(sources, entries) {
  if (!entries || typeof entries !== 'object') return sources;
  for (const source of sources) {
    const entry = entries[source.id];
    if (!entry || entry.status !== 'ok') continue;
    if (!Number.isFinite(entry.headingDeg)) continue;
    if (entry.positionKey !== positionKey(source)) continue;
    // Only headingDeg changes: normalizeSourceItem reads `headingSource` as a
    // fallback for `headingConfidence`, so a marker field here would be
    // misread as a confidence.
    source.headingDeg = ((entry.headingDeg % 360) + 360) % 360;
  }
  return sources;
}
