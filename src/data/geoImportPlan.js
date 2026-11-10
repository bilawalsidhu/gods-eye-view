// Pure drawing decisions for imported records. Image metadata is supplied by
// the caller; this module neither decodes images nor talks to a globe engine.
import * as geo from '../geo/index.js';
import { normalizeGroundItem } from '../globe/ground.js';
import { polygonShape, rectangleShape } from '../scenes/dataPacks/shapes.js';
import { hasRingVertices } from './geoImportRecords.js';
import * as defaults from './geoImportLimits.js';

const flat = (positions) => positions.map(([lon, lat]) => [lon, lat]);
const cartesian = ([lon, lat, height = 0]) =>
  geo.cartesian3.fromDegrees(lon, lat, height);

// A ground item the contract accepts, or null (a degenerate ring or line).
function checked(kind, item) {
  try {
    normalizeGroundItem(kind, item);
    return item;
  } catch {
    return null;
  }
}

// A ground overlay's box with east past west across 180°, and how a corner
// turns by its rotation: KML's degrees counter-clockwise about the centre,
// in longitude and latitude (Cesium's rectangle rotation).
function overlayBox({ rectangle, rotation = 0 }) {
  const { west, south, north } = rectangle;
  const east = rectangle.east < west ? rectangle.east + 360 : rectangle.east;
  const box = { west, south, east, north };
  const center = [(west + east) / 2, (south + north) / 2];
  const angle = (rotation * Math.PI) / 180;
  const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
  const turn = ([lon, lat]) => {
    const [x, y] = [lon - center[0], lat - center[1]];
    return [center[0] + x * cos - y * sin, center[1] + x * sin + y * cos];
  };
  return { box, center, angle, turn };
}

/** One key per drawn look of an icon, so equal pins share a sprite set. */
const lookKey = (icon, depth) =>
  JSON.stringify([
    icon.image,
    icon.widthPx,
    icon.heightPx,
    icon.scale,
    icon.origin,
    icon.offsetPx,
    icon.subRegion,
    icon.scaleByDistance,
    depth,
  ]);

// Canvas coordinates use one scale on both axes for rotations in degrees.
function overlayCanvas(overlay, maxSide, natural) {
  const tint = overlay.color.slice(0, 3);
  const { box, center, angle } = overlayBox(overlay);
  if (tint.every((value) => value === 1) && !angle)
    return { rectangle: overlay.rectangle, canvas: null };
  const [width, height] = [box.east - box.west, box.north - box.south];
  const [cos, sin] = [Math.abs(Math.cos(angle)), Math.abs(Math.sin(angle))];
  const [spanX, spanY] = [
    width * cos + height * sin,
    width * sin + height * cos,
  ];
  const rectangle = {
    west: center[0] - spanX / 2,
    south: center[1] - spanY / 2,
    east: center[0] + spanX / 2,
    north: center[1] + spanY / 2,
  };
  if (angle && (rectangle.south < -90 || rectangle.north > 90 || spanX >= 360))
    return null;
  const wrap = (lon) => (lon > 180 ? lon - 360 : lon < -180 ? lon + 360 : lon);
  const bounds = angle
    ? { ...rectangle, west: wrap(rectangle.west), east: wrap(rectangle.east) }
    : overlay.rectangle;
  // A failed decode keeps the original image-layer path, as a plain image does.
  if (natural === null) return { rectangle: overlay.rectangle, canvas: null };
  let [scaleX, scaleY] = [
    (natural?.width ?? 1) / width,
    (natural?.height ?? 1) / height,
  ];
  if (angle) scaleX = scaleY = Math.max(scaleX, scaleY);
  const fit = Math.min(
    1,
    maxSide / (spanX * scaleX),
    maxSide / (spanY * scaleY),
  );
  [scaleX, scaleY] = [scaleX * fit, scaleY * fit];
  return {
    rectangle: bounds,
    canvas: {
      key: JSON.stringify([overlay.url, tint, angle, width / height]),
      width: Math.max(1, Math.round(spanX * scaleX)),
      height: Math.max(1, Math.round(spanY * scaleY)),
      angle,
      tint,
      draw: [
        (-width * scaleX) / 2,
        (-height * scaleY) / 2,
        width * scaleX,
        height * scaleY,
      ],
    },
  };
}

