import { bindOverlayHost } from '../../../overlays/bindOverlayHost.js';
// The submarine cables on the globe contract, the same on every engine:
// - cable paths: one engine.ground corridor set (2.5 px, each cable's own
//   colour at 0.92), draped on the active map stack's surface;
// - landing points: a point mover set on the sampled surface (the 6 px
//   GeoJSON pin's width and colour);
// - references: per cable and landing point, a tip point mover high enough
//   for a ~66 px stem, sized on the sweep cadence, with its label on the
//   shared world-overlay host;
// - stems: engine.lines from the base to the tip, for the label winners
//   (at most CABLE_REFERENCE_LABEL_WINNER_CAP).
// Clicks on any of them fly to the reference.

import * as geo from '../../../geo/index.js';
import { isPointerFree } from '../../../data/inputOwnership.js';
import { rgbaFromCss } from '../../shared/color.js';
import { createSurfacePoints } from '../../../globe/surfacePlacement.js';
import {
  featureLabel,
  featureReference,
  normalizeFeatures,
} from '../geometry.js';
import {
  BASE_CABLE_COLOR,
  BASE_LANDING_COLOR,
  CABLE_OVERLAY_SOURCE_ID as ID,
  defaultSweepClock,
} from '../policy.js';
import {
  cableReferencePriority,
  clampLabel,
  createCableOverlayEntry,
  createCableOverlayPublisher,
  createCableReferenceSweepGate,
  selectCableReferenceLabelWinners,
  updateCableReferenceTip,
} from '../overlay.js';
import { cableDrapeForEngine, cableDrapeForStack } from '../surface.js';

const TIP_HEIGHT_M = 2500;
const OUTLINE = [0, 0, 0, 0.65];
const color = (css, alpha) => {
  const rgba = rgbaFromCss(css);
  return [rgba.red, rgba.green, rgba.blue, alpha];
};
// A feature's own CSS colour, else the base cable colour.
const featureColor = (feature, alpha) => {
  const css = feature?.properties?.color;
  if (css)
    try {
      return color(String(css), alpha);
    } catch {
      /* not a hex colour: the base colour */
    }
  return color(BASE_CABLE_COLOR, alpha);
};

// What each kind draws, as Cesium drew the GeoJSON entities and references:
// a cable path at its feature colour (0.92, 2.5 px) and a landing point's
// path at the GeoJSON stroke (0.9, 2 px); point geometry as the 6 px GeoJSON
// pin, here a disc of the pin's ~4 px width in the marker colour; the
// reference tip and stem at the kind's colour.
const KINDS = Object.freeze({
  cable: {
    path: (feature) => ({ color: featureColor(feature, 0.92), widthPx: 2.5 }),
    marker: color(BASE_CABLE_COLOR, 1),
    tip: { sizePx: 7, color: color(BASE_CABLE_COLOR, 0.84) },
    stem: { widthPx: 2, color: color(BASE_CABLE_COLOR, 0.58) },
  },
  'landing-point': {
    path: () => ({ color: color(BASE_LANDING_COLOR, 0.9), widthPx: 2 }),
    marker: color(BASE_LANDING_COLOR, 1),
    tip: { sizePx: 8, color: color(BASE_LANDING_COLOR, 0.94) },
    stem: { widthPx: 2.4, color: color(BASE_LANDING_COLOR, 0.68) },
  },
});
const MARKER_PX = 4;

const finitePair = (pair) =>
  Array.isArray(pair) &&
  Number.isFinite(Number(pair[0])) &&
  Number.isFinite(Number(pair[1])) &&
  Math.abs(Number(pair[1])) <= 90;

const lonLat = ([lon, lat]) => [Number(lon), Number(lat)];

