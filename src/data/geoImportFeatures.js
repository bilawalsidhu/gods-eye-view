/**
 * What an imported file draws, read from its parsed KML document or its
 * prepared GeoJSON as the default renderer's KML and GeoJSON loaders read
 * them: placemark pins with their icons, colours and anchors, paths,
 * polygons, walls and ground overlays, each with its altitude mode. Plain
 * data in degrees and metres, drawn by `geoImportPins.js`.
 *
 * `entityCount` counts what those loaders made of the file (folders,
 * placemarks, each part of a multi-geometry), the number the import limit
 * is checked against. `drawable` says whether any of it can be drawn.
 */
import { plainPin } from './geojsonPins.js';
import { importFeatureName } from './geoImportShared.js';
import { cssColor } from '../render/color.js';

/** KML icons are drawn this many pixels square, times their scale. */
const KML_ICON_SIZE = 32;
/** KML icons shrink with distance: full size near, a tenth far. */
const KML_ICON_SCALE_BY_DISTANCE = Object.freeze({
  near: 2414016,
  nearValue: 1,
  far: 1.6093e7,
  farValue: 0.1,
});
const WHITE = Object.freeze([1, 1, 1, 1]);
const BLACK = Object.freeze([0, 0, 0, 1]);
/** A placemark without an icon of its own: a yellow pin. */
const DEFAULT_KML_PIN = plainPin([1, 1, 0, 1], 64);
/** GeoJSON markers are pins this many pixels square, standing on the point. */
const GEOJSON_PIN_SIZE = 48;

const GX = 'http://www.google.com/kml/ext/2.2';
/** The namespaces KML elements come in: none, or a KML version's. */
const KML_NAMESPACES = new Set([
  null,
  undefined,
  '',
  'http://www.opengis.net/kml/2.2',
  'http://earth.google.com/kml/2.2',
  'http://earth.google.com/kml/2.1',
  'http://earth.google.com/kml/2.0',
]);
const isGx = (el) => el.namespaceURI === GX;
const isKml = (el) => KML_NAMESPACES.has(el.namespaceURI);

