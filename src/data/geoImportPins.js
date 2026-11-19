/**
 * The drawn part of the file import: what `geoImportFeatures.js` read from
 * a file, drawn through the draw port in three sets (its pins, its lines,
 * its shapes), its ground pins placed on the ground in batches, and its
 * footprint read back.
 */
import {
  GeoImportError,
  MAX_IMPORT_ENTITIES,
  boundedImport,
} from './geoImportShared.js';
import { msg } from '../i18n/marker.js';
import { fromDegrees, toLonLatH } from '../geo/ellipsoid.js';
import { heightsOf } from '../queries/heights.js';
import {
  drawOf,
  findCamera,
  findFrame,
  findGlobe,
} from '../render/rendererOf.js';

/** Ground pins are placed this many at a time, yielding between batches. */
const GROUND_BATCH = 256;
/** Below this camera height, in-view pins over a mesh are clamped to it. */
const MESH_CLAMP_HEIGHT = 250_000;
/** How long the terrain has to say it is the bare ellipsoid (it answers at once). */
const ELLIPSOID_PROBE_MS = 100;

let drawings = 0;

const finite = (n) => Number.isFinite(n);

/** Whether `rect` (degrees, maybe across the antimeridian) holds the point. */
function inRect(rect, lon, lat) {
  if (lat < rect.south || lat > rect.north) return false;
  return rect.west <= rect.east
    ? lon >= rect.west && lon <= rect.east
    : lon >= rect.west || lon <= rect.east;
}

/**
 * The corners of an overlay's box turned by its rotation (radians
 * counter-clockwise about its centre), as `[lon, lat]`.
 */
function turnedCorners({ west, south, east: eastEdge, north }, rotation = 0) {
  // Across the antimeridian, east is past 180 while turning.
  const east = eastEdge < west ? eastEdge + 360 : eastEdge;
  const wrap = (lon) => (lon > 180 ? lon - 360 : lon < -180 ? lon + 360 : lon);
  const corners = [
    [west, south],
    [east, south],
    [west, north],
    [east, north],
  ];
  if (!rotation) return corners.map(([lon, lat]) => [wrap(lon), lat]);
  const lon0 = (west + east) / 2;
  const lat0 = (south + north) / 2;
  const k = Math.cos((lat0 * Math.PI) / 180) || 1;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return corners.map(([lon, lat]) => {
    const x = (lon - lon0) * k;
    const y = lat - lat0;
    return [wrap(lon0 + (x * cos - y * sin) / k), lat0 + x * sin + y * cos];
  });
}

/**
 * Draw an imported file's features on `viewer`. Nothing is drawn until
 * `mount()`; `refreshGround()` places the ground pins first.
 * @param {object} viewer
 * @param {object[]} features From `readKmlFeatures` or `readGeoJsonFeatures`.
 */
