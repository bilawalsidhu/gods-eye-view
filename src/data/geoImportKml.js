// A sanitized KML document (src/data/geoFileImport.js: no network links,
// remote images, models, descriptions or times, tracks as their recorded
// lines) read into the import's plain records (src/data/geoImportRecords.js)
// the way Cesium's KmlDataSource read it, without Cesium: the same shared,
// inline and StyleMap styles and their precedence, the same defaults (a
// yellow map pin, white lines and fills), billboards of 32 px with KML's
// distance scale and hot spot, ground lines for clamped and tessellated
// paths, lines in the air for absolute and relative ones, and ground
// overlays as image rectangles. Labels are not drawn (the import never
// drew them); walls and extruded polygons are counted in `undrawn`.

import {
  emptyRecords,
  hasRingVertices,
  importFeatureName,
} from './geoImportRecords.js';

// KmlDataSource's billboard: 32 px, scaled by camera distance.
const BILLBOARD_SIZE = 32;
const BILLBOARD_SCALE_BY_DISTANCE = Object.freeze([
  2414016, 1.0, 1.6093e7, 0.1,
]);
// Its pin where no icon is given: Cesium.Color.YELLOW, drawn at 64 px.
const DEFAULT_PIN = Object.freeze({
  pin: Object.freeze([1, 1, 0, 1]),
  pinSize: 64,
});
const WHITE = Object.freeze([1, 1, 1, 1]);
const GEOMETRY = new Set([
  'Point',
  'LineString',
  'LinearRing',
  'Polygon',
  'MultiGeometry',
  'Model',
  'Track',
  'MultiTrack',
]);

/** Child elements of `el` with this local name (any namespace). */
const childrenNamed = (el, localName) => {
  const out = [];
  const kids = el?.childNodes || [];
  for (let i = 0; i < kids.length; i++)
    if (kids[i].nodeType === 1 && kids[i].localName === localName)
      out.push(kids[i]);
  return out;
};
const first = (el, localName) => childrenNamed(el, localName)[0];
/** A child's trimmed text, or undefined without the child. */
const textOf = (el, localName) => {
  const child = first(el, localName);
  return child ? child.textContent.trim() : undefined;
};
const numberOf = (el, localName) => {
  const value = Number.parseFloat(textOf(el, localName));
  return Number.isFinite(value) ? value : undefined;
};
const booleanOf = (el, localName) => {
  const value = textOf(el, localName);
  return value === undefined
    ? undefined
    : value === '1' || /^true$/i.test(value);
};

/**
 * A KML colour (aabbggrr) as rgba in 0..1, or undefined; `random`
 * (colorMode random) draws each non-zero channel at random up to its
 * value, as Cesium does, on every read.
 */
