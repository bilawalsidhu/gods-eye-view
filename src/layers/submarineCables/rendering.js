import { fromDegrees, fromRadians } from '../../geo/ellipsoid.js';
import { horizonFrom } from '../../geo/horizon.js';
import { densifyRhumb } from '../../geo/rhumb.js';
import { distance, toRadians } from '../../geo/vector.js';
import { cssColor } from '../../render/color.js';
import { cameraOf, canvasOf, drawOf } from '../../render/rendererOf.js';
import {
  clampLabel,
  createCableOverlayEntry,
  updateCableReferenceStem,
  selectCableReferenceLabelWinners,
  cableReferencePriority,
} from './overlay.js';
import { featureLabel, featureReference, geometryParts } from './geometry.js';
import { cablePinImage } from './pin.js';
import {
  CABLE_LINE_GRANULARITY_M,
  CABLE_PIN_SIZE_PX,
  CABLE_PIN_SIZES,
} from './policy.js';

/**
 * The layer's draw sets start with this; each layer has its own
 * (`submarine-cables:1:lines`, …), so several can share a renderer. Picks
 * name them as `Hit.set`.
 */
export const CABLE_SET_PREFIX = 'submarine-cables';
let layers = 0;

const BLACK_OUTLINE = [0, 0, 0, 0.65];

/** A polygon's edges are placed along rhumb lines a degree apart at most. */
const POLYGON_GRANULARITY_M = (6378137 * Math.PI) / 180;

/** A renderer colour with its alpha replaced. */
const withAlpha = (color, alpha) => [color[0], color[1], color[2], alpha];

/** A feature's CSS colour property, or null when absent or unreadable. */
const propColor = (value) =>
  value === undefined || value === null ? null : cssColor(String(value));

/** Whether a GeoJSON property is set, as the GeoJSON loader asked. */
const given = (value) => value !== undefined && value !== null;

/**
 * How a line draws. A cable with a reference takes the cable's own colour
 * (or the base colour) and one width, whatever the feature asks; every other
 * line keeps the GeoJSON styling it always had: the source's colour,
 * overridable by the feature's simplestyle `stroke`, `stroke-opacity` and
 * `stroke-width`, draped on every surface.
 */
function lineStyle(props, cable, styled, baseColor) {
  if (cable && styled) {
    const color = propColor(props.color) ?? baseColor;
    return {
      widthPx: 2.5,
      style: { kind: 'solid', color: withAlpha(color, 0.92) },
    };
  }
  return {
    widthPx: props['stroke-width'] ?? 2,
    clampTo: 'both',
    style: { kind: 'solid', color: strokeColor(props, cable, baseColor) },
  };
}

/** A line's or raised polygon's simplestyle stroke colour. */
function strokeColor(props, cable, baseColor) {
  let color = given(props.stroke) ? propColor(props.stroke) : null;
  const opacity = props['stroke-opacity'];
  if (given(opacity) && opacity !== 1)
    color = withAlpha(
      color ?? withAlpha(baseColor, cable ? 0.95 : 0.9),
      opacity,
    );
  return color ?? withAlpha(baseColor, cable ? 0.95 : 0.9);
}

/**
 * A polygon's fill, as GeoJSON polygons were filled: simplestyle `fill`
 * takes the source's fill alpha, and `fill-opacity` replaces it.
 */
function polygonFill(props, cable, baseColor) {
  const alpha = cable ? 0.18 : 0.35;
  let color = given(props.fill) ? propColor(props.fill) : null;
  if (color) color = withAlpha(color, alpha);
  const opacity = props['fill-opacity'];
  if (given(opacity) && opacity !== alpha)
    color = withAlpha(color ?? withAlpha(baseColor, alpha), opacity);
  return color ?? withAlpha(baseColor, alpha);
}