export function createImportedDrawing(viewer, features) {
  const prefix = `geo-import:${++drawings}`;
  const ids = {
    icons: `${prefix}:pins`,
    lines: `${prefix}:lines`,
    shapes: `${prefix}:shapes`,
  };
  const pins = features.filter((f) => f.kind === 'pin');
  for (const pin of pins)
    if (!finite(pin.lon) || !finite(pin.lat) || !finite(pin.height))
      throw new GeoImportError(msg('That file has invalid point coordinates.'));
  // Pins on the ground or above it, placed there by `refreshGround`.
  const grounded = pins
    .filter((pin) => pin.mode !== 'absolute')
    .map((pin) => ({
      pin,
      offset: pin.mode === 'relative' ? pin.height : 0,
      groundHeight: undefined,
    }));
  let sets = null;
  /** The items last handed to each set, for inspection. */
  let drawn = { icons: [], lines: [], shapes: [] };
  let show = true;
  let destroyed = false;
  /** The surface last asked whether it is the bare ellipsoid, and its answer. */
  let probed;
  let ellipsoid = false;

  const meta = (feature) => (feature.name ? { name: feature.name } : undefined);
  const pos = ([lon, lat, height]) => ({ lon, lat, height });
  const ecef = ([lon, lat, height]) => fromDegrees(lon, lat, height);

  function pinItem(pin, index) {
    const item = {
      id: `p${index}`,
      pos: { lon: pin.lon, lat: pin.lat, height: pin.height },
      height: 'absolute',
      image: pin.image,
      size: pin.size,
      meta: meta(pin),
    };
    if (pin.scale !== undefined) item.scale = pin.scale;
    if (pin.color) item.color = pin.color;
    if (pin.anchor) item.anchor = pin.anchor;
    if (pin.scaleByDistance) item.scaleByDistance = pin.scaleByDistance;
    if (pin.pixelOffset) item.pixelOffset = pin.pixelOffset;
    if (pin.offsetScalesByDistance) item.offsetScalesByDistance = true;
    if (pin.course !== undefined) {
      // Turned clockwise by its heading from the Earth's axis as it stands
      // on screen, as Cesium's KML icons were.
      item.rotationMode = 'axis';
      item.alignedAxis = { x: 0, y: 0, z: 1 };
      item.rotation = (-pin.course * Math.PI) / 180;
    }
    // On the ground or above it, drawn over what is in front.
    if (pin.mode !== 'absolute') item.disableDepthTest = Infinity;
    return item;
  }

  function lineItem(line, id) {
    if ((line.coords?.length ?? 0) < 2) return null;
    return {
      id,
      positions: line.coords.map((c) =>
        ecef(line.mode === 'draped' ? [c[0], c[1], 0] : c),
      ),
      widthPx: line.width,
      mode: line.mode,
      style: { kind: 'solid', color: line.color },
      meta: meta(line),
    };
  }

  function shapeItem(feature, id) {
    switch (feature.kind) {
      case 'polygon': {
        const rings = feature.rings.filter((ring) => ring.length >= 3);
        if (!rings.length || feature.rings[0].length < 3) return null;
        if (feature.clamp)
          // On the ground its outline is not drawn, as before.
          return feature.fill
            ? {
                id,
                geometry: {
                  kind: 'polygon',
                  rings: rings.map((ring) =>
                    ring.map(([lon, lat]) => ({ lon, lat })),
                  ),
                },
                fill: feature.fill,
                height: 'clampGround',
                meta: meta(feature),
              }
            : null;
        const item = {
          id,
          geometry: {
            kind: 'polygon',
            rings: rings.map((ring) => ring.map(pos)),
            perPositionHeight: true,
          },
          fill: feature.fill,
          outline: feature.outline,
          lit: true,
          meta: meta(feature),
        };
        if (feature.outlineWidth !== undefined)
          item.outlineWidth = feature.outlineWidth;
        if (feature.extrude) item.extrudeHeight = 0;
        return item;
      }
      case 'wall': {
        if ((feature.coords?.length ?? 0) < 2) return null;
        const item = {
          id,
          geometry: { kind: 'wall', positions: feature.coords.map(pos) },
          fill: feature.fill,
          outline: feature.outline,
          lit: true,
          meta: meta(feature),
        };
        if (feature.outlineWidth !== undefined)
          item.outlineWidth = feature.outlineWidth;
        return item;
      }
      case 'overlay': {
        const fill = feature.image ? { image: feature.image } : feature.color;
        const height =
          feature.height === undefined ? 'clampGround' : 'absolute';
        if (feature.quad) {
          if (feature.quad.length < 3) return null;
          const at = feature.height ?? 0;
          return {
            id,
            geometry: {
              kind: 'polygon',
              rings: [
                feature.quad.map(([lon, lat]) => ({ lon, lat, height: at })),
              ],
            },
            fill,
            height,
            ...(feature.height !== undefined ? { lit: true } : {}),
            meta: meta(feature),
          };
        }
        if (!feature.rect) return null;
        const geometry = { kind: 'rectangle', rect: feature.rect };
        if (feature.rotation) geometry.rotation = feature.rotation;
        if (feature.height !== undefined) geometry.height = feature.height;
        const item = { id, geometry, fill, height, meta: meta(feature) };
        // In the air it is lit, as it was; on the ground it is not.
        if (feature.height !== undefined) item.lit = true;
        return item;
      }
      default:
        return null;
    }
  }

  /** A feature's footprint, `[lon, lat, height]`. */
  function footprintOf(feature) {
    switch (feature.kind) {
      case 'pin':
        return [[feature.lon, feature.lat, feature.height]];
      case 'line':
        return (feature.coords ?? []).map((c) =>
          feature.mode === 'draped' ? [c[0], c[1], 0] : c,
        );
      case 'wall':
        return feature.coords ?? [];
      case 'polygon':
        return feature.rings.flatMap((ring) =>
          feature.clamp ? ring.map(([lon, lat]) => [lon, lat, 0]) : ring,
        );
      case 'overlay':
        if (feature.quad)
          return feature.quad.map(([lon, lat]) => [lon, lat, 0]);
        if (!feature.rect) return [];
        return turnedCorners(feature.rect, feature.rotation).map(
          ([lon, lat]) => [lon, lat, feature.height || 0],
        );
      default:
        return [];
    }
  }

  function draw() {
    const port = drawOf(viewer);
    const icons = [];
    const lines = [];
    const shapes = [];
    features.forEach((feature, index) => {
      if (feature.kind === 'pin') {
        // A pin with no icon draws nothing, but frames its file.
        if (!feature.image) return;
        const item = pinItem(feature, index);
        icons.push(item);
      } else if (feature.kind === 'line') {
        const item = lineItem(feature, `l${index}`);
        if (!item) return;
        lines.push(item);
      } else {
        const item = shapeItem(feature, `s${index}`);
        if (!item) return;
        shapes.push(item);
      }
    });
    drawn = { icons, lines, shapes };
    sets = {};
    try {
      if (shapes.length) {
        sets.shapes = port.shapes({ id: ids.shapes, show });
        sets.shapes.set(shapes);
      }
      if (lines.length) {
        sets.lines = port.lines({ id: ids.lines, show });
        sets.lines.set(lines);
      }
      if (icons.length) {
        sets.icons = port.icons({ id: ids.icons, show });
        sets.icons.set(icons);
      }
    } catch (error) {
      disposeSets();
      throw error;
    }
  }

  function disposeSets() {
    for (const set of Object.values(sets ?? {})) set.dispose();
    sets = null;
  }

  /** Move the drawn pins to where they now stand. */
  function redrawPins() {
    if (!sets?.icons) return;
    const items = [];
    features.forEach((feature, index) => {
      if (feature.kind === 'pin' && feature.image)
        items.push(pinItem(feature, index));
    });
    sets.icons.upsert(items);
    drawn = { ...drawn, icons: items };
    findFrame(viewer)?.requestRender('geo-import');
  }

  /**
   * Whether the terrain at `point` is the bare ellipsoid, whose height is
   * exactly 0 while its drawn tiles can sag kilometres below it. It answers
   * at once; any other terrain is left to load in its own time.
   */
  async function onEllipsoid(heights, point, signal) {
    const terrain = { against: 'terrain' };
    let timer;
    try {
      // The ellipsoid answers 0, and nothing once told to miss there.
      const [plain, missing] = await Promise.race([
        Promise.all([
          heights.batch([point], terrain),
          heights.batch([point], { ...terrain, ellipsoidMisses: true }),
        ]),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve([[], []]), ELLIPSOID_PROBE_MS);
        }),
      ]);
      return plain[0] === 0 && missing[0] === null;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
      signal?.throwIfAborted();
    }
  }

  /**
   * Place the ground pins on the ground now under them, in batches: the
   * terrain's height (0 on the bare ellipsoid), or over a mesh (the globe
   * hidden) the mesh in view below 250 km; relative pins that far above it.
   */
  async function settle(signal) {
    const heights = heightsOf(viewer);
    // Whether the terrain is the bare ellipsoid, asked once for each
    // surface (each time when the renderer cannot say the surface changed).
    const version = findGlobe(viewer)?.surfaceVersion?.();
    if (grounded.length && (version === undefined || version !== probed)) {
      const { pin } = grounded[0];
      ellipsoid = await onEllipsoid(
        heights,
        { lon: pin.lon, lat: pin.lat },
        signal,
      );
      probed = version;
    }
    for (let at = 0; at < grounded.length; at += GROUND_BATCH) {
      signal?.throwIfAborted();
      const batch = grounded.slice(at, at + GROUND_BATCH);
      const mesh =
        findGlobe(viewer)?.isGlobeVisible?.() === false &&
        heights.supported().clamp;
      const sampled = batch.map(({ pin }) =>
        ellipsoid
          ? 0
          : heights.now({ lon: pin.lon, lat: pin.lat }, { against: 'terrain' }),
      );
      const ground = batch.map(({ groundHeight }, i) => {
        // A hidden coarse globe can answer kilometres below the surface;
        // the mesh ray must not start there.
        const h = sampled[i];
        if (mesh) return groundHeight ?? Math.max(0, finite(h) ? h : 0);
        return finite(h) ? h : groundHeight || 0;
      });
      const camera = findCamera(viewer);
      const height = camera?.pose?.()?.height;
      if (mesh && finite(height) && height < MESH_CLAMP_HEIGHT) {
        const rect = camera.viewRectangle?.();
        const indices = [];
        if (rect)
          for (let i = 0; i < batch.length; i++)
            if (inRect(rect, batch[i].pin.lon, batch[i].pin.lat))
              indices.push(i);
        if (indices.length) {
          const resolved = await boundedImport(
            heights.clampBatch(
              indices.map((i) =>
                fromDegrees(
                  batch[i].pin.lon,
                  batch[i].pin.lat,
                  Math.max(0, ground[i]),
                ),
              ),
            ),
            signal,
          );
          for (let k = 0; k < indices.length; k++) {
            const h = resolved[k] && toLonLatH(resolved[k])?.height;
            if (finite(h)) ground[indices[k]] = h;
          }
        }
      }
      signal?.throwIfAborted();
      for (let i = 0; i < batch.length; i++) {
        if (!finite(ground[i]))
          throw new GeoImportError(
            msg(
              'Ground heights are not available for that file. Try again when the map has loaded.',
            ),
          );
        batch[i].groundHeight = ground[i];
        batch[i].pin.height = ground[i] + batch[i].offset;
      }
      if (at + batch.length < grounded.length)
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  return {
    get show() {
      return show;
    },
    set show(value) {
      show = Boolean(value);
      for (const set of Object.values(sets ?? {})) set.show = show;
    },
    /** Draw it; once, and never after `destroy`. */
    mount() {
      if (destroyed || sets) return;
      draw();
    },
    /** Place the ground pins again, and move the drawn ones. */
    async refreshGround(signal) {
      if (destroyed) return;
      await settle(signal);
      if (!destroyed) redrawPins();
    },
    /** Every shown position, path vertex, ring vertex and overlay corner. */
    points() {
      if (!show) return [];
      return features.flatMap(footprintOf);
    },
    /** The draw sets' ids, by kind. */
    ids,
    /** The items each set was last given (contract items), by kind. */
    items() {
      return {
        icons: [...drawn.icons],
        lines: [...drawn.lines],
        shapes: [...drawn.shapes],
      };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      disposeSets();
      drawn = { icons: [], lines: [], shapes: [] };
    },
  };
}

/**
 * Check what was read of a file and place its ground pins. The refusals a
 * person reads are `GeoImportError`s; the caller revokes what it owns on
 * any failure.
 * @param {{features: object[], entityCount: number, drawable: boolean}} read
 * @param {object} viewer
 * @param {AbortSignal} [signal]
 * @returns {Promise<{entityCount: number, drawing: object, refreshGround: Function}>}
 */
export async function settleImportedDrawing(read, viewer, signal) {
  const { features, entityCount, drawable } = read;
  if (entityCount > MAX_IMPORT_ENTITIES)
    throw new GeoImportError(
      `That file has ${entityCount.toLocaleString()} map objects; the limit is ${MAX_IMPORT_ENTITIES.toLocaleString()}.`,
      msg('That file has {count} map objects; the limit is {limit}.'),
      {
        count: entityCount,
        limit: MAX_IMPORT_ENTITIES,
      },
    );
  if (!drawable)
    throw new GeoImportError(msg('That file has nothing to draw.'));
  const drawing = createImportedDrawing(viewer, features);
  try {
    await drawing.refreshGround(signal);
  } catch (error) {
    drawing.destroy();
    throw error instanceof GeoImportError
      ? error
      : new GeoImportError(
          msg('Ground heights could not be read. Try that file again.'),
        );
  }
  return {
    entityCount,
    drawing,
    refreshGround: (refreshSignal) =>
      drawing.refreshGround(
        refreshSignal
          ? AbortSignal.any([refreshSignal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(15_000),
      ),
  };
}

/**
 * Take an imported file's drawing off the globe.
 * @param {object} drawing
 */
export function removeImportedDrawing(drawing) {
  drawing?.destroy();
}

/**
 * Show or hide an imported file's drawing.
 * @param {object} drawing
 * @param {boolean} show
 */
export function showImportedDrawing(drawing, show) {
  drawing.show = show;
}

/**
 * The footprint of an imported file's drawing, `[lon, lat, height]`; none
 * while it is hidden.
 * @param {object} drawing
 */
export function importedDrawingPoints(drawing) {
  return drawing?.points?.() ?? [];
}