/** Element children of `el` with this local name, KML (not gx) unless `gx`. */
function children(el, name, gx = false) {
  const out = [];
  const kids = el?.childNodes;
  if (!kids) return out;
  for (let i = 0; i < kids.length; i++) {
    const kid = kids[i];
    if (
      kid.nodeType === 1 &&
      kid.localName === name &&
      (gx ? isGx(kid) : isKml(kid))
    )
      out.push(kid);
  }
  return out;
}
const child = (el, name, gx) => children(el, name, gx)[0];
const text = (el, name, gx) => child(el, name, gx)?.textContent.trim();
function number(el, name, gx) {
  const value = Number.parseFloat(child(el, name, gx)?.textContent);
  return Number.isNaN(value) ? undefined : value;
}
function flag(el, name) {
  const value = text(el, name);
  return value === undefined
    ? undefined
    : value === '1' || /^true$/i.test(value);
}
function attribute(el, name) {
  const value = el?.getAttribute(name);
  if (value === null || value === undefined) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * A KML `aabbggrr` colour as `[r, g, b, a]`; with `colorMode` random, each
 * channel drawn at random up to its own value.
 */
function kmlColor(el, name = 'color') {
  let value = text(el, name);
  if (!value) return undefined;
  if (value[0] === '#') value = value.slice(1);
  const channel = (at) => Number.parseInt(value.slice(at, at + 2), 16) / 255;
  const alpha = channel(0);
  const rgb = [channel(6), channel(4), channel(2)];
  if (text(el, 'colorMode') === 'random')
    for (let i = 0; i < 3; i++)
      rgb[i] = rgb[i] > 0 ? Math.random() * rgb[i] : 0;
  return [...rgb, alpha];
}

/** One `lon,lat[,height]` tuple; missing or unreadable numbers are 0. */
function readCoordinate(value) {
  const digits = value?.match(/[^\s,\n]+/g);
  const at = (i) => {
    const n = Number.parseFloat(digits?.[i]);
    return Number.isNaN(n) ? 0 : n;
  };
  return [at(0), at(1), at(2)];
}
function readCoordinates(el) {
  const tuples = el?.textContent.match(/[^\s\n]+/g);
  return tuples ? tuples.map(readCoordinate) : undefined;
}

/** Copy each graphic's unset properties from `from`, as styles merge. */
function merge(into, from) {
  for (const kind of ['billboard', 'polyline', 'polygon']) {
    if (!from?.[kind]) continue;
    if (!into[kind]) into[kind] = { ...from[kind] };
    else
      for (const key of Object.keys(from[kind]))
        if (into[kind][key] === undefined) into[kind][key] = from[kind][key];
  }
  return into;
}

const defaultBillboard = () => ({});

/** The icon, line and polygon look a `<Style>` gives, merged into `style`. */
function applyStyle(styleEl, style) {
  if (!styleEl) return style;
  for (const node of styleEl.childNodes) {
    if (node.nodeType !== 1 || !isKml(node)) continue;
    if (node.localName === 'IconStyle') {
      const billboard = (style.billboard ??= defaultBillboard());
      const icon = child(node, 'Icon');
      const href = text(icon, 'href');
      // An empty <Icon> draws no icon; none at all, the default pin.
      billboard.image = href ? href : icon ? false : undefined;
      const scale = number(node, 'scale');
      billboard.scale = scale;
      billboard.color = kmlColor(node);
      const heading = number(node, 'heading');
      // Heading 0 is no heading; north is 360.
      if (heading !== undefined && heading !== 0) billboard.course = heading;
      const spot = child(node, 'hotSpot');
      const x = attribute(spot, 'x');
      const y = attribute(spot, 'y');
      const s = scale ?? 1;
      let dx;
      let dy;
      if (x !== undefined) {
        // Units left out are a fraction, as KML has it.
        const units = spot.getAttribute('xunits') || 'fraction';
        if (units === 'pixels') dx = -x * s;
        else if (units === 'insetPixels') dx = (x - KML_ICON_SIZE) * s;
        else if (units === 'fraction') dx = -x * KML_ICON_SIZE * s;
        if (dx !== undefined) dx += KML_ICON_SIZE * 0.5 * s;
        else dx = Number.NaN;
      }
      if (y !== undefined) {
        const units = spot.getAttribute('yunits') || 'fraction';
        if (units === 'pixels') dy = y * s;
        else if (units === 'insetPixels') dy = (-y + KML_ICON_SIZE) * s;
        else if (units === 'fraction') dy = y * KML_ICON_SIZE * s;
        if (dy !== undefined) dy -= KML_ICON_SIZE * 0.5 * s;
        else dy = Number.NaN;
      }
      if (dx !== undefined || dy !== undefined)
        billboard.pixelOffset = {
          x: Number.isFinite(dx) ? dx : 0,
          y: Number.isFinite(dy) ? dy : 0,
        };
    } else if (node.localName === 'LineStyle') {
      const polyline = (style.polyline ??= {});
      polyline.width = number(node, 'width');
      polyline.color = kmlColor(node);
    } else if (node.localName === 'PolyStyle') {
      const polygon = (style.polygon ??= { outline: true });
      polygon.color = kmlColor(node) ?? polygon.color;
      polygon.fill = flag(node, 'fill') ?? polygon.fill;
      polygon.outline = flag(node, 'outline') ?? polygon.outline;
    }
  }
  return style;
}

/**
 * The document's shared styles by `#id`: each `<Style>` with an id, then
 * each `<StyleMap>` as its normal pair; the first of an id wins.
 */
function sharedStyles(doc) {
  const styles = new Map();
  for (const el of doc.getElementsByTagName('*')) {
    if (el.localName !== 'Style' || !isKml(el)) continue;
    const id = el.getAttribute('id');
    if (id && !styles.has(`#${id}`)) styles.set(`#${id}`, applyStyle(el, {}));
  }
  for (const el of doc.getElementsByTagName('*')) {
    if (el.localName !== 'StyleMap' || !isKml(el)) continue;
    const id = el.getAttribute('id');
    if (!id || styles.has(`#${id}`)) continue;
    for (const pair of children(el, 'Pair')) {
      if (text(pair, 'key') !== 'normal') continue;
      const style = {};
      let url = text(pair, 'styleUrl');
      if (url !== undefined) {
        if (url[0] !== '#') url = `#${url}`;
        merge(style, styles.get(url));
      } else applyStyle(child(pair, 'Style'), style);
      styles.set(`#${id}`, style);
      break;
    }
  }
  return styles;
}

/** A feature's own style: its last inline Style or StyleMap, then its styleUrl. */
function finalStyle(feature, styles) {
  const style = {};
  const lookup = (url) => styles.get(url) ?? styles.get(`#${url}`);
  let inline;
  for (const node of feature.childNodes)
    if (
      node.nodeType === 1 &&
      isKml(node) &&
      (node.localName === 'Style' || node.localName === 'StyleMap')
    )
      inline = node;
  if (inline?.localName === 'Style') applyStyle(inline, style);
  else if (inline)
    for (const pair of children(inline, 'Pair')) {
      if (text(pair, 'key') !== 'normal') continue;
      const url = text(pair, 'styleUrl');
      if (url !== undefined) merge(style, lookup(url));
      else applyStyle(child(pair, 'Style'), style);
    }
  const url = text(feature, 'styleUrl');
  if (url !== undefined) merge(style, lookup(url));
  return style;
}

const extrudable = (mode, gxMode) =>
  mode === 'absolute' ||
  mode === 'relativeToGround' ||
  gxMode === 'relativeToSeaFloor';

/** How a point stands: on the ground, above it, or at its own height. */
function pinHeightMode(mode, gxMode) {
  if ((!mode && !gxMode) || mode === 'clampToGround') return 'clamp';
  if (mode === 'relativeToGround') return 'relative';
  if (mode === 'absolute') return 'absolute';
  if (gxMode === 'relativeToSeaFloor') return 'relative';
  return 'clamp';
}

/** A placemark pin as a KML point draws it. */
function kmlPin(name, style, at, mode) {
  const billboard = style.billboard ?? defaultBillboard();
  const image =
    billboard.image === undefined
      ? DEFAULT_KML_PIN
      : billboard.image === false
        ? null
        : billboard.image;
  return {
    kind: 'pin',
    name,
    lon: at?.[0],
    lat: at?.[1],
    height: at?.[2] ?? 0,
    mode,
    image,
    size: [KML_ICON_SIZE, KML_ICON_SIZE],
    scale: billboard.scale,
    color: billboard.color,
    course: billboard.course,
    pixelOffset: billboard.pixelOffset,
    scaleByDistance: KML_ICON_SCALE_BY_DISTANCE,
    // Its hot spot's offset shrinks with it, as Cesium's KML icons' did.
    offsetScalesByDistance: true,
  };
}

/** One KML geometry element of a placemark as features; false for none. */
function kmlGeometry(el, name, style, out) {
  const mode = text(el, 'altitudeMode');
  const gxMode = text(el, 'altitudeMode', true);
  const canExtrude = extrudable(mode, gxMode);
  const extrude = flag(el, 'extrude');
  switch (el.localName) {
    case 'Point': {
      out.push(
        kmlPin(
          name,
          style,
          readCoordinate(text(el, 'coordinates')),
          pinHeightMode(mode, gxMode),
        ),
      );
      return true;
    }
    case 'LineString':
    case 'LinearRing': {
      const coords = readCoordinates(child(el, 'coordinates'));
      const line = style.polyline;
      if (canExtrude && extrude) {
        const polygon = style.polygon;
        out.push({
          kind: 'wall',
          name,
          coords,
          fill: polygon?.fill === false ? null : (polygon?.color ?? WHITE),
          outline: line
            ? (line.color ?? WHITE)
            : polygon
              ? (polygon.color ?? WHITE)
              : BLACK,
          outlineWidth: line?.width,
        });
      } else if (!canExtrude && flag(el, 'tessellate')) {
        out.push({
          kind: 'line',
          name,
          coords,
          mode: 'draped',
          color: line?.color ?? WHITE,
          width: line?.width ?? 1,
        });
      } else {
        // Straight in space: at the heights given where the altitude mode
        // allows, otherwise on the ellipsoid (a clamped line the import did
        // not tessellate, such as one with an explicit tessellate 0).
        out.push({
          kind: 'line',
          name,
          coords: canExtrude
            ? coords
            : coords?.map(([lon, lat]) => [lon, lat, 0]),
          mode: '3d',
          color: line?.color ?? WHITE,
          width: line?.width ?? 1,
        });
      }
      return true;
    }
    case 'Polygon': {
      const ring = (boundary) =>
        readCoordinates(child(child(boundary, 'LinearRing'), 'coordinates'));
      const outer = ring(child(el, 'outerBoundaryIs'));
      const holes = [];
      for (const inner of children(el, 'innerBoundaryIs'))
        for (const linear of children(inner, 'LinearRing')) {
          const coords = readCoordinates(child(linear, 'coordinates'));
          if (coords) holes.push(coords);
        }
      const polygon = style.polygon ?? { outline: true };
      const line = style.polyline;
      out.push({
        kind: 'polygon',
        name,
        rings: outer ? [outer, ...holes] : [],
        clamp: !canExtrude,
        extrude: canExtrude && extrude === true,
        fill: polygon.fill === false ? null : (polygon.color ?? WHITE),
        outline:
          polygon.outline === false
            ? null
            : line
              ? (line.color ?? WHITE)
              : WHITE,
        outlineWidth: line?.width,
      });
      return true;
    }
    case 'MultiGeometry': {
      let any = false;
      for (const part of el.childNodes) {
        if (part.nodeType !== 1 || !KML_GEOMETRIES.has(part.localName))
          continue;
        // Each part is a map object of its own, named as its placemark.
        out.entities += 1;
        if (kmlGeometry(part, name, style, out)) any = true;
      }
      return any;
    }
    default:
      return false;
  }
}
const KML_GEOMETRIES = new Set([
  'Point',
  'LineString',
  'LinearRing',
  'Polygon',
  'MultiGeometry',
  'Model',
  'Track',
  'MultiTrack',
]);

/** A ground overlay: an image (or colour) on a box or a quad. */
function kmlOverlay(el, name, out) {
  const quad = readCoordinates(child(el, 'LatLonQuad', true));
  const href = text(child(el, 'Icon'), 'href') || null;
  const color = kmlColor(el);
  const mode = text(el, 'altitudeMode');
  const gxMode = text(el, 'altitudeMode', true);
  const height =
    mode === 'absolute' || (!mode && gxMode === 'relativeToSeaFloor')
      ? number(el, 'altitude')
      : undefined;
  let rect = null;
  let rotation;
  const box = quad ? null : child(el, 'LatLonBox');
  // Neither box nor quad: nowhere to draw it, as before.
  if (box) {
    // Missing bounds are 0; longitudes wrap into [-180, 180].
    const wrap = (lon = 0) =>
      lon >= -180 && lon <= 180
        ? lon
        : ((((lon + 180) % 360) + 360) % 360) - 180;
    const clampLat = (lat = 0) => Math.max(-90, Math.min(90, lat));
    rect = {
      west: wrap(number(box, 'west')),
      south: clampLat(number(box, 'south')),
      east: wrap(number(box, 'east')),
      north: clampLat(number(box, 'north')),
    };
    // A box upside down has no area to draw (Cesium refused it too).
    if (rect.north < rect.south) rect = null;
    const turn = number(box, 'rotation');
    if (turn !== undefined) rotation = (turn * Math.PI) / 180;
  }
  out.push({
    kind: 'overlay',
    name,
    rect,
    quad,
    rotation,
    image: href,
    // Without an image, the overlay's colour; an image is drawn untinted.
    color: href ? undefined : (color ?? WHITE),
    height,
  });
}

/** A feature's short plain-text name, or undefined. */
function featureName(el) {
  try {
    return importFeatureName(text(el, 'name'));
  } catch {
    return undefined;
  }
}

/**
 * The features of a sanitized KML document.
 * @param {Document} doc
 * @returns {{features: object[], entityCount: number, drawable: boolean}}
 */
export function readKmlFeatures(doc) {
  const styles = sharedStyles(doc);
  const out = [];
  out.entities = 0;
  let positionless = false;
  const visit = (node) => {
    switch (node.localName) {
      case 'Document':
        for (const kid of node.childNodes) if (kid.nodeType === 1) visit(kid);
        return;
      case 'Folder':
        out.entities += 1;
        for (const kid of node.childNodes) if (kid.nodeType === 1) visit(kid);
        return;
      case 'Placemark': {
        out.entities += 1;
        const name = featureName(node);
        const style = finalStyle(node, styles);
        // Only the first geometry of a placemark is drawn.
        const geometry = [...node.childNodes].find(
          (kid) => kid.nodeType === 1 && KML_GEOMETRIES.has(kid.localName),
        );
        if (geometry) kmlGeometry(geometry, name, style, out);
        else {
          // No geometry: an icon with nowhere to stand.
          const pin = kmlPin(name, style, null, 'absolute');
          if (pin.image) positionless = true;
        }
        return;
      }
      case 'GroundOverlay':
        out.entities += 1;
        kmlOverlay(node, featureName(node), out);
        return;
      default:
    }
  };
  let root = doc.documentElement;
  if (root?.localName === 'kml')
    root = [...root.childNodes].find(
      (kid) =>
        kid.nodeType === 1 &&
        ['Document', 'Folder', 'Placemark', 'GroundOverlay'].includes(
          kid.localName,
        ),
    );
  if (root) visit(root);
  const entityCount = out.entities;
  const features = [...out];
  return {
    features,
    entityCount,
    drawable: positionless || features.some(drawable),
  };
}

/** The longest step, in degrees, of a rhumb line drawn as a path. */
const RHUMB_STEP = 0.5;
/**
 * The most points the steps may add to one file, as many as it may hold
 * (`MAX_IMPORT_POSITIONS`); past it, the rest are drawn as they are.
 */
const RHUMB_BUDGET = 250_000;
const mercatorY = (lat) =>
  Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const fromMercatorY = (y) => (Math.atan(Math.sinh(y)) * 180) / Math.PI;

/**
 * A path along rhumb lines, as GeoJSON is drawn: each long step split at
 * most `RHUMB_STEP` degrees apart along the line of constant bearing (the
 * draw port joins points the short way over the globe), the short way
 * round in longitude. Steps are added while `budget.left` allows.
 * @param {number[][]} coords `[lon, lat, height]`
 * @param {{left: number}} [budget] Points it may still add, shared by a file.
 * @returns {number[][]}
 */
export function rhumbPath(coords, budget = { left: RHUMB_BUDGET }) {
  const out = [];
  for (let i = 0; i < coords.length; i++) {
    const b = coords[i];
    const a = coords[i - 1];
    if (a) {
      const dLon = ((((b[0] - a[0] + 180) % 360) + 360) % 360) - 180;
      const steps = Math.ceil(
        Math.max(Math.abs(dLon), Math.abs(b[1] - a[1])) / RHUMB_STEP,
      );
      if (
        steps > 1 &&
        steps - 1 <= budget.left &&
        Math.abs(a[1]) < 89.9 &&
        Math.abs(b[1]) < 89.9
      ) {
        budget.left -= steps - 1;
        const ya = mercatorY(a[1]);
        const yb = mercatorY(b[1]);
        for (let k = 1; k < steps; k++) {
          const f = k / steps;
          let lon = a[0] + dLon * f;
          if (lon > 180) lon -= 360;
          else if (lon < -180) lon += 360;
          out.push([
            lon,
            fromMercatorY(ya + (yb - ya) * f),
            a[2] + (b[2] - a[2]) * f,
          ]);
        }
      }
    }
    out.push(b);
  }
  return out;
}

/** Whether a feature draws anything, as the loaders' output is checked. */
function drawable(feature) {
  switch (feature.kind) {
    case 'pin':
      return Boolean(feature.image);
    case 'line':
    case 'wall':
      return (feature.coords?.length ?? 0) >= 2;
    case 'polygon':
      return (feature.rings[0]?.length ?? 0) >= 3;
    case 'overlay':
      // Counted as before even without bounds, though it then draws nothing.
      return true;
    default:
      return false;
  }
}

/**
 * The features of prepared GeoJSON (names only, two-dimensional
 * coordinates), drawn in one colour: pins in it standing on the ground,
 * lines draped in it three pixels wide, polygons filled with it at a
 * quarter opacity.
 * @param {object} geojson
 * @param {string} color A CSS colour.
 * @returns {{features: object[], entityCount: number, drawable: boolean}}
 */
export function readGeoJsonFeatures(geojson, color) {
  const rgba = cssColor(color) ?? [...WHITE];
  const fill = [rgba[0], rgba[1], rgba[2], 0.25];
  const pin = plainPin(rgba, GEOJSON_PIN_SIZE);
  const features = [];
  let entityCount = 0;
  const at = (c) => [c[0], c[1], c[2] ?? 0];
  const geometry = (g, name) => {
    switch (g?.type) {
      case 'Point':
        entityCount += 1;
        features.push(geoPin(name, g.coordinates));
        return;
      case 'MultiPoint':
        for (const c of g.coordinates) {
          entityCount += 1;
          features.push(geoPin(name, c));
        }
        return;
      case 'LineString':
        entityCount += 1;
        features.push(geoLine(name, g.coordinates));
        return;
      case 'MultiLineString':
        for (const c of g.coordinates) {
          entityCount += 1;
          features.push(geoLine(name, c));
        }
        return;
      case 'Polygon':
        entityCount += 1;
        features.push(geoPolygon(name, g.coordinates));
        return;
      case 'MultiPolygon':
        for (const c of g.coordinates) {
          entityCount += 1;
          features.push(geoPolygon(name, c));
        }
        return;
      case 'GeometryCollection':
        for (const part of g.geometries) geometry(part, name);
        return;
      default:
    }
  };
  const geoPin = (name, c) => ({
    kind: 'pin',
    name,
    lon: c[0],
    lat: c[1],
    height: c[2] ?? 0,
    mode: c.length > 2 ? 'absolute' : 'clamp',
    image: pin,
    size: [GEOJSON_PIN_SIZE, GEOJSON_PIN_SIZE],
    anchor: 'bottom',
  });
  const budget = { left: RHUMB_BUDGET };
  const geoLine = (name, coords) => ({
    kind: 'line',
    name,
    coords: rhumbPath(coords.map(at), budget),
    mode: 'draped',
    color: rgba,
    width: 3,
  });
  const geoPolygon = (name, rings) => ({
    kind: 'polygon',
    name,
    rings: rings.map((ring) => rhumbPath(ring.map(at), budget)),
    clamp: true,
    extrude: false,
    fill,
    outline: null,
  });
  const feature = (f) => {
    if (f.geometry === null) {
      // A feature without geometry is a map object that draws nothing.
      entityCount += 1;
      return;
    }
    geometry(f.geometry, f.properties?.name || undefined);
  };
  if (geojson?.type === 'FeatureCollection')
    for (const f of geojson.features) feature(f);
  else if (geojson?.type === 'Feature') feature(geojson);
  else geometry(geojson, undefined);
  return { features, entityCount, drawable: features.some(drawable) };
}
