/**
 * Path import: GPX.
 *
 * Reads the three things a GPX file carries that belong on a map:
 *
 * - `<trk>` tracks: each `<trkseg>` is one line. A track recorded with a pause
 *   has several segments, and joining them would draw a straight line across
 *   the gap nobody walked, so segments stay separate lines.
 * - `<rte>` routes: one line through its `<rtept>` points.
 * - `<wpt>` waypoints: pins.
 *
 * The result is the raw feature list every format reader returns
 * (`{kind, name, points: [lon, lat][]}`); validation, simplification and the
 * limits are applied once, for all formats, in `pathImport.js`.
 *
 * No Cesium, no DOM.
 */
import {
  PathImportError,
  childText,
  childrenNamed,
  firstChild,
  scanXml,
} from './pathXml.js';

/**
 * @param {string} text GPX document text.
 * @returns {Array<{kind: 'line'|'pin', name: string, points: Array<[number, number]>}>}
 */
export function parseGpx(text) {
  const gpx = firstChild(scanXml(text), 'gpx');
  if (!gpx)
    throw new PathImportError(
      'not-gpx',
      'The file has no <gpx> element, so it is not a GPX file.',
    );
  const features = [];

  for (const trk of childrenNamed(gpx, 'trk')) {
    const name = childText(trk, 'name');
    const segments = childrenNamed(trk, 'trkseg').filter(
      (segment) => childrenNamed(segment, 'trkpt').length,
    );
    segments.forEach((segment, index) => {
      features.push({
        kind: 'line',
        // "Ridge walk", "Ridge walk (2)" — the parts of one paused track.
        name: index === 0 || !name ? name : `${name} (${index + 1})`,
        points: childrenNamed(segment, 'trkpt').map(pointOf),
      });
    });
  }

  for (const rte of childrenNamed(gpx, 'rte')) {
    features.push({
      kind: 'line',
      name: childText(rte, 'name'),
      points: childrenNamed(rte, 'rtept').map(pointOf),
    });
  }

  for (const wpt of childrenNamed(gpx, 'wpt')) {
    features.push({
      kind: 'pin',
      name: childText(wpt, 'name'),
      points: [pointOf(wpt)],
    });
  }

  return features;
}

/** `lat`/`lon` attributes as a [lon, lat] pair; NaN where absent, for the validator to drop. */
function pointOf(node) {
  return [numberOf(node.attrs.lon), numberOf(node.attrs.lat)];
}

/** A strict decimal: '' and 'abc' are NaN, not 0. */
function numberOf(raw) {
  const text = String(raw ?? '').trim();
  return text ? Number(text) : Number.NaN;
}
