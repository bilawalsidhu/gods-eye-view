/**
 * Path import: the pure half.
 *
 * Draw puts a mark on the board one click at a time. This is the other way in
 * for geometry a person already has: a GPX track from a hike, a KML exported
 * from another map, a GeoJSON file. The text of the file goes in, and what
 * comes out is the SAME annotation spec Draw produces (`type: area | route |
 * pin`, geometry supplied, `manual: true`), so an imported track renders,
 * de-dups, lists and clears exactly like a drawn or spoken mark and nothing
 * downstream learns a new shape.
 *
 * The format readers (`pathGpx.js`, `pathKml.js`, `pathGeoJson.js`) only read.
 * Everything a file cannot be trusted about is decided here, once, for all of
 * them: coordinates off the globe, shapes that describe nothing, a file with
 * more marks than the board should take, a track with more points than a mark
 * should carry. Each refusal is counted and reported, never silent.
 *
 * No Cesium, no DOM — importable under `node --test`. The DOM half is
 * `pathImportTool.js`.
 */
import {
  MIN_AREA_M2,
  MIN_PATH_LENGTH_M,
  closeRing,
  pathLengthM,
  ringAreaM2,
} from './drawMode.js';
import { parseGeoJson } from './pathGeoJson.js';
import { parseGpx } from './pathGpx.js';
import { parseKml } from './pathKml.js';
import { simplifyPath } from './pathSimplify.js';
import { PathImportError } from './pathXml.js';

export { PathImportError };

/** Formats the importer reads, in the order the file picker lists them. */
export const PATH_IMPORT_FORMATS = Object.freeze(['gpx', 'kml', 'geojson']);
/** The file picker's `accept` list. */
export const PATH_IMPORT_ACCEPT = '.gpx,.kml,.geojson,.json';
/**
 * Ceiling on the text of one file, in UTF-16 code units. A multi-day 1 Hz GPX
 * with extensions is a few megabytes; this is well past that and well short of
 * what would stall the tab while it is scanned.
 */
export const MAX_IMPORT_CHARS = 16 * 1024 * 1024;
/**
 * Marks taken from one file. The board holds 120 live marks in total, shared
 * with Draw and the voice whiteboard, so one file may claim half of it.
 */
export const MAX_IMPORT_FEATURES = 60;
/** Vertices one imported line or area keeps; longer ones are simplified to this. */
export const MAX_IMPORT_VERTICES = 2000;
/** Matches the engine's own label ceiling, leaving it nothing to cut mid-word. */
const MAX_LABEL_CHARS = 80;

/**
 * Which reader a file needs. The extension decides when it is one we know;
 * otherwise the content is sniffed, because tracks arrive as `download` and
 * `export (3).txt` as often as they arrive well named.
 * @param {string} fileName
 * @param {string} text
 * @returns {'gpx'|'kml'|'geojson'}
 */
export function detectPathFormat(fileName, text) {
  const extension = /\.([a-z0-9]+)$/i.exec(String(fileName || '').trim());
  const ext = extension ? extension[1].toLowerCase() : '';
  if (ext === 'kmz')
    throw new PathImportError(
      'kmz-unsupported',
      'KMZ is a zipped KML. Unzip it and import the .kml file inside.',
    );
  if (ext === 'gpx') return 'gpx';
  if (ext === 'kml') return 'kml';
  if (ext === 'geojson') return 'geojson';

  const head = String(text || '')
    .slice(0, 4096)
    .replace(/^\uFEFF/, '')
    .trimStart();
  if (head.startsWith('PK'))
    throw new PathImportError(
      'kmz-unsupported',
      'That looks like a zip archive (KMZ). Unzip it and import the .kml file inside.',
    );
  if (head[0] === '{') return 'geojson';
  if (/<(?:[a-z0-9]+:)?gpx[\s>]/i.test(head)) return 'gpx';
  if (/<(?:[a-z0-9]+:)?(?:kml|placemark|document)[\s>]/i.test(head))
    return 'kml';
  if (ext === 'json') return 'geojson';
  throw new PathImportError(
    'unknown-format',
    'That file is not GPX, KML or GeoJSON.',
  );
}

const READERS = Object.freeze({
  gpx: parseGpx,
  kml: parseKml,
  geojson: parseGeoJson,
});

/**
 * Read one file into the features the board can take.
 *
 * @param {{name?: string, text: string}} file
 * @param {{maxFeatures?: number, maxVertices?: number, maxChars?: number}} [limits]
 * @returns {{
 *   format: 'gpx'|'kml'|'geojson',
 *   fileName: string,
 *   features: Array<{kind: 'line'|'area'|'pin', name: string, points: Array<[number, number]>}>,
 *   skipped: {invalid: number, overLimit: number},
 *   simplified: number,
 * }}
 * @throws {PathImportError} when the file cannot be read at all, or holds nothing usable.
 */