/**
 * Decide what one file draws, without a DOM or engine. `limits` overrides the
 * shared ceilings for tests. `context.images` is a Map of URL to {width, height},
 * or null for a failed decode. `images` in the result names missing metadata;
 * a caller can load those images and plan again. Report counts retain the import
 * UI's semantics: a partial polygon can be both drawn and reported unsupported.
 * Each primitive retains its source record for diagnostics.
 */
export function planImport(records, limits = defaults, context = {}) {
  limits = { ...defaults, ...limits };
  const ground = [];
  const lines = [];
  const pins = [];
  const overlays = [];
  const meshes = [];
  const undrawn = [];
  const images = new Set();
  const kinds = { ...records.undrawn };
  let drawn = 0;
  const skip = (record, reason, counted = true) => {
    undrawn.push({ record, reason });
    if (counted) kinds[reason] = (kinds[reason] ?? 0) + 1;
  };
  for (const [reason, count] of Object.entries(records.undrawn))
    undrawn.push({ reason, count });
  const needImage = (url) => {
    if (!context.images?.has(url)) images.add(url);
    return context.images?.get(url);
  };
  for (const polygon of records.polygons) {
    let any = false;
    if (polygon.raised && polygon.rings.length > limits.MAX_RAISED_RINGS) {
      skip(polygon, 'complexPolygon');
      continue;
    }
    // Cesium discards short holes; an invalid outer ring cannot become a hole's fill.
    const rings = [
      polygon.rings[0] ?? [],
      ...polygon.rings.slice(1).filter(hasRingVertices),
    ];
    if (polygon.fill && polygon.raised) {
      // The closing copy is not a vertex in the triangulation budget.
      const vertices = polygon.rings.reduce(
        (n, ring) =>
          n +
          ring.length -
          Number(
            ring.length > 1 &&
              ring[0][0] === ring.at(-1)[0] &&
              ring[0][1] === ring.at(-1)[1],
          ),
        0,
      );
      const shape =
        vertices <= limits.MAX_RAISED_VERTICES &&
        hasRingVertices(rings[0]) &&
        polygonShape(rings);
      if (vertices > limits.MAX_RAISED_VERTICES)
        skip(polygon, 'complexPolygon');
      if (shape) {
        meshes.push({
          record: polygon,
          positions: shape.attributes.position.values,
          indices: shape.indices,
          color: polygon.fill,
        });
        any = true;
      } else if (vertices <= limits.MAX_RAISED_VERTICES)
        skip(polygon, 'polygon', false);
    } else if (polygon.fill) {
      const item =
        hasRingVertices(rings[0]) &&
        checked('polygon', { rings: rings.map(flat), fill: polygon.fill });
      if (item) {
        ground.push({
          record: polygon,
          kind: 'polygon',
          order: limits.POLYGON_ORDER,
          item,
        });
        any = true;
      } else skip(polygon, 'polygon');
    }
    if (polygon.raised && polygon.outline)
      for (const ring of rings) {
        if (ring.length < 2) continue;
        lines.push({
          record: polygon,
          positions: [...ring, ring[0]].map(cartesian),
          widthPx: 1,
          color: polygon.outline.color,
        });
        any = true;
      }
    if (any) drawn++;
    else if (!polygon.fill) skip(polygon, 'noFill', false);
  }
  const overlaySide = Math.min(
    limits.MAX_OVERLAY_SIDE,
    Math.floor(
      Math.sqrt(
        limits.OVERLAY_PIXEL_BUDGET / Math.max(1, records.overlays.length),
      ),
    ),
  );
  // Stable sort preserves the document's order for equal KML drawOrder values.
  for (const overlay of [...records.overlays].sort(
    (a, b) => (a.drawOrder ?? 0) - (b.drawOrder ?? 0),
  )) {
    const raise =
      overlay.altitudeMode === 'absolute' && overlay.altitude !== 0
        ? overlay.altitude
        : undefined;
    if (overlay.url) {
      const prepared = overlayCanvas(
        overlay,
        overlaySide,
        context.images?.get(overlay.url),
      );
      if (!prepared) {
        skip(overlay, 'rotatedOverlay');
        continue;
      }
      if (prepared.canvas || raise) needImage(overlay.url);
      if (raise && context.images?.get(overlay.url) === null) {
        skip(overlay, 'raisedOverlay');
        continue;
      }
      const alpha = Math.min(0.99, overlay.color[3]);
      const entry = {
        record: overlay,
        url: overlay.url,
        ...prepared,
        alpha,
        order: limits.OVERLAY_ORDER,
      };
      if (raise) {
        const { west, south, east, north } = prepared.rectangle;
        const shape = rectangleShape([west, south, east, north], raise);
        meshes.push({
          ...entry,
          positions: shape.attributes.position.values,
          indices: shape.indices,
          uv: shape.attributes.st.values,
          color: [1, 1, 1, alpha],
        });
      } else overlays.push(entry);
      drawn++;
      continue;
    }
    if (!checked('cell', overlay.rectangle)) {
      skip(overlay, 'overlay', false);
      continue;
    }
    const { box, center, turn } = overlayBox(overlay);
    const rings = [
      [
        [box.west, box.south],
        [box.east, box.south],
        [box.east, box.north],
        [box.west, box.north],
      ].map(turn),
    ];
    const item = checked('polygon', { rings, fill: overlay.color });
    if (!item) {
      skip(overlay, 'rotatedOverlay');
      continue;
    }
    if (raise) {
      const shape = rectangleShape(
        [box.west, box.south, box.east, box.north],
        raise,
      );
      const positions = shape.attributes.position.values;
      for (let i = 0; i < positions.length; i += 3) {
        const at = geo.cartographic.fromCartesian({
          x: positions[i],
          y: positions[i + 1],
          z: positions[i + 2],
        });
        const longitude = geo.math.toDegrees(at.longitude);
        const [lon, lat] = turn([
          longitude + 360 * Math.round((center[0] - longitude) / 360),
          geo.math.toDegrees(at.latitude),
        ]);
        const p = cartesian([lon, lat, raise]);
        positions.set([p.x, p.y, p.z], i);
      }
      meshes.push({
        record: overlay,
        positions,
        indices: shape.indices,
        color: overlay.color,
      });
    } else
      ground.push({
        record: overlay,
        kind: 'polygon',
        order: limits.POLYGON_ORDER,
        item,
      });
    drawn++;
  }
  for (const record of records.lines) {
    if (record.ground) {
      const item = checked('corridor', {
        positions: flat(record.positions),
        color: record.color,
        widthPx: record.widthPx,
      });
      if (!item) {
        skip(record, 'line', false);
        continue;
      }
      ground.push({ record, kind: 'corridor', order: limits.LINE_ORDER, item });
    } else
      lines.push({
        record,
        positions: record.positions.map(cartesian),
        widthPx: record.widthPx,
        color: record.color,
      });
    drawn++;
  }
  const looks = new Map();
  for (const point of records.points) {
    const depth = point.altitude === 'absolute' ? 'normal' : 'always';
    const key = lookKey(point.icon, depth);
    let look = looks.get(key);
    if (!look) looks.set(key, (look = { icon: point.icon, depth, pins: [] }));
    const [lon, lat, height = 0] = point.position;
    look.pins.push({
      record: point,
      lon,
      lat,
      offset: point.altitude === 'relative' ? height : 0,
      height: point.altitude === 'absolute' ? height : null,
      ground: undefined,
      position: null,
      horizon: null,
      show: true,
      color: point.icon.color ?? [1, 1, 1, 1],
      rotation: point.icon.rotation ?? 0,
    });
  }
  const maxSide = Math.min(
    limits.MAX_ICON_SIDE,
    Math.floor(Math.sqrt(limits.ICON_PIXEL_BUDGET / Math.max(1, looks.size))),
  );
  for (const look of looks.values()) {
    const url = look.icon.image?.url;
    if (url && needImage(url) === null) {
      for (const pin of look.pins) skip(pin.record, 'icon', false);
    }
    const draw = !url || context.images?.get(url) !== null;
    pins.push({ ...look, maxSide, draw });
    if (draw) drawn += look.pins.length;
  }
  return {
    ground,
    lines,
    pins,
    overlays,
    meshes,
    undrawn,
    images: [...images],
    report: {
      drawn,
      undrawn: Object.values(kinds).reduce((n, c) => n + c, 0),
      kinds,
    },
  };
}
