// The parsed-file model of UTILITIES ▸ Import: what a GeoJSON, GPX, KML or
// KMZ file draws, as plain records, engine-neutral and without a Cesium
// DataSource. src/data/geoFileImport.js reads a file into it (GeoJSON and
// GPX here, KML and KMZ in src/data/geoImportKml.js), and
// src/data/geoImportDisplay.js draws it on any globe engine.
//
// Positions are [longitude, latitude, height] in degrees and metres above
// the ellipsoid; colours are rgba in 0..1. Every record has a short
// plain-text `name` (or undefined). The import keeps no descriptions,
// properties or times: a file's HTML never reaches the page, and a dated
// file never moves the app's clock (it draws as it is, for all time).
//
// @typedef {object} ImportedRecords
// @property {ImportedPoint[]} points
// @property {ImportedLine[]} lines
// @property {ImportedPolygon[]} polygons
// @property {ImportedOverlay[]} overlays
// @property {Object<string, number>} undrawn What the file has that no
//   engine draws, by kind (`wall`, `extruded`, `latLonQuad`), counted;
//   the display adds overlays and polygons it cannot draw (`rotatedOverlay`,
//   `raisedOverlay`, `polygon`, `complexPolygon`).
//
// @typedef {object} ImportedPoint
// @property {number[]} position
// @property {'ground'|'relative'|'absolute'} altitude On the ground (the
//   height is ignored), that high above it, or that high above the
//   ellipsoid.
// @property {ImportedIcon} icon
//
// @typedef {object} ImportedIcon How Cesium drew the point's billboard:
// @property {{ pin: number[], pinSize: number } | { url: string }} image
//   Cesium's map pin of that colour, drawn at pinSize px, or an image of the
//   file's own (a data: or blob: URL; nothing remote).
// @property {number} [widthPx] Drawn width before `scale` (the image's own
//   when omitted); `heightPx` likewise.
// @property {number} [heightPx]
// @property {number} [scale] 1 when omitted.
// @property {number[]} [color] Multiplies the image (white when omitted).
// @property {'center'|'bottom'} [origin] The point is the box's centre
//   (the default) or the middle of its bottom edge.
// @property {number[]} [offsetPx] [x, y], +y down: the box moved by this.
// @property {number[]} [subRegion] [x, y, width, height] of the image in
//   pixels, y up from its bottom (Cesium's imageSubRegion).
// @property {number[]} [scaleByDistance] [nearM, nearScale, farM, farScale].
// @property {number} [rotation] Radians counter-clockwise.
//
// @typedef {object} ImportedLine
// @property {number[][]} positions At least two.
// @property {boolean} ground Draped on the ground (heights ignored), else a
//   line through the positions' heights.
// @property {number[]} color
// @property {number} widthPx
//
// @typedef {object} ImportedPolygon
// @property {number[][][]} rings [outer, ...holes], each closed or not.
// @property {boolean} raised Drawn at its positions' heights on Cesium
//   (KML absolute and relative altitudes); else draped on the ground.
// @property {number[]|null} fill
// @property {{ color: number[], widthPx: number }|null} outline Cesium
//   draws it only on a raised polygon (an outline on terrain is not drawn).
//
// @typedef {object} ImportedOverlay A KML ground overlay.
// @property {string|null} url Its image, or null for a plain colour.
// @property {{ west: number, south: number, east: number, north: number }} rectangle
// @property {number[]} color Multiplies the image; its alpha fades it.
// @property {number} drawOrder Higher overlays draw over lower ones.
// @property {number} rotation Degrees counter-clockwise (KML LatLonBox).
// @property {number} altitude Metres (KML altitude); Cesium raises an
//   absolute overlay to it.
// @property {'ground'|'relative'|'absolute'} altitudeMode

import { MAX_IMPORT_NAME_LENGTH } from './geoImportLimits.js';

/** A feature name as short plain text (no control characters), or undefined. */
export function importFeatureName(value) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return undefined;
  return text.length > MAX_IMPORT_NAME_LENGTH
    ? `${text.slice(0, MAX_IMPORT_NAME_LENGTH - 1)}…`
    : text;
}

/** An empty set of records. */
export const emptyRecords = () => ({
  points: [],
  lines: [],
  polygons: [],
  overlays: [],
  undrawn: {},
});

/** How many map objects the records hold. */
export const recordCount = (records) =>
  records.points.length +
  records.lines.length +
  records.polygons.length +
  records.overlays.length;