export function readPathFile(
  { name = '', text } = {},
  {
    maxFeatures = MAX_IMPORT_FEATURES,
    maxVertices = MAX_IMPORT_VERTICES,
    maxChars = MAX_IMPORT_CHARS,
  } = {},
) {
  const source = typeof text === 'string' ? text : '';
  const fileName = String(name || '').trim();
  if (!source.trim()) throw new PathImportError('empty', 'That file is empty.');
  if (source.length > maxChars)
    throw new PathImportError(
      'too-large',
      `That file is larger than the ${Math.round(maxChars / (1024 * 1024))} MB import limit.`,
    );

  const format = detectPathFormat(fileName, source);
  const raw = READERS[format](source);
  const fallbackName = baseName(fileName);

  const features = [];
  const skipped = { invalid: 0, overLimit: 0 };
  let simplified = 0;
  for (const candidate of raw) {
    const feature = normalizeFeature(candidate, fallbackName);
    if (!feature) {
      skipped.invalid += 1;
      continue;
    }
    if (features.length >= maxFeatures) {
      skipped.overLimit += 1;
      continue;
    }
    if (feature.kind !== 'pin' && feature.points.length > maxVertices) {
      feature.points = simplifyPath(feature.points, maxVertices);
      simplified += 1;
    }
    features.push(feature);
  }

  if (!features.length)
    throw new PathImportError(
      'nothing-usable',
      raw.length
        ? 'That file has no track, area or point with usable coordinates.'
        : 'That file has no tracks, areas or points in it.',
    );
  return { format, fileName, features, skipped, simplified };
}

/**
 * One raw feature made safe, or null when it describes nothing: positions off
 * the globe are dropped, repeats of the previous position are collapsed, and a
 * line with no length or an area that encloses nothing is refused by the same
 * thresholds Draw applies to a hand-drawn shape.
 */
function normalizeFeature(candidate, fallbackName) {
  if (!candidate || !Array.isArray(candidate.points)) return null;
  const points = [];
  for (const point of candidate.points) {
    if (!isOnGlobe(point)) continue;
    const last = points[points.length - 1];
    if (last && last[0] === point[0] && last[1] === point[1]) continue;
    points.push([point[0], point[1]]);
  }
  const name = cleanName(candidate.name) || fallbackName;

  if (candidate.kind === 'pin')
    return points.length ? { kind: 'pin', name, points: [points[0]] } : null;

  const vertices = points.map(([lon, lat]) => ({ lon, lat }));
  if (candidate.kind === 'line') {
    if (points.length < 2 || pathLengthM(vertices) < MIN_PATH_LENGTH_M)
      return null;
    return { kind: 'line', name, points };
  }
  if (candidate.kind === 'area') {
    // Measured on the distinct corners: the closing repeat adds no area.
    const open = isClosed(points) ? vertices.slice(0, -1) : vertices;
    if (open.length < 3 || ringAreaM2(open) < MIN_AREA_M2) return null;
    return { kind: 'area', name, points: closeRing(points) };
  }
  return null;
}

function isOnGlobe(point) {
  return (
    Array.isArray(point) &&
    Number.isFinite(point[0]) &&
    Number.isFinite(point[1]) &&
    Math.abs(point[0]) <= 180 &&
    Math.abs(point[1]) <= 90
  );
}

function isClosed(points) {
  if (points.length < 2) return false;
  const first = points[0];
  const last = points[points.length - 1];
  return first[0] === last[0] && first[1] === last[1];
}

/** One line of plain text: control characters and runs of whitespace collapsed. */
function cleanName(name) {
  return String(name || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LABEL_CHARS);
}

/** `C:\tracks\Ridge walk.gpx` → `Ridge walk`. */
function baseName(fileName) {
  const leaf = String(fileName || '')
    .split(/[\\/]/)
    .pop();
  return cleanName(leaf.replace(/\.[a-z0-9]+$/i, ''));
}

/**
 * The annotation specs for a read file, in the shape
 * `annotationEngine.annotate()` takes — the same shape `finishSpec` in
 * drawMode.js produces for a hand-drawn mark.
 * @param {Array<{kind: string, name: string, points: Array<[number, number]>}>} features
 * @param {{color?: string}} [opts]
 * @returns {object[]}
 */
export function featuresToSpecs(features, { color = 'primary' } = {}) {
  const specs = [];
  for (const feature of Array.isArray(features) ? features : []) {
    const label = feature.name || null;
    if (feature.kind === 'line') {
      specs.push({
        type: 'route',
        manual: true,
        path: feature.points,
        label,
        color,
      });
    } else if (feature.kind === 'area') {
      specs.push({
        type: 'area',
        manual: true,
        ring: feature.points,
        label,
        color,
      });
    } else if (feature.kind === 'pin') {
      const [lon, lat] = feature.points[0];
      specs.push({
        type: 'pin',
        manual: true,
        latitude: lat,
        longitude: lon,
        label,
        color,
      });
    }
  }
  return specs;
}

/**
 * One line telling the person what an import did, including what it left out
 * and why: "3 lines, 2 pins from ridge.gpx · 1 simplified · 4 skipped (no
 * usable coordinates)".
 * @param {ReturnType<typeof readPathFile>} result
 * @returns {string}
 */
export function importSummary(result) {
  if (!result) return '';
  const counts = { line: 0, area: 0, pin: 0 };
  for (const feature of result.features) counts[feature.kind] += 1;
  const parts = [];
  if (counts.line) parts.push(plural(counts.line, 'line'));
  if (counts.area) parts.push(plural(counts.area, 'area'));
  if (counts.pin) parts.push(plural(counts.pin, 'pin'));
  let line = parts.join(', ');
  if (result.fileName) line += ` from ${result.fileName}`;
  if (result.simplified) line += ` · ${result.simplified} simplified`;
  if (result.skipped.invalid)
    line += ` · ${result.skipped.invalid} skipped (no usable coordinates)`;
  if (result.skipped.overLimit)
    line += ` · ${result.skipped.overLimit} skipped (over the ${MAX_IMPORT_FEATURES}-mark limit per file)`;
  return line;
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
