import fs from 'node:fs';
import path from 'node:path';
import { positionKey, resolveAxisDirection } from './roadHeadings.js';

/** Sidecar written by scripts/precompute-ne511-headings.mjs. */
export const DEFAULT_NE511_HEADINGS_FILE =
  'src/data/local_data/ne511_headings/ne511_headings.json';
/**
 * Entries are keyed by camera position (positionKey), not camera id: NDOT
 * renumbers its cameras, while a mast stays where it is.
 */
export const NE511_HEADINGS_SCHEMA_VERSION = 2;

/** @type {{path:string, mtimeMs:number, cameras:object}|null} */
let _cache = null;

/**
 * Load the precomputed road-heading sidecar, cached by file mtime. A missing
 * or malformed file means "no shipped headings", never an error.
 *
 * @param {string} [sourceRoot]
 * @returns {Record<string, object>} position key → sidecar entry
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
      parsed?.schemaVersion === NE511_HEADINGS_SCHEMA_VERSION &&
      parsed.cameras &&
      typeof parsed.cameras === 'object'
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
 * The sidecar records the road axis at each camera position. Which way along
 * that axis the camera looks is resolved here from the live title and prior
 * (resolveAxisDirection), so two masts sharing a position can face opposite
 * ways. `headingConfidence` stays 'low': the axis is measured but its direction is
 * inferred, so the camera keeps presenting as estimated — a raw prior on the
 * calibration badge, and an (ESTIMATED) HUD tag with a dashed coverage
 * wireframe (src/layers/cctv/headingConfidence.js).
 *
 * @param {Array<object>} sources - Normalized served sources (mutated).
 * @param {Record<string, object>} entries - Sidecar map keyed by position.
 * @returns {Array<object>} The same sources, aligned where an entry was valid.
 */
export function joinRoadHeadings(sources, entries) {
  if (!entries || typeof entries !== 'object') return sources;
  for (const source of sources) {
    const key = positionKey(source);
    const entry = key ? entries[key] : null;
    if (!entry || entry.status !== 'ok') continue;
    if (!Number.isFinite(entry.axisDeg)) continue;
    // Wrapped, then held at the sidecar's 0.01° precision.
    const axisDeg = Number((((entry.axisDeg % 360) + 360) % 360).toFixed(2));
    // Only headingDeg changes: normalizeSourceItem reads `headingSource` as a
    // fallback for `headingConfidence`, so a marker field here would be
    // misread as a confidence.
    source.headingDeg = resolveAxisDirection(
      axisDeg,
      source.name,
      source.headingDeg,
    );
  }
  return sources;
}
