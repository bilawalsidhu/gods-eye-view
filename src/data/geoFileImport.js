/**
 * Your own geodata on the globe: GeoJSON, KML, KMZ and GPX files read in the
 * browser and handed to Cesium's own data sources.
 *
 * Nothing here talks to the network. The file never leaves the page, and a
 * KML/KMZ file cannot make the page fetch anything either: network links,
 * remote icons, remote styles, models and photo/screen overlays are removed
 * before Cesium sees the document (`sanitizeKmlDocument`). Images packed
 * inside a KMZ are served to Cesium from blob URLs the caller revokes.
 *
 * The bounded pieces — format detection, the KMZ (zip) reader, the size and
 * count limits — are plain functions so they run under `node --test`; the
 * Cesium loaders need a browser DOM and are exercised by
 * `scripts/qa-geo-import.mjs`.
 */
import * as Cesium from 'cesium';

/** Largest file accepted, in bytes. */
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
/** Largest total a KMZ may inflate to — a zip bomb stops here. */
export const MAX_KMZ_INFLATED_BYTES = 120 * 1024 * 1024;
/** Most files on the globe at once. */
export const MAX_IMPORTED_FILES = 12;
/** Most entities one file may create before it is refused. */
export const MAX_IMPORT_ENTITIES = 20_000;
/** What the file picker offers. */
export const GEO_FILE_ACCEPT = '.geojson,.json,.kml,.kmz,.gpx';

const GEOJSON_TYPES = new Set([
  'FeatureCollection',
  'Feature',
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
  'GeometryCollection',
]);
const KMZ_IMAGE_TYPES = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
});
// KML elements that fetch, embed or execute something outside the file.
const KML_REMOVED_ELEMENTS = Object.freeze([
  'NetworkLink',
  'NetworkLinkControl',
  'ScreenOverlay',
  'PhotoOverlay',
  'Model',
  'Tour',
]);

/** An error whose message is meant for the person who chose the file. */
export class GeoImportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GeoImportError';
  }
}

/**
 * The format of a file, from its name first and its first bytes second.
 * @param {string} name File name.
 * @param {Uint8Array} [head] The first bytes of the file.
 * @returns {'geojson'|'kml'|'kmz'|'gpx'|null}
 */
export function detectGeoFileFormat(name, head) {
  const ext = /\.([a-z0-9]+)$/i.exec(String(name || ''))?.[1]?.toLowerCase();
  if (ext === 'geojson') return 'geojson';
  if (ext === 'kml' || ext === 'kmz' || ext === 'gpx') return ext;
  if (!head?.length) return ext === 'json' ? 'geojson' : null;
  if (
    head[0] === 0x50 &&
    head[1] === 0x4b &&
    head[2] === 0x03 &&
    head[3] === 0x04
  )
    return 'kmz';
  const text = new TextDecoder()
    .decode(head.subarray(0, 1024))
    .replace(/^﻿/, '')
    .trimStart();
  if (text.startsWith('{')) return 'geojson';
  if (text.startsWith('<')) {
    if (/<kml[\s>]/i.test(text)) return 'kml';
    if (/<gpx[\s>]/i.test(text)) return 'gpx';
  }
  return ext === 'json' ? 'geojson' : null;
}

/**
 * A short, printable name for the list: the file name without control
 * characters, cut to 60 characters.
 * @param {string} name
 * @returns {string}
 */
export function importDisplayName(name) {
  const clean = String(name || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  if (!clean) return 'Imported file';
  return clean.length > 60 ? `${clean.slice(0, 57)}…` : clean;
}

/**
 * Parse and check GeoJSON text. Throws `GeoImportError` for anything that is
 * not a GeoJSON object.
 * @param {string} text
 * @returns {object}
 */
export function parseGeoJsonText(text) {
  let value;
  try {
    value = JSON.parse(String(text).replace(/^﻿/, ''));
  } catch {
    throw new GeoImportError('That file is not valid JSON.');
  }
  if (!value || typeof value !== 'object' || !GEOJSON_TYPES.has(value.type))
    throw new GeoImportError('That JSON file is not GeoJSON.');
  if (value.type === 'FeatureCollection' && !Array.isArray(value.features))
    throw new GeoImportError('That FeatureCollection has no features list.');
  return value;
}

/** Inflate raw-deflate bytes with the platform's stream, stopping at `maxBytes`. */
async function inflateRaw(bytes, maxBytes) {
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes)
        throw new GeoImportError(
          'That KMZ unpacks to more than the import limit.',
        );
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof GeoImportError) throw error;
    throw new GeoImportError('That KMZ is damaged and could not be unpacked.');
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/**
 * Read the entries of a zip archive (stored or deflated; no encryption, no
 * ZIP64). Directory entries are skipped.
 * @param {Uint8Array} bytes The whole archive.
 * @param {{maxInflatedBytes?: number}} [options]
 * @returns {Promise<Map<string, Uint8Array>>} Entry path → contents.
 */
