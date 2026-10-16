/** Session-local geodata loading with bounded geometry and local-only file references. */
import * as Cesium from 'cesium';
import { createImportImageBudget } from './geoImportImages.js';
import { createImportedPins } from './geoImportPins.js';

/** Largest file accepted, in bytes. */
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
/** Largest total a KMZ may inflate to — a zip bomb stops here. */
export const MAX_KMZ_INFLATED_BYTES = 120 * 1024 * 1024;
/** Most files on the globe at once. */
export const MAX_IMPORTED_FILES = 12;
/** Most entities one file may create before it is refused. */
export const MAX_IMPORT_ENTITIES = 20_000;
/** Most vertices (points of every line, ring and marker) in one file. */
export const MAX_IMPORT_POSITIONS = 250_000;
/** Most normalized style definitions and local image links in one KML/KMZ. */
export const MAX_KML_LINKS = 2_000;
/** Longest plain-text name kept from a file's features. */
export const MAX_IMPORT_NAME_LENGTH = 120;
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
// External content and metadata the session-local import does not use.
const KML_REMOVED_ELEMENTS = new Set([
  'NetworkLink',
  'NetworkLinkControl',
  'ScreenOverlay',
  'PhotoOverlay',
  'Model',
  'Tour',
  'description',
  'BalloonStyle',
  'Snippet',
  'ExtendedData',
  'TimeSpan',
  'TimeStamp',
  'LookAt',
  'Camera',
  'visibility',
  'viewRefreshMode',
  'viewFormat',
  'httpQuery',
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

/**
 * Count features and vertices in a parsed GeoJSON object without recursion
 * limits or array spreading, stopping as soon as a limit is passed.
 * @param {object} geojson
 * @param {{maxFeatures?: number, maxPositions?: number, maxEntities?: number}} [limits]
 * @returns {{features: number, positions: number, entities: number,
 *   over: ''|'features'|'positions'|'entities'}}
 */
export function countGeoJsonGeometry(
  geojson,
  {
    maxFeatures = MAX_IMPORT_ENTITIES,
    maxPositions = MAX_IMPORT_POSITIONS,
    maxEntities = MAX_IMPORT_ENTITIES,
  } = {},
) {
  let features = ['Feature', 'FeatureCollection'].includes(geojson?.type)
    ? 0
    : 1;
  let positions = 0;
  let entities = 0;
  const result = (over = '') => ({ features, positions, entities, over });
  const stack = [geojson];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (node.type === 'FeatureCollection') {
      const list = Array.isArray(node.features) ? node.features : [];
      for (let i = 0; i < list.length; i++) {
        if (list[i]?.type !== 'Feature')
          throw new GeoImportError(
            'Every GeoJSON feature must have type Feature.',
          );
        stack.push(list[i]);
      }
      continue;
    }
    if (node.type === 'Feature') {
      features += 1;
      if (features > maxFeatures) return result('features');
      if (node.geometry == null) {
        entities += 1;
        if (entities > maxEntities) return result('entities');
      }
      stack.push(node.geometry);
      continue;
    }
    if (node.type === 'GeometryCollection') {
      const list = node.geometries;
      if (!Array.isArray(list))
        throw new GeoImportError('That GeoJSON has invalid geometries.');
      for (let i = 0; i < list.length; i++) {
        if (!list[i] || ['Feature', 'FeatureCollection'].includes(list[i].type))
          throw new GeoImportError(
            'That GeoJSON contains an unsupported geometry.',
          );
        stack.push(list[i]);
      }
      continue;
    }
    const depth = {
      Point: 0,
      MultiPoint: 1,
      LineString: 1,
      MultiLineString: 2,
      Polygon: 2,
      MultiPolygon: 3,
    }[node.type];
    if (depth !== undefined) {
      // Multipart geometries create one Cesium entity per component, even
      // when the document wraps them in just one Feature.
      entities += node.type.startsWith('Multi')
        ? Array.isArray(node.coordinates)
          ? node.coordinates.length
          : 0
        : 1;
      if (entities > maxEntities) return result('entities');
      // Walk the coordinate arrays iteratively: a position is an array whose
      // first item is a number.
      const coords = [[node.coordinates, depth]];
      while (coords.length) {
        const [c, remaining] = coords.pop();
        if (!Array.isArray(c))
          throw new GeoImportError('That GeoJSON has invalid coordinates.');
        if (remaining === 0) {
          if (
            c.length < 2 ||
            c.length > 3 ||
            !c.every(Number.isFinite) ||
            Math.abs(c[0]) > 180 ||
            Math.abs(c[1]) > 90 ||
            (c.length === 3 && Math.abs(c[2]) > 1_000_000)
          )
            throw new GeoImportError('That GeoJSON has invalid coordinates.');
          positions += 1;
          if (positions > maxPositions) return result('positions');
        } else
          for (let i = 0; i < c.length; i++) coords.push([c[i], remaining - 1]);
      }
    } else
      throw new GeoImportError(
        'That GeoJSON contains an unsupported geometry.',
      );
  }
  return result();
}

/** The refusal for a file over a size limit, in the person's terms. */
function overLimitError({ over, features }) {
  if (over === 'entities')
    return new GeoImportError(
      `That file creates more than ${MAX_IMPORT_ENTITIES.toLocaleString()} map objects (the limit).`,
    );
  if (over === 'links')
    return new GeoImportError(
      `That file has more than ${MAX_KML_LINKS.toLocaleString()} style definitions and image links after cleanup (the limit).`,
    );
  if (over === 'features')
    return new GeoImportError(
      `That file has more than ${MAX_IMPORT_ENTITIES.toLocaleString()} features (the limit).`,
    );
  return new GeoImportError(
    `That file has more than ${MAX_IMPORT_POSITIONS.toLocaleString()} points (the limit)${features ? ` across ${features.toLocaleString()} features` : ''}.`,
  );
}

// The import uses WGS84 ground footprints and a short name only. Remove
// loader-sensitive metadata before Cesium allocates properties or entity IDs.
function prepareGeoJson(geojson) {
  const stack = [geojson];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    delete node.crs;
    delete node.id;
    if (node.type === 'FeatureCollection') {
      for (const feature of node.features) stack.push(feature);
    } else if (node.type === 'Feature') {
      const name = importFeatureName(node.properties?.name);
      node.properties = name ? { name } : {};
      stack.push(node.geometry);
    } else if (node.type === 'GeometryCollection') {
      for (const geometry of node.geometries) stack.push(geometry);
    } else {
      const coords = [node.coordinates];
      while (coords.length) {
        const value = coords.pop();
        if (typeof value[0] === 'number') value.length = 2;
        else for (const child of value) coords.push(child);
      }
    }
  }
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
 * A `resolveLocal` for `sanitizeKmlDocument`: the blob URL of an image packed
 * in the KMZ, or null. Each entry gets one blob and one URL however many
 * hrefs name it, so repeated icons don't copy (and decode) the image again.
 * @param {Map<string, Uint8Array>} entries
 * @param {string} main Path of the KMZ's KML document.
 * @param {(url: string) => void} onUrl Called once per new URL (to revoke later).
 * @param {(blob: Blob) => string} [createUrl]
 * @returns {(href: string) => string|null}
 */
export function kmzImageResolver(
  entries,
  main,
  onUrl,
  createUrl = (blob) => URL.createObjectURL(blob),
) {
  const urls = new Map();
  return (href) => {
    const path = resolveKmzPath(href, main, entries);
    const type = path && kmzImageType(path);
    if (!type) return null;
    let url = urls.get(path);
    if (!url) {
      url = createUrl(new Blob([entries.get(path)], { type }));
      urls.set(path, url);
      onUrl(url);
    }
    return url;
  };
}

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
  // One snapshot and pass, rather than rescanning the whole XML tree for
  // every discarded element type. Strip unused metadata before the loader
  // constructs descriptions, availability intervals and camera objects.
  for (const el of [...doc.getElementsByTagName('*')])
    if (
      KML_REMOVED_ELEMENTS.has(el.localName) ||
      el.localName in Object.prototype
    )
      drop(el);
    else if (!['Style', 'StyleMap'].includes(el.localName))
      el.removeAttribute('id');
  for (const href of elementsNamed(doc, 'href')) {
    const value = (href.textContent || '').trim();
    if (!value) continue;
    const local = resolveLocal(value);
    if (local) href.textContent = local;
    else if (/^data:image\/(png|jpeg|gif|webp|bmp);/i.test(value)) continue;
    else {
      const icon = href.parentNode;
      const overlay = icon?.parentNode;
      if (overlay?.localName === 'GroundOverlay') {
        drop(overlay);
        continue;
      }
      // An empty Icon explicitly hides the billboard in Cesium. Remove the
      // blocked icon definition so the loader supplies its local default pin.
      // Authored empty Icons (with no blocked href) still mean no marker.
      drop(
        icon?.localName === 'Icon' && icon.parentNode?.localName === 'IconStyle'
          ? icon
          : href,
      );
    }
  }
  for (const styleUrl of elementsNamed(doc, 'styleUrl')) {
    const value = (styleUrl.textContent || '').trim();
    if (!value.startsWith('#')) drop(styleUrl);
    else styleUrl.textContent = value;
  }
  for (const pair of elementsNamed(doc, 'Pair'))
    if (
      !childText(pair, 'key') ||
      (!childrenNamed(pair, 'styleUrl').length &&
        !childrenNamed(pair, 'Style').length)
    )
      drop(pair);
  // Draw recorded KML paths as their original static vertices. Letting the
  // loader build time-dynamic tracks would expand each into thousands of
  // interpolated points later and exceed the checked geometry budget.
  for (const track of elementsNamed(doc, 'Track')) {
    const line = doc.createElementNS(
      'http://www.opengis.net/kml/2.2',
      'LineString',
    );
    const coordinates = doc.createElementNS(
      'http://www.opengis.net/kml/2.2',
      'coordinates',
    );
    const recordedCoordinates = childrenNamed(track, 'coord').map((coord) =>
      coord.textContent.trim().split(/\s+/).join(','),
    );
    coordinates.textContent = recordedCoordinates.join(' ');
    line.appendChild(coordinates);
    for (const mode of childrenNamed(track, 'altitudeMode'))
      line.appendChild(mode.cloneNode(true));
    track.parentNode?.replaceChild(line, track);
  }
  for (const tracks of elementsNamed(doc, 'MultiTrack')) {
    const geometry = doc.createElementNS(
      'http://www.opengis.net/kml/2.2',
      'MultiGeometry',
    );
    for (const line of childrenNamed(tracks, 'LineString'))
      geometry.appendChild(line);
    tracks.parentNode?.replaceChild(geometry, tracks);
  }
  for (const line of [
    ...elementsNamed(doc, 'LineString'),
    ...elementsNamed(doc, 'LinearRing'),
  ]) {
    const mode = childText(line, 'altitudeMode');
    if (
      !mode ||
      mode === 'clampToGround' ||
      mode === 'clampToSeaFloor' ||
      !childrenNamed(line, 'tessellate').length
    ) {
      let tessellate = childrenNamed(line, 'tessellate')[0];
      if (!tessellate) {
        tessellate = doc.createElementNS(
          'http://www.opengis.net/kml/2.2',
          'tessellate',
        );
        line.appendChild(tessellate);
      }
      tessellate.textContent = '1';
    }
  }
  return { removed };
}

