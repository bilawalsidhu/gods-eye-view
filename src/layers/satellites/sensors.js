/**
 * @file Imaging sensors: which Earth-observation platform a satellite is, and
 * the swath its sensor images. The orbital view draws that swath to scale and
 * lets a satellite zoom past 8x only as far as its sensor's narrowest
 * standard swath (src/cockpitOrbital.js `orbitalMaxZoom`).
 *
 * Pure: no Cesium, no fetches; the bundled pack is loaded by
 * src/data/imagingSensors.js.
 *
 * @module imagingSensors
 */

/**
 * One sensor-pack entry as the app uses it.
 * @typedef {{id: string, label: string, operator: string|null,
 *   sensor: string, type: string, altitudeKm: number|null,
 *   modes: Array<{name: string, swathKm: number|null, gsdM: number|null}>,
 *   narrowestSwathKm: number|null, swathConfirmed: boolean,
 *   sources: string[], unverified: string[]}} ImagingSensor
 */

/**
 * Index the pack for matching: exact NORAD numbers first, then name patterns
 * in pack order. A malformed pattern is skipped, not fatal.
 * @param {{entries?: Array<object>}} pack Parsed `imaging_sensors.json`.
 * @returns {{byNorad: Map<number, ImagingSensor>,
 *   patterns: Array<{pattern: RegExp, sensor: ImagingSensor}>}}
 */
export function indexImagingSensors(pack) {
  const byNorad = new Map();
  const patterns = [];
  for (const entry of pack?.entries || []) {
    if (!entry?.id) continue;
    const sensor = Object.freeze({
      id: entry.id,
      label: entry.label || entry.id,
      operator: entry.operator ?? null,
      sensor: entry.sensor || '',
      type: entry.type || '',
      altitudeKm: Number.isFinite(entry.altitudeKm) ? entry.altitudeKm : null,
      modes: Object.freeze(
        (entry.modes || []).map((mode) => Object.freeze({ ...mode })),
      ),
      narrowestSwathKm: Number.isFinite(entry.narrowestSwathKm)
        ? entry.narrowestSwathKm
        : null,
      swathConfirmed: entry.swathConfirmed === true,
      sources: Object.freeze([...(entry.sources || [])]),
      unverified: Object.freeze([...(entry.unverified || [])]),
    });
    for (const noradId of entry.match?.norad || []) {
      if (Number.isInteger(noradId) && !byNorad.has(noradId))
        byNorad.set(noradId, sensor);
    }
    if (entry.match?.nameRegex) {
      try {
        patterns.push({ pattern: new RegExp(entry.match.nameRegex), sensor });
      } catch {
        // A bad pattern only loses its name match; NORAD ids still work.
      }
    }
  }
  return { byNorad, patterns };
}

/**
 * The sensor entry for a satellite: by NORAD number, else by its CelesTrak
 * name (upper-cased, trimmed).
 * @param {ReturnType<typeof indexImagingSensors>|null|undefined} index
 * @param {{noradId?: number, name?: string}} satellite
 * @returns {ImagingSensor|null}
 */
export function matchImagingSensor(index, { noradId, name } = {}) {
  if (!index) return null;
  const byId = index.byNorad?.get(noradId);
  if (byId) return byId;
  const text = String(name || '')
    .trim()
    .toUpperCase();
  if (!text) return null;
  for (const { pattern, sensor } of index.patterns || [])
    if (pattern.test(text)) return sensor;
  return null;
}

/**
 * The swath the orbital view may zoom to: the narrowest standard swath, only
 * when it was confirmed on a cited page. An unconfirmed swath keeps the
 * satellite at the base zoom steps.
 * @param {ImagingSensor|null|undefined} sensor
 * @returns {number|null} Kilometres.
 */
export function zoomableSwathKm(sensor) {
  const swathKm = sensor?.narrowestSwathKm;
  return sensor?.swathConfirmed === true &&
    Number.isFinite(swathKm) &&
    swathKm > 0
    ? swathKm
    : null;
}