/** A geometry's paths (lines) and points, as [lon, lat] number pairs. */
function shapesOf(geometry) {
  const paths = [];
  const points = [];
  const add = (type, coordinates) => {
    if (!Array.isArray(coordinates)) return;
    if (type === 'Point') {
      if (finitePair(coordinates)) points.push(lonLat(coordinates));
    } else if (type === 'MultiPoint') {
      for (const point of coordinates)
        if (finitePair(point)) points.push(lonLat(point));
    } else if (type === 'LineString') {
      const path = coordinates.filter(finitePair).map(lonLat);
      if (path.length > 1) paths.push(path);
    } else if (type === 'MultiLineString') {
      for (const line of coordinates) add('LineString', line);
    }
  };
  if (geometry?.type === 'GeometryCollection')
    for (const part of geometry.geometries ?? [])
      add(part?.type, part?.coordinates);
  else add(geometry?.type, geometry?.coordinates);
  return { paths, points };
}

/**
 * Cesium's PerspectiveFrustum.fov: the horizontal angle on a wide canvas,
 * the vertical one on a tall canvas (what the stem sizing reads).
 */
function frustumFov({ fovy, aspectRatio }) {
  const aspect = aspectRatio ?? 1;
  return aspect > 1 ? 2 * Math.atan(Math.tan(fovy / 2) * aspect) : fovy;
}

/**
 * @param {import('../../../globe/contract.js').GlobeEngine} engine
 * @param {{ overlayHost: object, mapStackEventTarget?: EventTarget | null,
 *   sweepClock?: () => number }} options
 *   `mapStackEventTarget` raises 'gev:map-stack-changed' (the window).
 * @returns {{ show: (dataset: object) => void, hide: () => void,
 *   destroy: () => void, stats: () => { referenceLabelCount: number } }}
 */