/** Child elements of `el` with this local name (any namespace). */
const childrenNamed = (el, localName) => {
  const out = [];
  const kids = el?.childNodes || [];
  for (let i = 0; i < kids.length; i++)
    if (kids[i].nodeType === 1 && kids[i].localName === localName)
      out.push(kids[i]);
  return out;
};
const childText = (el, localName) =>
  (childrenNamed(el, localName)[0]?.textContent || '').trim();

/**
 * Share identical styles before the loader builds their graphics. Inline
 * overrides stay inline StyleMaps, so an existing styleUrl still supplies
 * properties the override leaves unset. Named references are redirected.
 * Random-color styles remain unchanged; duplicate IDs
 * keep the loader's original precedence instead of being rewritten.
 * @param {Document} doc Sanitized KML.
 * @param {{serializeStyle?: Function, maxStyles?: number}} [options]
 * @returns {number} Number of original style blocks replaced.
 */
export function deduplicateKmlStyles(
  doc,
  { serializeStyle, maxStyles = MAX_KML_LINKS } = {},
) {
  const serializer = serializeStyle ? null : new XMLSerializer();
  const serialize =
    serializeStyle || ((el) => serializer.serializeToString(el));
  const groups = new Map();
  const usedIds = new Set();
  const duplicateIds = new Set();
  for (const el of doc.getElementsByTagName('*')) {
    const id = el.getAttribute('id');
    if (id !== null) {
      if (usedIds.has(id)) duplicateIds.add(id);
      usedIds.add(id);
    }
  }
  for (const style of elementsNamed(doc, 'Style')) {
    if (
      elementsNamed(style, 'colorMode').some(
        (el) => el.textContent.trim() === 'random',
      )
    )
      continue;
    const template = style.cloneNode(true);
    template.removeAttribute('id');
    const key = serialize(template);
    let group = groups.get(key);
    if (!group) {
      group = { template, nodes: [] };
      groups.set(key, group);
      if (groups.size > maxStyles) throw overLimitError({ over: 'links' });
    }
    group.nodes.push(style);
  }
  const redirects = new Map();
  let replaced = 0;
  let serial = 0;
  let container;
  for (const { template, nodes } of groups.values()) {
    if (
      nodes.length < 2 ||
      nodes.some((el) => duplicateIds.has(el.getAttribute('id')))
    )
      continue;
    const ns = template.namespaceURI || 'http://www.opengis.net/kml/2.2';
    if (!container) {
      const root = doc.documentElement;
      container =
        root.localName === 'Document'
          ? root
          : childrenNamed(root, 'Document')[0];
      if (!container) {
        container = doc.createElementNS(ns, 'Document');
        while (root.firstChild) container.appendChild(root.firstChild);
        root.appendChild(container);
      }
    }
    let id;
    do {
      id = `gev-import-style-${++serial}`;
    } while (usedIds.has(id));
    usedIds.add(id);
    template.setAttribute('id', id);
    container.appendChild(template);
    for (const style of nodes) {
      const originalId = style.getAttribute('id');
      if (originalId !== null) redirects.set(originalId, id);
      let reference;
      if (style.parentNode.localName === 'Pair') {
        reference = doc.createElementNS(ns, 'styleUrl');
        reference.textContent = `#${id}`;
      } else {
        reference = doc.createElementNS(ns, 'StyleMap');
        for (const state of ['normal', 'highlight']) {
          const pair = doc.createElementNS(ns, 'Pair');
          const key = doc.createElementNS(ns, 'key');
          key.textContent = state;
          const url = doc.createElementNS(ns, 'styleUrl');
          url.textContent = `#${id}`;
          pair.appendChild(key);
          pair.appendChild(url);
          reference.appendChild(pair);
        }
      }
      style.parentNode.replaceChild(reference, style);
      replaced += 1;
    }
  }
  for (const url of elementsNamed(doc, 'styleUrl')) {
    const value = url.textContent.trim();
    const id = value.startsWith('#') && redirects.get(value.slice(1));
    if (id) url.textContent = `#${id}`;
  }
  return replaced;
}