export async function readZipEntries(
  bytes,
  { maxInflatedBytes = MAX_KMZ_INFLATED_BYTES } = {},
) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fail = (message = 'That KMZ is not a readable zip archive.') => {
    throw new GeoImportError(message);
  };
  // End of central directory: 22 bytes plus a comment of up to 64 KiB.
  let eocd = -1;
  for (
    let i = bytes.length - 22;
    i >= Math.max(0, bytes.length - 22 - 0xffff);
    i--
  ) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) fail();
  const count = view.getUint16(eocd + 10, true);
  const dirSize = view.getUint32(eocd + 12, true);
  let at = view.getUint32(eocd + 16, true);
  if (count === 0xffff || at === 0xffffffff || at + dirSize > eocd)
    fail('That KMZ uses a zip format this import does not read.');
  const entries = new Map();
  const names = new TextDecoder();
  let inflated = 0;
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50)
      fail();
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = names.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    if (flags & 0x1) fail('That KMZ is encrypted.');
    if (compressed === 0xffffffff || size === 0xffffffff)
      fail('That KMZ uses a zip format this import does not read.');
    if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50)
      fail();
    const start =
      local +
      30 +
      view.getUint16(local + 26, true) +
      view.getUint16(local + 28, true);
    if (start + compressed > bytes.length) fail();
    const data = bytes.subarray(start, start + compressed);
    let contents;
    if (method === 0) contents = data;
    else if (method === 8)
      contents = await inflateRaw(data, maxInflatedBytes - inflated);
    else fail('That KMZ uses a compression method this import does not read.');
    inflated += contents.length;
    if (inflated > maxInflatedBytes)
      fail('That KMZ unpacks to more than the import limit.');
    entries.set(name, contents);
  }
  return entries;
}

/**
 * The KML document inside a KMZ: `doc.kml` when present, else the first
 * `.kml` entry nearest the archive root.
 * @param {Map<string, Uint8Array>} entries
 * @returns {string|null} Entry path.
 */
export function kmzMainDocument(entries) {
  if (entries.has('doc.kml')) return 'doc.kml';
  const kml = [...entries.keys()]
    .filter((name) => /\.kml$/i.test(name))
    .sort(
      (a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b),
    );
  return kml[0] ?? null;
}

/**
 * Resolve a KMZ-relative href to an entry path, or null.
 * @param {string} href As written in the KML.
 * @param {string} base The KML entry's path.
 * @param {Map<string, Uint8Array>} entries
 * @returns {string|null}
 */