export function createCablesDisplay(
  engine,
  {
    overlayHost,
    mapStackEventTarget = null,
    sweepClock = defaultSweepClock,
  } = {},
) {
  const publisher = createCableOverlayPublisher({
    host: bindOverlayHost(overlayHost, () => engine),
  });
  const gate = createCableReferenceSweepGate({ now: sweepClock });
  // Reference records by id (their pickId), in creation order.
  const records = new Map();
  // Drawn object ids (sets and lines) whose picks are cables.
  const owners = new Set();
  // record id → its stem, while the record is a label winner.
  const stems = new Map();
  let stemBatch = null;
  const tipSets = new Map();
  const removers = [];
  let dataset = null;
  let paths = null;
  let pathItems = [];
  let markers = null;
  let markerRows = [];
  let drape = cableDrapeForEngine(engine);
  let destroyed = false;
  let referenceLabelCount = 0;
  let lastIds = [];
  let lastPriorities = [];
  let lastCount = -1;
  const scratchCamera = { positionWC: null };

  const wake = () => engine.render.request(ID);

  function resetSignature() {
    lastIds = [];
    lastPriorities = [];
    lastCount = -1;
  }

  function buildPaths() {
    paths?.destroy();
    owners.delete(`${ID}-paths`);
    paths = null;
    if (!pathItems.length) return;
    paths = engine.ground.createSet({
      id: `${ID}-paths`,
      kind: 'corridor',
      pickable: true,
      drape,
    });
    owners.add(paths.id);
    paths.replace(pathItems);
    paths.commit();
  }

  function setDrape(next) {
    if (next === drape) return;
    drape = next;
    if (dataset) buildPaths();
  }

  // The reference sweep, on the gate's cadence: horizon visibility,
  // distances, tip heights, the label cohort and the winners' stems.
  function sweep() {
    if (!dataset) return;
    const position = engine.camera.livePosition;
    scratchCamera.positionWC = position;
    if (!gate.shouldRun(scratchCamera)) return;
    const height = engine.host.size().height || 1080;
    const fov = frustumFov(engine.camera.pose());
    const tipIndex = new Map();
    for (const record of records.values()) {
      const visible = engine.projector.horizonVisible(record.base);
      record.visible = visible;
      record.distanceM = geo.cartesian3.distance(position, record.base);
      // Hidden tips keep their last height; the sweep that shows them again
      // re-sizes them.
      if (visible) updateCableReferenceTip(record, position, height, fov);
      const set = tipSets.get(record.kind);
      const index = tipIndex.get(record.kind) ?? 0;
      tipIndex.set(record.kind, index + 1);
      set.set(index, { position: record.tip, show: visible });
    }
    for (const set of tipSets.values()) set.commit();
    if (markers) {
      markerRows.forEach((row, index) => {
        row.show = engine.projector.horizonVisible(row.base);
        markers.set(index, { show: row.show });
      });
      markers.commit();
    }
    const winners = selectCableReferenceLabelWinners([...records.values()]);
    referenceLabelCount = winners.length;
    const winning = new Set(winners.map((record) => record.id));
    let stemsChanged = false;
    for (const id of [...stems.keys()])
      if (!winning.has(id)) {
        stems.delete(id);
        stemsChanged = true;
      }
    for (const record of winners) {
      const stem = stems.get(record.id);
      if (stem && geo.cartesian3.equals(stem.tip, record.tip)) continue;
      stems.set(record.id, {
        ...KINDS[record.kind].stem,
        base: record.base,
        tip: geo.cartesian3.clone(record.tip),
        pickId: record.id,
      });
      stemsChanged = true;
    }
    if (stemsChanged) {
      if (!stemBatch) {
        stemBatch = engine.lines.createSegments({
          id: `${ID}-stems`,
          widthPx: 2,
          color: [1, 1, 1, 1],
        });
        owners.add(`${ID}-stems`);
      }
      stemBatch.replace(
        [...stems.values()].map(({ base, tip, ...style }) => ({
          ...style,
          positions: [base, tip],
        })),
      );
      stemBatch.commit();
    }
    let changed = winners.length !== lastCount;
    const entries = winners.map((record, index) => {
      const priority = cableReferencePriority(record.distanceM);
      record.entry.priority = priority;
      if (
        !changed &&
        (lastIds[index] !== record.entry.id ||
          lastPriorities[index] !== priority)
      )
        changed = true;
      return record.entry;
    });
    if (!changed) return;
    publisher.publish(entries);
    lastCount = entries.length;
    lastIds = entries.map((entry) => entry.id);
    lastPriorities = entries.map((entry) => entry.priority);
  }

  function flyTo(reference) {
    engine.camera.flyTo({
      destination: geo.cartesian3.fromDegrees(
        reference.lon,
        reference.lat,
        6500,
      ),
      orientation: {
        heading: engine.camera.pose().heading || 0,
        pitch: geo.math.toRadians(-52),
        roll: 0,
      },
      duration: 1.35,
      easing: 'cubicInOut',
    });
  }

  function onClick(event) {
    // A tool owns the pointer (src/data/inputOwnership.js): yield the click.
    if (!isPointerFree()) return;
    const picked = event.picked;
    if (!dataset || !picked || !owners.has(picked.owner)) return;
    const record = records.get(picked.id);
    if (record?.reference) flyTo(record.reference);
  }

  function hide() {
    for (const remove of removers.splice(0)) remove();
    paths?.destroy();
    paths = null;
    markers?.destroy();
    markers = null;
    for (const set of tipSets.values()) set.destroy();
    tipSets.clear();
    stems.clear();
    stemBatch?.destroy();
    stemBatch = null;
    owners.clear();
    records.clear();
    pathItems = [];
    markerRows = [];
    dataset = null;
    referenceLabelCount = 0;
    resetSignature();
    gate.reset();
    publisher.hide();
    wake();
  }

  function build(next) {
    const byKind = [
      ['cable', normalizeFeatures(next.cables, 'cable')],
      ['landing-point', normalizeFeatures(next.landingPoints, 'landing')],
    ];
    const items = [];
    const rows = [];
    for (const [kind, features] of byKind) {
      const style = KINDS[kind];
      for (const feature of features) {
        const reference = featureReference(feature);
        if (!reference) continue;
        const featureId = feature?.id || feature?.properties?.id || 'feature';
        const id = `${kind}-reference-${records.size}-${featureId}`;
        const base = geo.cartesian3.fromDegrees(reference.lon, reference.lat);
        const tip = geo.cartesian3.fromDegrees(
          reference.lon,
          reference.lat,
          TIP_HEIGHT_M,
        );
        const record = {
          id,
          kind,
          reference,
          label: clampLabel(featureLabel(feature)),
          featureId,
          base,
          tip,
          nextTip: geo.cartesian3.clone(tip),
          visible: false,
          distanceM: Infinity,
          entry: null,
        };
        record.entry = createCableOverlayEntry(record);
        records.set(id, record);
        const shapes = shapesOf(feature.geometry);
        for (const positions of shapes.paths)
          items.push({ positions, ...style.path(feature), pickId: id });
        for (const point of shapes.points)
          rows.push({
            cartographic: geo.cartographic.fromDegrees(point[0], point[1]),
            position: geo.cartesian3.fromDegrees(point[0], point[1]),
            base,
            color: style.marker,
            pickId: id,
          });
      }
    }
    pathItems = items;
    buildPaths();
    markerRows = rows;
    if (rows.length) {
      markers = engine.movers.createSet({
        id: `${ID}-markers`,
        kind: 'point',
        capacity: rows.length,
        depthTest: { disableWithinM: 2500 },
        pickable: true,
        point: { sizePx: MARKER_PX, outlinePx: 0 },
      });
      owners.add(`${ID}-markers`);
      rows.forEach((row, index) =>
        markers.set(index, {
          position: row.position,
          color: row.color,
          show: true,
          pickId: row.pickId,
        }),
      );
      markers.setCount(rows.length);
      markers.commit();
    }
    const counts = new Map();
    for (const record of records.values())
      counts.set(record.kind, (counts.get(record.kind) ?? 0) + 1);
    for (const [kind, count] of counts) {
      const { tip } = KINDS[kind];
      const setId = `${ID}-${kind}-tips`;
      const set = engine.movers.createSet({
        id: setId,
        kind: 'point',
        capacity: count,
        depthTest: 'normal',
        pickable: true,
        point: { sizePx: tip.sizePx, outlinePx: 1, outlineColor: OUTLINE },
      });
      owners.add(setId);
      tipSets.set(kind, set);
    }
    // Tips draw from the first sweep on: until then, hidden.
    const tipIndex = new Map();
    for (const record of records.values()) {
      const index = tipIndex.get(record.kind) ?? 0;
      tipIndex.set(record.kind, index + 1);
      tipSets.get(record.kind).set(index, {
        position: record.tip,
        color: KINDS[record.kind].tip.color,
        show: false,
        pickId: record.id,
      });
    }
    for (const [kind, set] of tipSets) {
      set.setCount(tipIndex.get(kind) ?? 0);
      set.commit();
    }
  }

  // The active map stack decides the surface the paths drape on: 3D tiles
  // on photoreal, terrain on the globe stacks, both on an unknown stack.
  const onStackChanged = (event) =>
    setDrape(
      event?.detail?.activeId
        ? cableDrapeForStack(event.detail.activeId)
        : cableDrapeForEngine(engine),
    );
  mapStackEventTarget?.addEventListener?.(
    'gev:map-stack-changed',
    onStackChanged,
  );
  const removeStackListener = () =>
    mapStackEventTarget?.removeEventListener?.(
      'gev:map-stack-changed',
      onStackChanged,
    );

  return {
    /** Draws a dataset ({ cables, landingPoints } GeoJSON collections). */
    show(next) {
      if (destroyed || next === dataset) return;
      if (dataset) hide();
      try {
        build(next);
        dataset = next;
        const surface = createSurfacePoints(engine, {
          // The reference tips and stems stand over the landing points.
          groups: () => [
            {
              set: markers,
              points: markerRows,
              exclude: [markers, stemBatch, ...tipSets.values()].filter(
                Boolean,
              ),
            },
          ],
          request: wake,
        });
        removers.push(
          surface.destroy,
          engine.input.on('click', onClick, { pick: true }),
          engine.camera.moveEnd.addEventListener(() => {
            gate.markDirty();
            wake();
          }),
          engine.frames.preRender.addEventListener(sweep),
        );
        surface.place();
        publisher.show();
        // A hide cleared the host source: an identical cohort republishes.
        resetSignature();
        gate.markDirty();
        wake();
      } catch (error) {
        hide();
        throw error;
      }
    },
    hide,
    destroy() {
      if (destroyed) return;
      hide();
      destroyed = true;
      removeStackListener();
    },
    stats: () => ({ referenceLabelCount }),
    /** The surface the cable paths drape on ('both', 'terrain', 'tiles'). */
    drape: () => drape,
  };
}