/**
 * Count placemarks and vertices in a parsed KML document before Cesium reads
 * it: every `<coordinates>` tuple and every `gx:coord`, plus normalized
 * style definitions and distinct image `<href>` values (`links`).
 * Inline StyleMaps are references, not additional shared style definitions.
 * @param {Document} doc
 * @returns {{features: number, entities: number, positions: number, links: number,
 *   over: ''|'features'|'entities'|'positions'|'links'}}
 */
export function countKmlGeometry(
  doc,
  {
    maxFeatures = MAX_IMPORT_ENTITIES,
    maxEntities = MAX_IMPORT_ENTITIES,
    maxPositions = MAX_IMPORT_POSITIONS,
    maxLinks = MAX_KML_LINKS,
  } = {},
) {
  let features = 0;
  let entities = 0;
  let positions = 0;
  let links = 0;
  const imageLinks = new Set();
  const result = (over) => ({ features, entities, positions, links, over });
  const geometryNames = new Set([
    'Point',
    'LineString',
    'LinearRing',
    'Polygon',
    'Track',
    'MultiTrack',
    'MultiGeometry',
    'Model',
  ]);
  for (const el of doc.getElementsByTagName('*')) {
    const name = el.localName;
    if (
      ['north', 'south', 'east', 'west', 'rotation', 'altitude'].includes(name)
    ) {
      const value = Number(el.textContent);
      const limit = ['north', 'south'].includes(name)
        ? 90
        : name === 'altitude'
          ? 1_000_000
          : 360;
      if (
        !el.textContent.trim() ||
        !Number.isFinite(value) ||
        Math.abs(value) > limit
      )
        throw new GeoImportError('That KML has invalid geometry bounds.');
    }
    // Cesium creates entities for folders, a parent for every placemark, and
    // a child for each geometry in a MultiGeometry, including nested containers.
    if (
      name === 'Placemark' ||
      name === 'Folder' ||
      name === 'GroundOverlay' ||
      (geometryNames.has(name) &&
        ['MultiGeometry', 'MultiTrack'].includes(el.parentNode?.localName))
    ) {
      entities += 1;
      if (entities > maxEntities) return result('entities');
    }
    if (
      name === 'Style' ||
      (name === 'StyleMap' && el.getAttribute('id') !== null)
    ) {
      links += 1;
      if (links > maxLinks) return result('links');
    } else if (name === 'href') {
      const href = el.textContent.trim();
      if (!imageLinks.has(href)) {
        imageLinks.add(href);
        links += 1;
        if (links > maxLinks) return result('links');
      }
    } else if (name === 'Placemark') {
      features += 1;
      if (features > maxFeatures) return result('features');
    } else if (name === 'coordinates') {
      const text = el.textContent || '';
      for (const match of text.matchAll(/\S+/g)) {
        checkKmlPosition(match[0].split(','));
        positions += 1;
        if (positions > maxPositions) return result('positions');
      }
    } else if (name === 'coord') {
      checkKmlPosition(el.textContent.trim().split(/\s+/));
      positions += 1;
      if (positions > maxPositions) return result('positions');
    }
  }
  return result('');
}