export function kmlColor(value, random = false) {
  const text = String(value ?? '')
    .trim()
    .replace(/^#/, '');
  if (!text) return undefined;
  const channel = (at) => Number.parseInt(text.substring(at, at + 2), 16) / 255;
  const [alpha, blue, green, red] = [0, 2, 4, 6].map(channel);
  const pick = (v) => (random && v > 0 ? Math.random() * v : v);
  return [pick(red), pick(green), pick(blue), alpha];
}
const colorOf = (el, localName) =>
  kmlColor(textOf(el, localName), textOf(el, 'colorMode') === 'random');

/** One coordinate tuple; Google Earth reads what is missing as 0. */
function tuple(text) {
  const [lon = 0, lat = 0, height = 0] = String(text ?? '')
    .split(',')
    .map((v) => Number.parseFloat(v))
    .map((v) => (Number.isFinite(v) ? v : 0));
  return [lon, lat, height];
}
const coordinates = (el) =>
  el ? (el.textContent.match(/\S+/g) ?? []).map(tuple) : [];

/** Where a geometry sits, from its altitude modes (Cesium's reading). */
function altitudeOf(geometry) {
  const modes = childrenNamed(geometry, 'altitudeMode');
  const isGx = (el) => /google\.com\/kml\/ext/.test(el.namespaceURI || '');
  const mode = modes.find((el) => !isGx(el))?.textContent.trim();
  const gx = modes.find(isGx)?.textContent.trim();
  if (mode === 'absolute') return 'absolute';
  if (mode === 'relativeToGround') return 'relative';
  if (!mode || mode === 'clampToGround')
    return gx === 'relativeToSeaFloor' && !mode ? 'relative' : 'ground';
  return gx === 'relativeToSeaFloor' ? 'relative' : 'ground';
}

// A style as KmlDataSource builds it on an entity: `icon` (its billboard),
// `line` (its polyline) and `poly` (its polygon); a property left undefined
// is filled by a merged style.
function applyStyle(styleEl, target) {
  for (const node of childrenNamed(styleEl, 'IconStyle')) {
    const iconEl = first(node, 'Icon');
    const href = textOf(iconEl, 'href');
    const icon = (target.icon ??= {});
    // Blank <Icon> tags mean no icon at all.
    icon.image = href ? { url: href } : iconEl ? false : undefined;
    icon.scale = numberOf(node, 'scale');
    icon.color = colorOf(node, 'color');
    const region = ['x', 'y', 'w', 'h'].map((key) => numberOf(iconEl, key));
    if (region.some((v) => v !== undefined))
      icon.subRegion = region.map((v) => v ?? 0);
    const heading = numberOf(node, 'heading');
    // Google Earth reads a heading of 0 as none.
    if (heading !== undefined && heading !== 0)
      icon.rotation = (-heading * Math.PI) / 180;
    const offset = hotSpotOffset(first(node, 'hotSpot'), icon.scale ?? 1);
    if (offset) icon.offsetPx = offset;
  }
  for (const node of childrenNamed(styleEl, 'LineStyle'))
    target.line = {
      width: numberOf(node, 'width'),
      color: colorOf(node, 'color'),
    };
  for (const node of childrenNamed(styleEl, 'PolyStyle')) {
    const poly = (target.poly ??= { outline: true, outlineColor: WHITE });
    poly.color = colorOf(node, 'color') ?? poly.color;
    poly.fill = booleanOf(node, 'fill') ?? poly.fill;
    poly.outline = booleanOf(node, 'outline') ?? poly.outline;
  }
}

/** A KML hot spot as Cesium's billboard pixel offset (+y down), or null. */
function hotSpotOffset(el, scale) {
  if (!el) return null;
  const read = (name) => {
    const value = Number.parseFloat(el.getAttribute(name));
    return Number.isFinite(value) ? value : undefined;
  };
  const x = read('x');
  const y = read('y');
  let dx;
  let dy;
  if (x !== undefined) {
    const unit = el.getAttribute('xunits');
    if (unit === 'pixels') dx = -x * scale;
    else if (unit === 'insetPixels') dx = (x - BILLBOARD_SIZE) * scale;
    else if (unit === 'fraction') dx = -x * BILLBOARD_SIZE * scale;
    dx = (dx ?? Number.NaN) + BILLBOARD_SIZE * 0.5 * scale;
  }
  if (y !== undefined) {
    const unit = el.getAttribute('yunits');
    if (unit === 'pixels') dy = y * scale;
    else if (unit === 'insetPixels') dy = (-y + BILLBOARD_SIZE) * scale;
    else if (unit === 'fraction') dy = y * BILLBOARD_SIZE * scale;
    dy = (dy ?? Number.NaN) - BILLBOARD_SIZE * 0.5 * scale;
  }
  if (dx === undefined && dy === undefined) return null;
  const finite = (v) => (Number.isFinite(v) ? v : 0);
  return [finite(dx), finite(dy)];
}

const cloneStyle = (style) => ({
  icon: style.icon && { ...style.icon },
  line: style.line && { ...style.line },
  poly: style.poly && { ...style.poly },
});

/** Entity.merge: what `target` leaves undefined comes from `source`. */
function mergeStyle(target, source) {
  if (!source) return target;
  for (const key of ['icon', 'line', 'poly']) {
    if (!source[key]) continue;
    if (!target[key]) target[key] = { ...source[key] };
    else
      for (const [name, value] of Object.entries(source[key]))
        target[key][name] ??= value;
  }
  return target;
}

/** The document's shared styles by '#id', as KmlDataSource collects them. */
function sharedStyles(doc) {
  const styles = new Map();
  const all = [...doc.getElementsByTagName('*')];
  for (const el of all) {
    if (el.localName !== 'Style') continue;
    const id = el.getAttribute('id');
    if (id === null || styles.has(`#${id}`)) continue;
    const style = {};
    applyStyle(el, style);
    styles.set(`#${id}`, style);
  }
  for (const el of all) {
    if (el.localName !== 'StyleMap') continue;
    const id = el.getAttribute('id');
    if (id === null) continue;
    for (const pair of childrenNamed(el, 'Pair')) {
      if (textOf(pair, 'key') !== 'normal' || styles.has(`#${id}`)) continue;
      const style = {};
      const url = textOf(pair, 'styleUrl');
      if (url !== undefined)
        mergeStyle(style, styles.get(url.startsWith('#') ? url : `#${url}`));
      else {
        const inline = first(pair, 'Style');
        if (inline) applyStyle(inline, style);
      }
      styles.set(`#${id}`, style);
    }
  }
  return styles;
}

/** A placemark's final style: its last inline style, then its styleUrl. */
function placemarkStyle(placemark, styles) {
  const lookup = (url) => styles.get(url) ?? styles.get(`#${url}`);
  const result = {};
  const inline = [...(placemark.childNodes || [])]
    .filter(
      (el) =>
        el.nodeType === 1 &&
        (el.localName === 'Style' || el.localName === 'StyleMap'),
    )
    .at(-1);
  if (inline?.localName === 'Style') applyStyle(inline, result);
  else if (inline)
    for (const pair of childrenNamed(inline, 'Pair')) {
      if (textOf(pair, 'key') !== 'normal') continue;
      const url = textOf(pair, 'styleUrl');
      if (url !== undefined) mergeStyle(result, lookup(url));
      else {
        const style = first(pair, 'Style');
        if (style) applyStyle(style, result);
      }
    }
  const external = textOf(placemark, 'styleUrl');
  if (external !== undefined) mergeStyle(result, lookup(external));
  return result;
}

/** The polyline Cesium draws for a style: its colour (white) and width (1). */
const lineLook = (style) => ({
  color: style.line?.color ?? WHITE,
  widthPx: style.line?.width ?? 1,
});

function readGeometry(geometry, style, name, records) {
  const kind = geometry.localName;
  if (kind === 'MultiGeometry') {
    for (const child of geometry.childNodes || [])
      if (child.nodeType === 1 && GEOMETRY.has(child.localName))
        readGeometry(child, style, name, records);
    return;
  }
  const altitude = altitudeOf(geometry);
  const extrude = booleanOf(geometry, 'extrude') === true;
  if (kind === 'Point') {
    const [position = [0, 0, 0]] = coordinates(first(geometry, 'coordinates'));
    const icon = style.icon ?? {};
    if (icon.image !== false)
      records.points.push({
        name,
        position,
        altitude,
        icon: {
          image: icon.image || DEFAULT_PIN,
          widthPx: BILLBOARD_SIZE,
          heightPx: BILLBOARD_SIZE,
          scale: icon.scale,
          color: icon.color,
          offsetPx: icon.offsetPx,
          subRegion: icon.subRegion,
          rotation: icon.rotation,
          scaleByDistance: BILLBOARD_SCALE_BY_DISTANCE,
        },
      });
    // A drop line from an extruded point down to the ellipsoid.
    if (extrude && altitude !== 'ground')
      records.lines.push({
        name,
        positions: [position, [position[0], position[1], 0]],
        ground: false,
        ...lineLook(style),
      });
    return;
  }
  if (kind === 'LineString' || kind === 'LinearRing') {
    const positions = coordinates(first(geometry, 'coordinates'));
    if (positions.length < 2) return;
    const tessellate = booleanOf(geometry, 'tessellate') === true;
    if (altitude !== 'ground' && extrude) {
      // A wall; its outline's top edge draws as the path.
      records.undrawn.wall = (records.undrawn.wall ?? 0) + 1;
      records.lines.push({
        name,
        positions,
        ground: false,
        ...lineLook(style),
      });
    } else if (altitude === 'ground' && tessellate)
      records.lines.push({ name, positions, ground: true, ...lineLook(style) });
    else
      records.lines.push({
        name,
        positions:
          altitude === 'ground'
            ? positions.map(([lon, lat]) => [lon, lat, 0])
            : positions,
        ground: false,
        ...lineLook(style),
      });
    return;
  }
  if (kind === 'Polygon') {
    const ringOf = (boundary) =>
      coordinates(first(first(boundary, 'LinearRing'), 'coordinates'));
    const outer = ringOf(first(geometry, 'outerBoundaryIs'));
    if (!outer.length) return;
    const holes = childrenNamed(geometry, 'innerBoundaryIs')
      .flatMap((boundary) =>
        childrenNamed(boundary, 'LinearRing').map((ring) =>
          coordinates(first(ring, 'coordinates')),
        ),
      )
      .filter(hasRingVertices);
    const poly = style.poly ?? { outline: true, outlineColor: WHITE };
    const raised = altitude !== 'ground';
    if (raised && extrude)
      records.undrawn.extruded = (records.undrawn.extruded ?? 0) + 1;
    records.polygons.push({
      name,
      rings: [outer, ...holes],
      raised,
      fill: poly.fill === false ? null : (poly.color ?? WHITE),
      outline:
        poly.outline === false
          ? null
          : {
              color: style.line
                ? (style.line.color ?? WHITE)
                : (poly.outlineColor ?? WHITE),
              widthPx: style.line?.width ?? 1,
            },
    });
  }
  // A Model or a Track left by the sanitizer has nothing to draw.
}

function readGroundOverlay(el, records) {
  const name = importFeatureName(textOf(el, 'name'));
  const color = colorOf(el, 'color') ?? WHITE;
  const quad = first(el, 'LatLonQuad');
  if (quad) {
    records.undrawn.latLonQuad = (records.undrawn.latLonQuad ?? 0) + 1;
    return;
  }
  const box = first(el, 'LatLonBox');
  if (!box) return;
  // Cesium's negativePiToPi and latitude clamp.
  const lon = (v = 0) =>
    v >= -180 && v <= 180 ? v : ((((v + 180) % 360) + 360) % 360) - 180;
  const lat = (v = 0) => Math.max(-90, Math.min(90, v));
  const rectangle = {
    west: lon(numberOf(box, 'west')),
    south: lat(numberOf(box, 'south')),
    east: lon(numberOf(box, 'east')),
    north: lat(numberOf(box, 'north')),
  };
  if (!(rectangle.north > rectangle.south)) return;
  const url = textOf(first(el, 'Icon'), 'href') || null;
  records.overlays.push({
    name,
    url,
    rectangle,
    color,
    drawOrder: numberOf(el, 'drawOrder') ?? 0,
    rotation: numberOf(box, 'rotation') ?? 0,
    altitude: numberOf(el, 'altitude') ?? 0,
    altitudeMode: altitudeOf(el),
  });
}

/**
 * Read a sanitized KML document into records, placemarks and ground
 * overlays in document order.
 * @param {Document} doc
 * @returns {import('./geoImportRecords.js').ImportedRecords}
 */
export function readKmlRecords(doc) {
  const records = emptyRecords();
  const styles = sharedStyles(doc);
  for (const el of doc.getElementsByTagName('*')) {
    if (el.localName === 'GroundOverlay') {
      readGroundOverlay(el, records);
      continue;
    }
    if (el.localName !== 'Placemark') continue;
    const name = importFeatureName(textOf(el, 'name'));
    const style = cloneStyle(placemarkStyle(el, styles));
    // Only a placemark's first geometry draws.
    const geometry = [...(el.childNodes || [])].find(
      (child) => child.nodeType === 1 && GEOMETRY.has(child.localName),
    );
    if (geometry) readGeometry(geometry, style, name, records);
  }
  return records;
}
