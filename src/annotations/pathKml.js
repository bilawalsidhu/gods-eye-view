/**
 * Path import: KML.
 *
 * Every `<Placemark>` in the document, at any folder depth, contributes the
 * geometry it holds:
 *
 * - `<LineString>` and a free-standing `<LinearRing>`: a line.
 * - `<Polygon>`: an area from its OUTER boundary. Inner boundaries (holes) are
 *   not carried: a hand-drawn whiteboard area has no holes either, and the
 *   importer says areas rather than promising exact polygons.
 * - `<Point>`: a pin.
 * - `<gx:Track>`: a line through its `<gx:coord>` samples, which is how Google
 *   Earth and several loggers write a recorded track.
 * - `<MultiGeometry>` and `<gx:MultiTrack>`: each member, under the placemark's
 *   name.
 *
 * KMZ is a zip archive around a KML file and is not read here; `pathImport.js`
 * tells the person to unzip it.
 *
 * No Cesium, no DOM.
 */
import {
  PathImportError,
  childText,
  childrenNamed,
  descendantsNamed,
  firstChild,
  scanXml,
} from './pathXml.js';

/**
 * @param {string} text KML document text.
 * @returns {Array<{kind: 'line'|'area'|'pin', name: string, points: Array<[number, number]>}>}
 */
export function parseKml(text) {
  const doc = scanXml(text);
  if (!firstChild(doc, 'kml') && !descendantsNamed(doc, 'placemark').length)
    throw new PathImportError(
      'not-kml',
      'The file has no <kml> element, so it is not a KML file.',
    );
  const features = [];
  for (const placemark of descendantsNamed(doc, 'placemark')) {
    const name = childText(placemark, 'name');
    for (const child of placemark.children)
      collectGeometry(child, name, features);
  }
  return features;
}

/** Append the features one geometry element describes; unknown elements add nothing. */
function collectGeometry(node, name, features) {
  switch (node.name) {
    case 'linestring':
    case 'linearring':
      features.push({
        kind: 'line',
        name,
        points: parseCoordinates(childText(node, 'coordinates')),
      });
      return;
    case 'polygon': {
      const ring = firstChild(
        firstChild(node, 'outerboundaryis'),
        'linearring',
      );
      features.push({
        kind: 'area',
        name,
        points: parseCoordinates(childText(ring, 'coordinates')),
      });
      return;
    }
    case 'point': {
      const points = parseCoordinates(childText(node, 'coordinates'));
      features.push({ kind: 'pin', name, points: points.slice(0, 1) });
      return;
    }
    case 'track':
      features.push({
        kind: 'line',
        name,
        points: childrenNamed(node, 'coord').map((coord) =>
          tupleOf(coord.text.trim().split(/\s+/)),
        ),
      });
      return;
    case 'multigeometry':
    case 'multitrack':
      for (const child of node.children) collectGeometry(child, name, features);
      return;
    default:
  }
}

/**
 * A KML `<coordinates>` body: whitespace-separated `lon,lat[,alt]` tuples.
 * @param {string} text
 * @returns {Array<[number, number]>}
 */
export function parseCoordinates(text) {
  const body = String(text || '').trim();
  if (!body) return [];
  return body.split(/\s+/).map((tuple) => tupleOf(tuple.split(',')));
}

/** The first two parts as [lon, lat]; NaN where absent, for the validator to drop. */
function tupleOf(parts) {
  return [numberOf(parts[0]), numberOf(parts[1])];
}

/** A strict decimal: '' and 'abc' are NaN, not 0. */
function numberOf(raw) {
  const text = String(raw ?? '').trim();
  return text ? Number(text) : Number.NaN;
}