function checkKmlPosition(tuple) {
  const numbers = tuple.map(Number);
  if (
    tuple.length < 2 ||
    tuple.length > 3 ||
    tuple.some((v) => !v.trim()) ||
    !numbers.every(Number.isFinite) ||
    Math.abs(numbers[0]) > 180 ||
    Math.abs(numbers[1]) > 90 ||
    (numbers.length === 3 && Math.abs(numbers[2]) > 1_000_000)
  )
    throw new GeoImportError('That KML has invalid coordinates.');
}

/**
 * Read a parsed GPX document into GeoJSON: waypoints become points, each
 * route a line and each track one MultiLineString with a line per `<trkseg>`
 * (segment breaks are gaps in the recording and stay gaps). Only names are
 * kept, and no times, so a dated track draws without a clock. Throws
 * `GeoImportError` past the size limits.
 * @param {Document} doc
 * @returns {object} A FeatureCollection.
 */
export function gpxToGeoJson(
  doc,
  {
    maxFeatures = MAX_IMPORT_ENTITIES,
    maxPositions = MAX_IMPORT_POSITIONS,
  } = {},
) {
  const root = doc.documentElement;
  if (root?.localName !== 'gpx')
    throw new GeoImportError('That GPX file has no <gpx> document.');
  const features = [];
  let positions = 0;
  const point = (el) => {
    const rawLat = el.getAttribute('lat');
    const rawLon = el.getAttribute('lon');
    if (rawLat == null || rawLon == null || !rawLat.trim() || !rawLon.trim())
      return null;
    const lat = Number(rawLat);
    const lon = Number(rawLon);
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180
    )
      return null;
    positions += 1;
    if (positions > maxPositions)
      throw overLimitError({
        over: 'positions',
        features: features.length,
        positions,
      });
    return [lon, lat];
  };
  const add = (name, geometry) => {
    if (features.length >= maxFeatures)
      throw overLimitError({
        over: 'features',
        features: features.length + 1,
        positions,
      });
    features.push({
      type: 'Feature',
      properties: name ? { name } : {},
      geometry,
    });
  };
  for (const wpt of childrenNamed(root, 'wpt')) {
    const at = point(wpt);
    if (at) add(childText(wpt, 'name'), { type: 'Point', coordinates: at });
  }
  for (const rte of childrenNamed(root, 'rte')) {
    const line = [];
    for (const pt of childrenNamed(rte, 'rtept')) {
      const at = point(pt);
      if (at) line.push(at);
    }
    if (line.length >= 2)
      add(childText(rte, 'name'), { type: 'LineString', coordinates: line });
  }
  for (const trk of childrenNamed(root, 'trk')) {
    const lines = [];
    for (const seg of childrenNamed(trk, 'trkseg')) {
      const line = [];
      for (const pt of childrenNamed(seg, 'trkpt')) {
        const at = point(pt);
        if (at) line.push(at);
      }
      if (line.length >= 2) lines.push(line);
    }
    if (lines.length)
      add(childText(trk, 'name'), {
        type: 'MultiLineString',
        coordinates: lines,
      });
  }
  return { type: 'FeatureCollection', features };
}

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