export function resolveKmzPath(href, base, entries) {
  const raw = String(href || '').trim();
  if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//'))
    return null;
  let decoded;
  try {
    decoded = decodeURIComponent(raw.split(/[?#]/)[0]);
  } catch {
    return null;
  }
  const parts = base.split('/').slice(0, -1);
  for (const part of decoded.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  const path = parts.join('/');
  return entries.has(path) ? path : null;
}

/** MIME type for a KMZ image entry, or null when it is not an image we serve. */
export function kmzImageType(path) {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return KMZ_IMAGE_TYPES[ext] ?? null;
}

const elementsNamed = (doc, localName) =>
  [...doc.getElementsByTagName('*')].filter((el) => el.localName === localName);

/**
 * Strip everything from a parsed KML document that would make the page reach
 * outside the file. `resolveLocal(href)` returns a URL for an image packed in
 * the same KMZ (or null); every other href is removed, so icons fall back to
 * Cesium's default pin and a ground overlay without a local image is dropped.
 * @param {Document} doc
 * @param {(href: string) => string|null} [resolveLocal]
 * @returns {{removed: number}} How many elements were taken out.
 */
export function sanitizeKmlDocument(doc, resolveLocal = () => null) {
  let removed = 0;
  const drop = (el) => {
    if (el.parentNode) {
      el.parentNode.removeChild(el);
      removed += 1;
    }
  };
  for (const name of KML_REMOVED_ELEMENTS)
    elementsNamed(doc, name).forEach(drop);
  for (const href of elementsNamed(doc, 'href')) {
    const value = (href.textContent || '').trim();
    const local = resolveLocal(value);
    if (local) href.textContent = local;
    else if (/^data:image\/(png|jpeg|gif|webp|bmp);/i.test(value)) continue;
    else drop(href);
  }
  for (const overlay of elementsNamed(doc, 'GroundOverlay')) {
    if (!elementsNamed(overlay, 'href').length) drop(overlay);
  }
  for (const styleUrl of elementsNamed(doc, 'styleUrl')) {
    if (!(styleUrl.textContent || '').trim().startsWith('#')) drop(styleUrl);
  }
  // Placemark balloons are HTML; the app shows no info box, and keeping their
  // <img>/<iframe> sources out means no future surface can load them either.
  for (const name of ['description', 'BalloonStyle', 'Snippet'])
    elementsNamed(doc, name).forEach(drop);
  return { removed };
}

function parseXml(text, what) {
  const doc = new DOMParser().parseFromString(
    String(text).replace(/^﻿/, ''),
    'application/xml',
  );
  if (doc.getElementsByTagName('parsererror').length)
    throw new GeoImportError(`That ${what} file is not valid XML.`);
  return doc;
}

/**
 * Load one file into a Cesium data source, clamped to the ground.
 * @param {File|Blob & {name?: string}} file
 * @param {{viewer: Cesium.Viewer, color?: string}} options `color` is a CSS color.
 * @returns {Promise<{dataSource: Cesium.DataSource, name: string,
 *   format: string, entityCount: number, removed: number, revoke: Function}>}
 */
export async function loadGeoFile(file, { viewer, color = '#39d0ff' }) {
  if (!file || !Number.isFinite(file.size))
    throw new GeoImportError('Nothing to import.');
  if (file.size > MAX_IMPORT_BYTES)
    throw new GeoImportError(
      `That file is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB.`,
    );
  const bytes = new Uint8Array(await file.arrayBuffer());
  const format = detectGeoFileFormat(file.name, bytes.subarray(0, 1024));
  if (!format)
    throw new GeoImportError(
      'Only GeoJSON, KML, KMZ and GPX files can be imported.',
    );
  const stroke = Cesium.Color.fromCssColorString(color);
  const urls = [];
  const revoke = () =>
    urls.splice(0).forEach((url) => URL.revokeObjectURL(url));
  const name = importDisplayName(file.name);
  let dataSource;
  let removed = 0;
  try {
    if (format === 'geojson') {
      dataSource = await Cesium.GeoJsonDataSource.load(
        parseGeoJsonText(new TextDecoder().decode(bytes)),
        {
          clampToGround: true,
          stroke,
          fill: stroke.withAlpha(0.25),
          strokeWidth: 3,
          markerColor: stroke,
        },
      );
    } else if (format === 'gpx') {
      dataSource = await Cesium.GpxDataSource.load(
        parseXml(new TextDecoder().decode(bytes), 'GPX'),
        { clampToGround: true, trackColor: stroke, routeColor: stroke },
      );
    } else {
      let text;
      let resolveLocal = () => null;
      if (format === 'kmz') {
        const entries = await readZipEntries(bytes);
        const main = kmzMainDocument(entries);
        if (!main) throw new GeoImportError('That KMZ holds no KML document.');
        text = new TextDecoder().decode(entries.get(main));
        resolveLocal = (href) => {
          const path = resolveKmzPath(href, main, entries);
          const type = path && kmzImageType(path);
          if (!type) return null;
          const url = URL.createObjectURL(
            new Blob([entries.get(path)], { type }),
          );
          urls.push(url);
          return url;
        };
      } else {
        text = new TextDecoder().decode(bytes);
      }
      const doc = parseXml(text, format.toUpperCase());
      removed = sanitizeKmlDocument(doc, resolveLocal).removed;
      dataSource = await Cesium.KmlDataSource.load(doc, {
        camera: viewer.scene.camera,
        canvas: viewer.scene.canvas,
        clampToGround: true,
      });
    }
  } catch (error) {
    revoke();
    if (error instanceof GeoImportError) throw error;
    throw new GeoImportError(
      `That ${format.toUpperCase()} file could not be read${error?.message ? `: ${error.message}` : '.'}`,
    );
  }
  const entityCount = dataSource.entities.values.length;
  if (entityCount > MAX_IMPORT_ENTITIES) {
    revoke();
    throw new GeoImportError(
      `That file has ${entityCount.toLocaleString()} features; the limit is ${MAX_IMPORT_ENTITIES.toLocaleString()}.`,
    );
  }
  if (entityCount === 0) {
    revoke();
    throw new GeoImportError('That file has nothing to draw.');
  }
  // GpxDataSource's `name` is read-only, so the display name travels beside it.
  return { dataSource, name, format, entityCount, removed, revoke };
}