/** A ring needs three different ground positions to enclose a fill. */
export const hasRingVertices = (ring) =>
  new Set(ring?.map(([lon, lat]) => `${lon},${lat}`)).size >= 3;

/** `#rrggbb` as rgba in 0..1, with Cesium.Color.fromCssColorString's bytes. */
export function rgbaOfHex(css, alpha = 1) {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(
    String(css).trim(),
  );
  if (!match) throw new TypeError(`Unsupported colour: ${css}`);
  return [
    parseInt(match[1], 16) / 255,
    parseInt(match[2], 16) / 255,
    parseInt(match[3], 16) / 255,
    alpha,
  ];
}

// The look Cesium's GeoJsonDataSource gave an import in the row's colour.
const GEOJSON_STROKE_PX = 3;
const GEOJSON_FILL_ALPHA = 0.25;
const GEOJSON_PIN_PX = 48;

/**
 * The records of a checked GeoJSON object (src/data/geoFileImport.js has
 * already cut it to names and ground positions), drawn as Cesium drew it
 * in the row's colour `color` (`#rrggbb`): points as a 48 px map pin of
 * that colour standing on the ground, lines as 3 px ground lines, polygons
 * as a fill at 0.25 (the 3 px outline Cesium leaves out on terrain).
 * Multipart geometries and geometry collections give one record per part.
 * @param {object} geojson
 * @param {string} color
 * @returns {ImportedRecords}
 */
export function geoJsonRecords(geojson, color) {
  const stroke = rgbaOfHex(color);
  const fill = [...stroke.slice(0, 3), GEOJSON_FILL_ALPHA];
  const records = emptyRecords();
  const position = ([lon, lat, height = 0]) => [lon, lat, height];
  const stack = [[geojson, undefined]];
  while (stack.length) {
    const [node, name] = stack.pop();
    if (!node) continue;
    if (node.type === 'FeatureCollection') {
      for (let i = node.features.length - 1; i >= 0; i--)
        stack.push([node.features[i], undefined]);
      continue;
    }
    if (node.type === 'Feature') {
      stack.push([node.geometry, node.properties?.name]);
      continue;
    }
    if (node.type === 'GeometryCollection') {
      for (let i = node.geometries.length - 1; i >= 0; i--)
        stack.push([node.geometries[i], name]);
      continue;
    }
    const parts = node.type.startsWith('Multi')
      ? node.coordinates
      : [node.coordinates];
    const kind = node.type.replace(/^Multi/, '');
    for (const part of parts) {
      if (kind === 'Point')
        records.points.push({
          name,
          position: position(part),
          altitude: 'ground',
          icon: {
            image: { pin: stroke, pinSize: GEOJSON_PIN_PX },
            origin: 'bottom',
          },
        });
      else if (kind === 'LineString' && part.length >= 2)
        records.lines.push({
          name,
          positions: part.map(position),
          ground: true,
          color: stroke,
          widthPx: GEOJSON_STROKE_PX,
        });
      else if (kind === 'Polygon' && hasRingVertices(part[0]))
        records.polygons.push({
          name,
          rings: part.filter(hasRingVertices).map((ring) => ring.map(position)),
          raised: false,
          fill,
          outline: { color: stroke, widthPx: GEOJSON_STROKE_PX },
        });
    }
  }
  return records;
}

/**
 * Every position the records draw, as [lon, lat, height], for framing:
 * what lies on the ground at height 0, and each overlay's corners.
 * @param {ImportedRecords} records
 * @returns {number[][]}
 */
export function recordFootprint(records) {
  const out = [];
  const add = ([lon, lat, height = 0], grounded) => {
    if (Number.isFinite(lon) && Number.isFinite(lat))
      out.push([lon, lat, grounded || !Number.isFinite(height) ? 0 : height]);
  };
  for (const point of records.points)
    add(point.position, point.altitude === 'ground');
  for (const line of records.lines)
    for (const position of line.positions) add(position, line.ground);
  for (const polygon of records.polygons)
    for (const ring of polygon.rings)
      for (const position of ring) add(position, !polygon.raised);
  for (const { rectangle: r } of records.overlays) {
    const east = r.east < r.west ? r.east + 360 : r.east;
    for (const lon of [r.west, east])
      for (const lat of [r.south, r.north])
        add([lon > 180 ? lon - 360 : lon, lat, 0], true);
  }
  return out;
}