/**
 * Make every entity of an imported data source inert: no description,
 * balloon, extended data or properties, no native label, and a name that is
 * short plain text. Generated pin canvases share a data URL so Cesium uploads
 * each image once, rather than allocating a texture entry for every entity.
 * Returns how many entities were touched.
 * @param {{entities: {values: object[]}}} dataSource
 * @returns {number}
 */
export function scrubImportedEntities(dataSource) {
  const collection = dataSource?.entities;
  const list = collection?.values || [];
  const images = new Map();
  collection?.suspendEvents?.();
  try {
    for (let i = 0; i < list.length; i++) {
      const entity = list[i];
      let name;
      try {
        name = importFeatureName(
          typeof entity.name === 'string' ? entity.name : undefined,
        );
      } catch {
        name = undefined;
      }
      entity.name = name;
      entity.description = undefined;
      entity.label = undefined;
      entity.properties = undefined;
      if (entity.kml && typeof entity.kml === 'object') entity.kml = undefined;
      if (
        entity.billboard?.heightReference?.getValue?.() ===
        Cesium.HeightReference.CLAMP_TO_GROUND
      )
        entity.billboard.disableDepthTestDistance = Number.POSITIVE_INFINITY;
      const property = entity.billboard?.image;
      if (property?.isConstant === false) continue;
      const image = property?.getValue?.();
      if (image?.tagName === 'CANVAS') {
        let url = images.get(image);
        if (!url) {
          url = image.toDataURL();
          images.set(image, url);
        }
        entity.billboard.image = url;
      }
    }
  } finally {
    collection?.resumeEvents?.();
  }
  return list.length;
}