/** A finite `[lon, lat, height?]`, or null. */
function lonLat(coordinate) {
  if (!Array.isArray(coordinate) || coordinate.length < 2) return null;
  const lon = Number(coordinate[0]);
  const lat = Number(coordinate[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return { lon: toRadians(lon), lat: toRadians(lat) };
}

/** A path's points along rhumb lines, as ECEF, the way GeoJSON drew them. */
function rhumbPath(coordinates, granularity = CABLE_LINE_GRANULARITY_M) {
  const points = [];
  for (const coordinate of coordinates ?? []) {
    const point = lonLat(coordinate);
    if (point) points.push(point);
  }
  return densifyRhumb(points, granularity).map((p) =>
    fromRadians(p.lon, p.lat),
  );
}

export function createRendering({ state }) {
  /** Make the layer's draw sets on the viewer's renderer (once). */
  function attach(viewer) {
    if (state._sets || !viewer) return;
    const draw = drawOf(viewer);
    const prefix = `${CABLE_SET_PREFIX}:${++layers}`;
    const show = state._enabled;
    state._sets = {
      lines: draw.lines({
        id: `${prefix}:lines`,
        clampTo: state._clampTo,
        show,
      }),
      fills: draw.shapes({ id: `${prefix}:fills`, clampTo: 'both', show }),
      // Pins cull past the horizon each frame, as the sweep culled them;
      // the globe hides them there anyway.
      pins: draw.icons({
        id: `${prefix}:pins`,
        clampTo: 'both',
        blend: 'translucent',
        horizonCull: true,
        show,
      }),
      stems: draw.lines({ id: `${prefix}:stems`, show }),
      references: draw.points({
        id: `${prefix}:references`,
        blend: 'translucent',
        show,
      }),
    };
    state._setIds = new Set(Object.values(state._sets).map((set) => set.id));
    state._picks = new Map([...state._setIds].map((id) => [id, new Map()]));
  }

  /** Dispose the draw sets (destroy); `attach` makes new ones. */
  function detach() {
    if (!state._sets) return;
    for (const set of Object.values(state._sets)) set.dispose();
    state._sets = null;
    state._setIds = new Set();
    state._picks = new Map();
  }

  function resetPublishSignature() {
    state._lastPublishedIds.length = 0;
    state._lastPublishedPriorities.length = 0;
    state._lastPublishedCount = -1;
  }

  /**
   * Clear the draw sets and forget the built items. Hiding them is NOT
   * enough: thousands of hidden lines and markers keep costing memory long
   * after the user toggled the layer off — that is the "everything gets
   * sluggish after I turn layers off" report. The fetched JSON stays
   * cached, so the next enable rebuilds without a network round trip or a
   * re-parse.
   */

  /**
   * Forget what was drawn; `clearSets: false` (destroy, where `detach`
   * disposes the sets next) leaves the sets alone.
   */
  function releaseDrawing({ clearSets = true } = {}) {
    state._referenceRecords = [];
    state._surfaceItems = [];
    state._referenceLabelCount = 0;
    state._publishScratch.length = 0;
    state._loaded = false;
    state._referenceSweepGate.reset();
    if (!state._sets) return;
    if (clearSets) for (const set of Object.values(state._sets)) set.clear();
    for (const picks of state._picks.values()) picks.clear();
  }

  function updateVisibility() {
    if (!state._sets) return;
    for (const set of Object.values(state._sets)) set.show = state._enabled;
  }

  /**
   * Re-drape every cable ground line for the active surface. One ground
   * rebuild per stack switch — never per frame.
   * @param {'tiles'|'terrain'|'both'} next
   */

  function applyCableClassification(next) {
    if (next === undefined || next === state._clampTo) return;
    state._clampTo = next;
    state._sets?.lines.setOptions({ clampTo: next });
  }

  /**
   * The items one source's features draw, by set: lines, fills and pins,
   * each culled by its feature's reference, and a reference stem and point
   * per feature. `kind` is `cable` or `landing-point`.
   */
  function buildFeatures(features, kind, out) {
    const cable = kind === 'cable';
    const baseColor = cssColor(cable ? state.cableColor : state.landingColor);
    features.forEach((feature, index) => {
      // A feature with no reference still draws, as the GeoJSON loader drew
      // it: unstyled, not picked and never culled.
      const reference = featureReference(feature);
      const label = featureLabel(feature);
      const info = reference && {
        kind,
        reference,
        label,
        featureId: feature?.id || feature?.properties?.id || null,
      };
      const base = reference && fromDegrees(reference.lon, reference.lat, 0);
      const keep = (set, item) => {
        if (!reference) return;
        out.picks[set].set(item.id, info);
        if (set !== 'pins') out.surface.push({ set, item, base });
      };
      const props = feature?.properties || {};
      const parts = geometryParts(feature.geometry);
      const key = `${kind}:${index}`;
      parts.lines.forEach((coordinates, part) => {
        const positions = rhumbPath(coordinates);
        if (positions.length < 2) return;
        const item = {
          id: `${key}:line:${part}`,
          positions,
          mode: 'draped',
          ...lineStyle(props, cable, Boolean(reference), baseColor),
          show: true,
        };
        out.lines.push(item);
        keep('lines', item);
      });
      parts.polygons.forEach((rings, part) => {
        const fill = polygonFill(props, cable, baseColor);
        // Polygons with heights stand at them, outlined, as the GeoJSON
        // loader drew them; flat ones lie on the surface, edges along
        // rhumb lines.
        const raised = rings[0]?.[0]?.length > 2;
        const drawn = rings
          .map((ring) =>
            raised
              ? ring
                  .filter((coordinate) => lonLat(coordinate))
                  .map(([lon, lat, height]) =>
                    fromDegrees(Number(lon), Number(lat), Number(height) || 0),
                  )
              : rhumbPath(ring, POLYGON_GRANULARITY_M).map((p) => ({
                  x: p.x,
                  y: p.y,
                  z: p.z,
                })),
          )
          .filter((ring) => ring.length >= 3);
        if (!drawn.length) return;
        const item = {
          id: `${key}:fill:${part}`,
          geometry: raised
            ? { kind: 'polygon', rings: drawn, perPositionHeight: true }
            : { kind: 'polygon', rings: drawn },
          fill,
          ...(raised
            ? {
                height: 'absolute',
                // WebGL draws the loader's outline one pixel wide.
                outline: strokeColor(props, cable, baseColor),
                outlineWidth: 1,
              }
            : { height: 'clampGround' }),
          show: true,
        };
        out.fills.push(item);
        keep('fills', item);
      });
      parts.points.forEach((coordinate, part) => {
        const point = lonLat(coordinate);
        if (!point) return;
        const color =
          (given(props['marker-color']) && cssColor(props['marker-color'])) ||
          baseColor;
        const size = CABLE_PIN_SIZES[props['marker-size']] ?? CABLE_PIN_SIZE_PX;
        const raised =
          coordinate.length > 2 && Number.isFinite(Number(coordinate[2]));
        const item = {
          id: `${key}:pin:${part}`,
          pos: {
            lon: Number(coordinate[0]),
            lat: Number(coordinate[1]),
            height: raised ? Number(coordinate[2]) : 0,
          },
          height: raised ? 'absolute' : 'clampGround',
          image: cablePinImage(color, size),
          size: [size, size],
          anchor: 'bottom',
        };
        out.pins.push(item);
        keep('pins', item);
      });
      if (!reference) return;
      addReference(out, {
        reference,
        label,
        kind,
        color: baseColor,
        info,
        base,
      });
    });
  }

  function addReference(out, { reference, label, kind, color, info, base }) {
    const cable = kind === 'cable';
    const tip = fromDegrees(reference.lon, reference.lat, 2500);
    const id = `${kind}-reference-${out.references.length}-${info.featureId || 'feature'}`;
    const record = {
      id,
      base,
      // Moved in place: the overlay entry anchors to this object.
      tip,
      reference,
      kind,
      label: clampLabel(label),
      visible: true,
      distanceM: Infinity,
      entry: null,
      stem: {
        id,
        positions: [base, { ...tip }],
        widthPx: cable ? 2 : 2.4,
        mode: '3d',
        style: {
          kind: 'solid',
          color: withAlpha(color, cable ? 0.58 : 0.68),
        },
        show: true,
      },
      point: {
        id,
        pos: { ...tip },
        pixelSize: cable ? 7 : 8,
        color: withAlpha(color, cable ? 0.84 : 0.94),
        outlineColor: BLACK_OUTLINE,
        outlineWidth: 1,
        show: true,
      },
    };
    record.entry = createCableOverlayEntry(record);
    out.references.push(record);
    out.picks.stems.set(id, info);
    out.picks.references.set(id, info);
  }

  /**
   * Draw both sources' features, replacing what was drawn. Items start
   * culled for the camera as it is, so the first sweep has nothing to redo.
   */
  function drawFeatures(cableFeatures, landingFeatures) {
    const out = {
      lines: [],
      fills: [],
      pins: [],
      references: [],
      surface: [],
      picks: {
        lines: new Map(),
        fills: new Map(),
        pins: new Map(),
        stems: new Map(),
        references: new Map(),
      },
    };
    buildFeatures(cableFeatures, 'cable', out);
    buildFeatures(landingFeatures, 'landing-point', out);
    state._referenceRecords = out.references;
    state._surfaceItems = out.surface;
    sweep({ draw: false });
    if (!state._sets) return;
    const sets = state._sets;
    for (const [name, picks] of Object.entries(out.picks)) {
      const map = state._picks.get(sets[name].id);
      map.clear();
      for (const [id, info] of picks) map.set(id, info);
    }
    sets.lines.set(out.lines);
    sets.fills.set(out.fills);
    sets.pins.set(out.pins);
    sets.stems.set(out.references.map((record) => record.stem));
    sets.references.set(out.references.map((record) => record.point));
  }

  /** What a pick on one of the layer's sets names, or null. */
  function pickInfo(hit) {
    if (!hit || !state._setIds.has(hit.set)) return null;
    return state._picks.get(hit.set)?.get(hit.id) ?? null;
  }

  /**
   * One sweep: cull references and surface items by whether their
   * reference is past the horizon, re-size visible stems, and redraw only
   * what changed (`draw: false` changes the items without drawing them).
   * Returns false when there is no camera to sweep from.
   */
  function sweep({ draw = true } = {}) {
    const viewer = state._viewer;
    if (!viewer) return false;
    const pose = cameraOf(viewer).pose();
    const cameraPos = pose?.position;
    if (!cameraPos) return false;
    const canvasHeight = canvasOf(viewer)?.clientHeight || 1080;
    // The field of view along the canvas's longer side.
    const fov =
      pose.aspectRatio > 1
        ? 2 * Math.atan(Math.tan(pose.fovy / 2) * pose.aspectRatio)
        : pose.fovy;
    const horizon = horizonFrom(cameraPos);
    const stems = [];
    const points = [];
    for (const record of state._referenceRecords) {
      const visible = horizon.isPointVisible(record.base);
      const flipped = record.visible !== visible;
      record.visible = visible;
      record.distanceM = distance(cameraPos, record.base);
      // Hidden stems keep their last geometry; this same sweep refreshes them
      // in the pass where they turn visible again.
      const moved =
        visible &&
        updateCableReferenceStem(record, cameraPos, canvasHeight, fov);
      if (!flipped && !moved) continue;
      record.stem.positions = [record.base, { ...record.tip }];
      record.stem.show = visible;
      record.point.pos = { ...record.tip };
      record.point.show = visible;
      stems.push(record.stem);
      points.push(record.point);
    }
    const surface = { lines: [], fills: [] };
    for (const entry of state._surfaceItems) {
      const visible = horizon.isPointVisible(entry.base);
      if (entry.item.show === visible) continue;
      entry.item.show = visible;
      surface[entry.set].push(entry.item);
    }
    if (draw && state._sets) {
      if (stems.length) state._sets.stems.upsert(stems);
      if (points.length) state._sets.references.upsert(points);
      if (surface.lines.length) state._sets.lines.upsert(surface.lines);
      if (surface.fills.length) state._sets.fills.upsert(surface.fills);
    }
    return true;
  }

  function updateReferenceVisibility() {
    if (!state._enabled || !state._viewer) return;
    if (!sweep()) return;
    const winners = selectCableReferenceLabelWinners(state._referenceRecords);
    let changed = winners.length !== state._lastPublishedCount;
    for (let i = 0; i < winners.length; i++) {
      const record = winners[i];
      const priority = cableReferencePriority(record.distanceM);
      record.entry.priority = priority;
      state._publishScratch[i] = record.entry;
      if (
        !changed &&
        (state._lastPublishedIds[i] !== record.entry.id ||
          state._lastPublishedPriorities[i] !== priority)
      ) {
        changed = true;
      }
    }
    state._publishScratch.length = winners.length;
    state._referenceLabelCount = winners.length;
    if (!changed) return;
    state._overlayPublisher.publish(state._publishScratch);
    state._lastPublishedCount = winners.length;
    for (let i = 0; i < winners.length; i++) {
      state._lastPublishedIds[i] = state._publishScratch[i].id;
      state._lastPublishedPriorities[i] = state._publishScratch[i].priority;
    }
    state._lastPublishedIds.length = winners.length;
    state._lastPublishedPriorities.length = winners.length;
  }
  return {
    attach,
    detach,
    resetPublishSignature,
    releaseDrawing,
    updateVisibility,
    applyCableClassification,
    drawFeatures,
    pickInfo,
    updateReferenceVisibility,
  };
}
