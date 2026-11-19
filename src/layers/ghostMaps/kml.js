// Read the drawable content of a parsed GhostMaps KML document: placemarks
// with their folder, geometry, resolved style and raw description. Network
// links, overlays, models and remote icons are never followed; an icon is
// either an image packed in the same KMZ or the layer's own marker.
import { kmlColor } from './records.js';

export const MAX_GHOSTMAPS_FEATURES = 20_000;
export const MAX_GHOSTMAPS_POSITIONS = 250_000;

const childrenNamed = (el, name) =>
  [...(el?.children || [])].filter((child) => child.localName === name);
const firstChild = (el, name) =>
  [...(el?.children || [])].find((child) => child.localName === name) || null;
const descendants = (el, name) =>
  [...(el?.getElementsByTagName?.('*') || [])].filter(
    (child) => child.localName === name,
  );
const text = (el) => (el?.textContent ?? '').trim();

function number(el, fallback) {
  const value = Number(text(el));
  return el && Number.isFinite(value) ? value : fallback;
}

/** `lon,lat[,alt] lon,lat ...` → [[lon, lat], ...]; invalid tuples are dropped. */
export function parseKmlCoordinates(value) {
  const out = [];
  for (const tuple of String(value ?? '')
    .trim()
    .split(/\s+/)) {
    const [lon, lat] = tuple.split(',').map(Number);
    if (
      Number.isFinite(lon) &&
      Number.isFinite(lat) &&
      Math.abs(lat) <= 90 &&
      Math.abs(lon) <= 180
    )
      out.push([lon, lat]);
  }
  return out;
}

function readStyle(styleEl, resolveImage) {
  const style = {};
  const icon = firstChild(styleEl, 'IconStyle');
  if (icon) {
    const href = text(firstChild(firstChild(icon, 'Icon'), 'href'));
    style.icon = href ? resolveImage(href) : null;
    style.iconScale = number(firstChild(icon, 'scale'), 1);
    style.iconColor = kmlColor(text(firstChild(icon, 'color')));
  }
  const line = firstChild(styleEl, 'LineStyle');
  if (line) {
    style.lineColor = kmlColor(text(firstChild(line, 'color')));
    style.lineWidth = number(firstChild(line, 'width'), 1);
  }
  const poly = firstChild(styleEl, 'PolyStyle');
  if (poly) {
    style.polyColor = kmlColor(text(firstChild(poly, 'color')));
    style.fill = text(firstChild(poly, 'fill')) !== '0';
    style.outline = text(firstChild(poly, 'outline')) !== '0';
  }
  return style;
}

/** Shared styles by id; a StyleMap resolves to its `normal` pair. */
function collectStyles(doc, resolveImage) {
  const styles = new Map();
  for (const el of descendants(doc, 'Style')) {
    const id = el.getAttribute('id');
    if (id) styles.set(id, readStyle(el, resolveImage));
  }
  const maps = new Map();
  for (const el of descendants(doc, 'StyleMap')) {
    const id = el.getAttribute('id');
    if (!id) continue;
    const normal = childrenNamed(el, 'Pair').find(
      (pair) => text(firstChild(pair, 'key')) === 'normal',
    );
    if (!normal) continue;
    const inline = firstChild(normal, 'Style');
    maps.set(
      id,
      inline
        ? readStyle(inline, resolveImage)
        : text(firstChild(normal, 'styleUrl')),
    );
  }
  const resolve = (url, depth = 0) => {
    const id = String(url || '').replace(/^#/, '');
    if (!id || url.includes('/') || depth > 2) return {};
    if (styles.has(id)) return styles.get(id);
    const mapped = maps.get(id);
    if (typeof mapped === 'string') return resolve(mapped, depth + 1);
    return mapped || {};
  };
  return resolve;
}

function readGeometry(el, out, budget) {
  switch (el.localName) {
    case 'Point': {
      const [position] = parseKmlCoordinates(
        text(firstChild(el, 'coordinates')),
      );
      if (position) {
        budget.positions += 1;
        out.push({ type: 'point', position });
      }
      break;
    }
    case 'LineString':
    case 'LinearRing': {
      const positions = parseKmlCoordinates(
        text(firstChild(el, 'coordinates')),
      );
      if (positions.length >= 2) {
        budget.positions += positions.length;
        out.push({ type: 'line', positions });
      }
      break;
    }
    case 'Polygon': {
      const ring = (boundary) =>
        parseKmlCoordinates(
          text(firstChild(firstChild(boundary, 'LinearRing'), 'coordinates')),
        );
      const outer = ring(firstChild(el, 'outerBoundaryIs'));
      if (outer.length >= 3) {
        const holes = childrenNamed(el, 'innerBoundaryIs')
          .map(ring)
          .filter((hole) => hole.length >= 3);
        budget.positions +=
          outer.length + holes.reduce((n, hole) => n + hole.length, 0);
        out.push({ type: 'polygon', outer, holes });
      }
      break;
    }
    case 'MultiGeometry':
      for (const child of el.children) readGeometry(child, out, budget);
      break;
    default:
      // Models, tracks and anything newer are not drawn.
      break;
  }
}

/** Name of the nearest enclosing Folder (or Document), for grouping. */
function folderName(el) {
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (node.localName === 'Folder' || node.localName === 'Document') {
      const name = text(firstChild(node, 'name'));
      if (name) return name;
    }
  }
  return '';
}

/**
 * @param {Document} doc Parsed KML.
 * @param {(href: string) => ?string} resolveImage URL for a KMZ-packed image.
 * @returns {{features: Array<{name: string, folder: string,
 *   description: string, style: object, geometries: Array<object>}>,
 *   positions: number, over: boolean}}
 */
export function readGhostMapsKml(doc, resolveImage = () => null) {
  const styleFor = collectStyles(doc, resolveImage);
  const features = [];
  const budget = { positions: 0 };
  let over = false;
  for (const placemark of descendants(doc, 'Placemark')) {
    // A hidden placemark (visibility 0) is drawn hidden by Google Earth too.
    if (text(firstChild(placemark, 'visibility')) === '0') continue;
    const geometries = [];
    for (const child of placemark.children)
      readGeometry(child, geometries, budget);
    if (!geometries.length) continue;
    if (
      features.length >= MAX_GHOSTMAPS_FEATURES ||
      budget.positions > MAX_GHOSTMAPS_POSITIONS
    ) {
      over = true;
      break;
    }
    const inline = firstChild(placemark, 'Style');
    features.push({
      name: text(firstChild(placemark, 'name')).slice(0, 200),
      folder: folderName(placemark).slice(0, 120),
      description: text(firstChild(placemark, 'description')),
      style: {
        ...styleFor(text(firstChild(placemark, 'styleUrl'))),
        ...(inline ? readStyle(inline, resolveImage) : {}),
      },
      geometries,
    });
  }
  return { features, positions: budget.positions, over };
}