/**
 * Take time out of an imported data source so adding it cannot move the app's
 * shared clock: the data source reports no clock (the viewer adopts the clock
 * of every added source that has one), every entity is available for all
 * time. KML tracks have already become their original static vertices in
 * `sanitizeKmlDocument`, so no sampled-position fallback is needed here.
 * @param {object} dataSource
 * @returns {object} The same data source.
 */
export function detachImportedTime(dataSource) {
  Object.defineProperty(dataSource, 'clock', {
    configurable: true,
    enumerable: false,
    get: () => undefined,
    set: () => {},
  });
  const list = dataSource?.entities?.values || [];
  for (let i = 0; i < list.length; i++) {
    const entity = list[i];
    entity.availability = undefined;
  }
  return dataSource;
}

function parseXml(text, what) {
  // Match the namespace repairs Cesium applies to ordinary exported KML.
  if (what !== 'GPX')
    text = String(text).replace(/<kml\b[^>]*>/i, (root) => {
      const seen = new Set();
      root = root.replace(
        /\s+xmlns:([\w.-]+)\s*=\s*(["'])[^"']*\2/g,
        (declaration, prefix) => {
          if (seen.has(prefix)) return '';
          seen.add(prefix);
          return declaration;
        },
      );
      if (!seen.has('xsi') && /[<\s]xsi:/.test(text))
        root = root.replace(
          />$/,
          ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
        );
      return root;
    });
  const doc = new DOMParser().parseFromString(
    String(text).replace(/^﻿/, ''),
    'application/xml',
  );
  if (doc.getElementsByTagName('parsererror').length)
    throw new GeoImportError(`That ${what} file is not valid XML.`);
  return doc;
}

function decodeXml(bytes) {
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? 'utf-16le'
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? 'utf-16be'
        : 'utf-8';
  return new TextDecoder(encoding).decode(bytes);
}

function checkLocalImages(doc, entries = new Map(), main = '') {
  const charge = createImportImageBudget();
  const checked = new Set();
  for (const href of elementsNamed(doc, 'href')) {
    const value = href.textContent.trim();
    if (checked.has(value)) continue;
    checked.add(value);
    const path = resolveKmzPath(value, main, entries);
    try {
      if (path && kmzImageType(path)) charge(path, entries.get(path));
      else if (/^data:image\/(png|jpeg|gif|webp|bmp);/i.test(value)) {
        const comma = value.indexOf(',');
        const header = value.slice(0, comma);
        const body = value.slice(comma + 1);
        const raw = /;base64$/i.test(header)
          ? atob(body)
          : decodeURIComponent(body);
        charge(
          value,
          Uint8Array.from(raw, (c) => c.charCodeAt(0)),
        );
      }
    } catch {
      throw new GeoImportError(
        'That file has an unreadable image or exceeds the 16-megapixel image limit.',
      );
    }
  }
}

// Cesium also processes KML in deferred tasks; an exception there does not
// reject its load promise. Keep a failed file from blocking the serial queue.
async function loadKml(doc, viewer, signal) {
  let removeError;
  try {
    return await boundedImport(
      Promise.race([
        Cesium.KmlDataSource.load(doc, {
          camera: viewer.scene.camera,
          canvas: viewer.scene.canvas,
          clampToGround: true,
        }),
        new Promise((_, reject) => {
          const failed = () => {
            reject(new GeoImportError('That KML could not be read.'));
          };
          globalThis.addEventListener?.('error', failed);
          removeError = () => globalThis.removeEventListener?.('error', failed);
        }),
      ]),
      signal,
    );
  } finally {
    removeError?.();
  }
}

// Resolve a static file's ground pins in batches before they are visualized.
// Per-billboard CLAMP_TO_GROUND subscriptions scale poorly on large imports.
const groundPins = new WeakMap();
async function settleGroundPins(dataSource, viewer, signal) {
  let pins = groundPins.get(dataSource);
  if (!pins) {
    pins = [];
    for (const entity of dataSource.entities.values) {
      const reference = entity.billboard?.heightReference?.getValue?.();
      if (
        reference === Cesium.HeightReference.CLAMP_TO_GROUND ||
        reference === Cesium.HeightReference.RELATIVE_TO_GROUND
      ) {
        const position = entity.position?.getValue?.(Cesium.JulianDate.now());
        if (!position) continue;
        const cartographic = Cesium.Cartographic.fromCartesian(position);
        if (!cartographic)
          throw new GeoImportError('That file has invalid point coordinates.');
        pins.push({
          entity,
          original: position,
          cartographic,
          offset:
            reference === Cesium.HeightReference.RELATIVE_TO_GROUND
              ? cartographic.height
              : 0,
        });
        entity.billboard.heightReference = Cesium.HeightReference.NONE;
        entity.billboard.disableDepthTestDistance = Number.POSITIVE_INFINITY;
      }
    }
    groundPins.set(dataSource, pins);
  }
  for (let at = 0; at < pins.length; at += 256) {
    signal?.throwIfAborted();
    const batch = pins.slice(at, at + 256);
    const positions = batch.map(
      ({ cartographic: c }) =>
        new Cesium.Cartographic(c.longitude, c.latitude, 0),
    );
    const mesh =
      viewer.scene?.globe?.show === false &&
      viewer.scene?.clampToHeightSupported;
    // A coarse rendered ellipsoid mesh can report a height kilometres below
    // zero. Its provider's exact height is zero even while a 3D map hides it;
    // a buried starting point can make the downward mesh ray miss the surface.
    const ellipsoid =
      viewer.terrainProvider instanceof Cesium.EllipsoidTerrainProvider;
    for (let i = 0; i < positions.length; i++) {
      const sampled = ellipsoid
        ? 0
        : viewer.scene?.globe?.getHeight?.(positions[i]);
      positions[i].height = mesh
        ? (batch[i].groundHeight ??
          Math.max(0, Number.isFinite(sampled) ? sampled : 0))
        : Number.isFinite(sampled)
          ? sampled
          : batch[i].groundHeight || 0;
    }
    const points = positions.map((c) =>
      Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, c.height),
    );
    const height = viewer.camera?.positionCartographic?.height;
    if (mesh && Number.isFinite(height) && height < 250_000) {
      const rectangle = viewer.camera.computeViewRectangle?.();
      const indices = [];
      for (let i = 0; i < positions.length; i++)
        if (rectangle && Cesium.Rectangle.contains(rectangle, positions[i]))
          indices.push(i);
      if (indices.length) {
        const resolved = await boundedImport(
          viewer.scene.clampToHeightMostDetailed(
            indices.map((i) => {
              const c = positions[i];
              return Cesium.Cartesian3.fromRadians(
                c.longitude,
                c.latitude,
                Math.max(0, c.height),
              );
            }),
          ),
          signal,
        );
        for (let i = 0; i < indices.length; i++)
          if (resolved[i]) points[indices[i]] = resolved[i];
      }
    }
    signal?.throwIfAborted();
    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      const c = points[i] && Cesium.Cartographic.fromCartesian(points[i]);
      if (!c)
        throw new GeoImportError(
          'Ground heights are not available for that file. Try again when the map has loaded.',
        );
      item.groundHeight = c.height;
      c.height += item.offset;
      item.entity.position =
        Math.abs(c.height - item.cartographic.height) < 1e-6
          ? item.original
          : Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, c.height);
    }
    if (at + batch.length < pins.length)
      await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function boundedImport(promise, signal) {
  let timer, abort;
  try {
    signal?.throwIfAborted();
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        abort = () => reject(signal.reason);
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(
          () => reject(new GeoImportError('That file took too long to read.')),
          60_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

/**
 * Load a ground footprint, retaining explicit KML altitude modes. Call mount after
 * adding the source; revoke owns pin and blob cleanup.
 * @param {File|Blob & {name?: string}} file
 * @param {{viewer: Cesium.Viewer, color?: string}} options `color` is a CSS color.
 * @returns {Promise<{dataSource: Cesium.DataSource, name: string,
 *   format: string, entityCount: number, removed: number, mount: Function, revoke: Function}>}
 */
export async function loadGeoFile(
  file,
  { viewer, color = '#39d0ff', signal } = {},
) {
  signal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
    : AbortSignal.timeout(60_000);
  signal?.throwIfAborted();
  if (!file || !Number.isFinite(file.size))
    throw new GeoImportError('Nothing to import.');
  if (file.size > MAX_IMPORT_BYTES)
    throw new GeoImportError(
      `That file is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MiB.`,
    );
  let bytes = new Uint8Array(await boundedImport(file.arrayBuffer(), signal));
  const format = detectGeoFileFormat(file.name, bytes.subarray(0, 1024));
  if (!format)
    throw new GeoImportError(
      'Only GeoJSON, KML, KMZ and GPX files can be imported.',
    );
  const stroke = Cesium.Color.fromCssColorString(color);
  const urls = [];
  let pins;
  const revoke = () => {
    pins?.destroy();
    urls.splice(0).forEach((url) => URL.revokeObjectURL(url));
  };
  const name = importDisplayName(file.name);
  let dataSource;
  let removed = 0;
  try {
    if (format === 'geojson' || format === 'gpx') {
      let geojson;
      if (format === 'gpx') {
        geojson = gpxToGeoJson(parseXml(decodeXml(bytes), 'GPX'));
      } else {
        geojson = parseGeoJsonText(new TextDecoder().decode(bytes));
      }
      const size = countGeoJsonGeometry(geojson);
      if (size.over) throw overLimitError(size);
      if (!size.positions)
        throw new GeoImportError('That file has nothing to draw.');
      prepareGeoJson(geojson);
      bytes = null;
      dataSource = await boundedImport(
        Cesium.GeoJsonDataSource.load(geojson, {
          clampToGround: true,
          stroke,
          fill: stroke.withAlpha(0.25),
          strokeWidth: 3,
          markerColor: stroke,
          // No HTML description table is built from the file's properties.
          describe: () => undefined,
        }),
        signal,
      );
    } else {
      let text;
      let entries;
      let main;
      let resolveLocal = () => null;
      if (format === 'kmz') {
        entries = await readZipEntries(bytes);
        main = kmzMainDocument(entries);
        if (!main) throw new GeoImportError('That KMZ holds no KML document.');
        text = decodeXml(entries.get(main));
        resolveLocal = kmzImageResolver(entries, main, (url) => urls.push(url));
      } else {
        text = decodeXml(bytes);
      }
      const doc = parseXml(text, format.toUpperCase());
      text = null;
      bytes = null;
      // Bound geometry before transformations, then count the styles and
      // image links that survive sanitizing and sharing repeated styles.
      const size = countKmlGeometry(doc, { maxLinks: Infinity });
      if (size.over) throw overLimitError(size);
      checkLocalImages(doc, entries, main);
      removed = sanitizeKmlDocument(doc, resolveLocal).removed;
      entries?.clear();
      deduplicateKmlStyles(doc);
      const normalizedSize = countKmlGeometry(doc);
      if (normalizedSize.over) throw overLimitError(normalizedSize);
      dataSource = await loadKml(doc, viewer, signal);
    }
  } catch (error) {
    revoke();
    if (error instanceof GeoImportError) throw error;
    throw new GeoImportError(
      `That ${format.toUpperCase()} file could not be read.`,
    );
  }
  const entityCount = dataSource.entities.values.length;
  if (entityCount > MAX_IMPORT_ENTITIES) {
    revoke();
    throw new GeoImportError(
      `That file has ${entityCount.toLocaleString()} map objects; the limit is ${MAX_IMPORT_ENTITIES.toLocaleString()}.`,
    );
  }
  const now = Cesium.JulianDate.now();
  const drawable = dataSource.entities.values.some(
    (e) =>
      e.billboard?.image?.getValue(now) ||
      e.point ||
      e.rectangle ||
      e.polyline?.positions?.getValue(now)?.length >= 2 ||
      e.wall?.positions?.getValue(now)?.length >= 2 ||
      e.polygon?.hierarchy?.getValue(now)?.positions?.length >= 3,
  );
  if (!drawable) {
    revoke();
    throw new GeoImportError('That file has nothing to draw.');
  }
  scrubImportedEntities(dataSource);
  try {
    await settleGroundPins(dataSource, viewer, signal);
  } catch (error) {
    revoke();
    throw error instanceof GeoImportError
      ? error
      : new GeoImportError(
          'Ground heights could not be read. Try that file again.',
        );
  }
  // Keep the clock invariant explicit even though unused KML dates have
  // already been stripped and all supported geometries are static.
  detachImportedTime(dataSource);
  try {
    pins = createImportedPins(dataSource, viewer);
  } catch {
    revoke();
    throw new GeoImportError('That file has invalid point graphics.');
  }
  // The display name travels beside the data source (the file name, not
  // anything the document says about itself).
  return {
    dataSource,
    name,
    format,
    entityCount,
    removed,
    revoke,
    mount: () => pins.mount(),
    refreshGround: (refreshSignal) =>
      settleGroundPins(
        dataSource,
        viewer,
        refreshSignal
          ? AbortSignal.any([refreshSignal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(15_000),
      ).then(() => pins.sync()),
  };
}
