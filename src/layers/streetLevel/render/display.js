// Street Level on the globe contract (engine.ground, engine.movers,
// engine.surface, engine.projector, engine.camera), the same on every
// engine. What the layer core and its providers draw through it:
// - coverage: sequence lines as engine.ground corridors in CSS pixels,
//   draped on terrain and 3D tiles alike, every part of a sequence picking
//   it; sets of at most 120 lines, so a dense tile shows in parts;
// - the position marker and the selected sequence's image cones: sprite
//   movers, one set per glyph, on the ground under them, drawn over the
//   scene, hidden behind the horizon of an ellipsoid 1 km under WGS84
//   (ground can lie below WGS84, and the camera with it) and turned to
//   their compass bearing on screen.
// Picks and the camera stay with the core (../selection.js, ../view.js),
// on the same engine (`display.engine`).
//
// The contract has no ground clamping for sprites: a sprite sits on the
// terrain, or under Google 3D on the rendered tiles, measured on screen a
// few per pass and again after moves and tile loads
// (../../../globe/surfacePlacement.js).

import * as geo from '../../../geo/index.js';
import { rgbaFromCss } from '../../shared/color.js';
import {
  createSurfacePoints,
  readSurface,
} from '../../../globe/surfacePlacement.js';

/** Lines per ground set: smaller sets build, and show, sooner. */
export const SEQUENCE_LINE_BATCH = 120;
/** Below this the projected bearing is noise (straight into the screen). */
const MIN_SCREEN_COMPONENT = 1e-3;
const WHITE = Object.freeze([1, 1, 1, 1]);
/**
 * Horizon occluder depth below WGS84 (m): ground can lie below the ellipsoid
 * (NYC −22 m), and an occluder at 0 m would hide the cones around it.
 */
const HORIZON_CULL_DEPTH_M = 1000;
const HORIZON_OPTIONS = Object.freeze({
  ellipsoid: geo.ellipsoid.create(
    geo.ellipsoid.WGS84.radii.x - HORIZON_CULL_DEPTH_M,
    geo.ellipsoid.WGS84.radii.y - HORIZON_CULL_DEPTH_M,
    geo.ellipsoid.WGS84.radii.z - HORIZON_CULL_DEPTH_M,
  ),
});

const finitePoint = (point) =>
  Array.isArray(point) &&
  Number.isFinite(point[0]) &&
  Number.isFinite(point[1]) &&
  Math.abs(point[1]) <= 90;

/** `css` (#rrggbb[aa]) as rgba in 0..1, its alpha replaced by `alpha` when given. */
export function lineColor(css, alpha) {
  const rgba = rgbaFromCss(css);
  return [rgba.red, rgba.green, rgba.blue, alpha ?? rgba.alpha];
}

const scratchEnu = geo.matrix4.create();
const scratchLocal = geo.cartesian3.create();
const scratchWorld = geo.cartesian3.create();

/**
 * A sprite's screen rotation (radians, counter-clockwise from screen up)
 * that points it along `bearingDeg` (clockwise from north) at `position`:
 * the local course vector on the camera's right and up axes, or `previous`
 * when it points into the screen.
 */
export function screenRotation(position, bearingDeg, pose, previous = 0) {
  const course = geo.math.toRadians(bearingDeg || 0);
  geo.transforms.eastNorthUpToFixedFrame(
    position,
    geo.ellipsoid.WGS84,
    scratchEnu,
  );
  geo.cartesian3.fromElements(
    Math.sin(course),
    Math.cos(course),
    0,
    scratchLocal,
  );
  geo.matrix4.multiplyByPointAsVector(scratchEnu, scratchLocal, scratchWorld);
  const x = geo.cartesian3.dot(scratchWorld, pose.right);
  const y = geo.cartesian3.dot(scratchWorld, pose.up);
  if (x * x + y * y < MIN_SCREEN_COMPONENT * MIN_SCREEN_COMPONENT)
    return previous;
  return Math.atan2(-x, y);
}

/**
 * @param {import('../../../globe/contract.js').GlobeEngine} engine
 */
export function createStreetLevelDisplay(engine) {
  /** Live sprite groups and line handles, for destroy(). */
  const live = new Set();
  let serial = 0;

  /**
   * A group of sprites, each `{ pickId, lon, lat, bearing, image, imageKey,
   * sizePx, scaleByDistance? }`: one sprite set per `imageKey`, at `order`
   * among the engine's sets.
   * @param {string} id
   * @param {{ order?: number }} [options]
   */
  function sprites(id, { order = 0 } = {}) {
    const rows = new Set();
    /** imageKey → { bank, capacity } */
    const banks = new Map();
    let visible = true;
    let dirty = true;
    let lastPose = '';
    let surfaceGroups = [];
    let placementPending = true;
    let destroyed = false;

    const wake = () => {
      if (destroyed) return;
      dirty = true;
      engine.render.request(id);
    };
    const ownSets = () => [...banks.values()].map(({ bank }) => bank);

    // Rows change their instance index: a placement pass still queued must
    // not write by the old one.
    function changed() {
      placementPending = true;
      surfaceGroups = [];
      wake();
    }

    // On the loaded terrain until measured: a sprite off screen waits for
    // its measure, and a camera move can bring it into view first.
    function locate(row) {
      row.cartographic = geo.cartographic.fromDegrees(row.lon, row.lat);
      const terrain = readSurface(engine, row.cartographic, {
        prefer: 'terrain',
      });
      row.position = geo.cartesian3.fromDegrees(
        row.lon,
        row.lat,
        Number.isFinite(terrain) ? terrain : 0,
      );
      delete row.surfaceHeight;
      delete row.surfaceRevision;
    }

    function bankFor(key, first, count) {
      let record = banks.get(key);
      if (record && record.capacity >= count) return record.bank;
      record?.bank.destroy();
      const capacity = Math.max(1, count);
      const bank = engine.movers.createSet({
        id: `${id}:${key}`,
        kind: 'sprite',
        capacity,
        order,
        depthTest: 'always',
        pickable: true,
        sprite: {
          sizePx: first.sizePx,
          atlas: { url: first.image, cells: { glyph: [0, 0, 1, 1] } },
          ...(first.scaleByDistance
            ? { scaleByDistance: first.scaleByDistance }
            : {}),
        },
      });
      banks.set(key, { bank, capacity });
      return bank;
    }

    function paint() {
      if (destroyed) return;
      if (!rows.size && !dirty) return;
      const pose = engine.camera.pose();
      const signature = [
        pose.position.x,
        pose.position.y,
        pose.position.z,
        pose.heading,
        pose.pitch,
        pose.roll,
      ].join('/');
      if (!dirty && signature === lastPose) return;
      lastPose = signature;
      const groups = new Map();
      if (visible)
        for (const row of rows) {
          if (!groups.has(row.imageKey)) groups.set(row.imageKey, []);
          groups.get(row.imageKey).push(row);
        }
      // Hidden, a set draws nothing and keeps its atlas; a glyph no row
      // uses any more goes.
      for (const [key, record] of banks) {
        if (groups.has(key)) continue;
        if (visible) {
          record.bank.destroy();
          banks.delete(key);
        } else if (record.bank.count()) {
          record.bank.setCount(0);
          record.bank.commit();
        }
      }
      if (placementPending) {
        placementPending = false;
        surfaceGroups = [...groups].map(([key, points]) => ({
          set: bankFor(key, points[0], points.length),
          points,
        }));
        const exclude = ownSets();
        for (const group of surfaceGroups) group.exclude = exclude;
        surface.place();
      }
      dirty = false;
      for (const [key, group] of groups) {
        const bank = bankFor(key, group[0], group.length);
        group.forEach((row, index) => {
          row.rotation = screenRotation(
            row.position,
            row.bearing,
            pose,
            row.rotation,
          );
          bank.set(index, {
            position: row.position,
            rotation: row.rotation,
            color: WHITE,
            cell: 'glyph',
            pickId: row.pickId,
            show: engine.projector.horizonVisible(
              row.position,
              HORIZON_OPTIONS,
            ),
          });
        });
        bank.setCount(group.length);
        bank.commit();
      }
    }

    const removePaint = engine.frames.preRender.addEventListener(paint);
    const surface = createSurfacePoints(engine, {
      groups: () => surfaceGroups,
      request: wake,
      estimateGround: true,
    });
    const group = {
      /** Adds a sprite; the returned row is its handle. */
      add(spec) {
        const row = { ...spec, rotation: 0 };
        locate(row);
        rows.add(row);
        changed();
        return row;
      },
      /** Moves or turns a sprite (`lon`, `lat`, `bearing`). */
      move(row, { lon = row.lon, lat = row.lat, bearing = row.bearing } = {}) {
        if (!rows.has(row)) return;
        const moved = lon !== row.lon || lat !== row.lat;
        Object.assign(row, { lon, lat, bearing });
        if (moved) locate(row);
        changed();
      },
      remove(row) {
        if (rows.delete(row)) changed();
      },
      removeAll() {
        rows.clear();
        changed();
      },
      show(value) {
        visible = value !== false;
        changed();
      },
      shown: () => visible,
      count: () => rows.size,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        removePaint();
        surface.destroy();
        for (const { bank } of banks.values()) bank.destroy();
        banks.clear();
        rows.clear();
        live.delete(group);
        engine.render.request(id);
      },
    };
    live.add(group);
    return group;
  }

  /**
   * Sequence lines draped on the ground: every part of every sequence as a
   * corridor `widthPx` wide in the CSS `color` (at `alpha` when given),
   * picking `pickPrefix` + its id. Null when nothing is drawable; else a
   * handle to destroy.
   * @param {Array<{id: string, parts: Array<Array<[number, number]>>}>} sequences
   * @param {{ id: string, color: string, alpha?: number, widthPx: number, pickPrefix: string, order?: number }} style
   */
  function sequenceLines(
    sequences,
    { id, color: css, alpha, widthPx, pickPrefix, order },
  ) {
    const color = lineColor(css, alpha);
    const items = [];
    for (const sequence of sequences)
      for (const part of sequence.parts || []) {
        // A part with a bad point is skipped; the others still draw.
        if (!Array.isArray(part) || part.length < 2) continue;
        if (!part.every(finitePoint)) continue;
        items.push({
          positions: part,
          color,
          widthPx,
          pickId: `${pickPrefix}${sequence.id}`,
        });
      }
    if (!items.length) return null;
    const sets = [];
    const base = `${id}#${serial++}`;
    for (let at = 0; at < items.length; at += SEQUENCE_LINE_BATCH) {
      const set = engine.ground.createSet({
        id: `${base}:${sets.length}`,
        kind: 'corridor',
        order,
        pickable: true,
        drape: 'both',
      });
      sets.push(set);
      set.replace(items.slice(at, at + SEQUENCE_LINE_BATCH));
      set.commit();
    }
    const handle = {
      /** Ground set ids, in draw order. */
      ids: () => sets.map((set) => set.id),
      count: () => items.length,
      destroy() {
        if (!live.delete(handle)) return;
        for (const set of sets) set.destroy();
        engine.render.request(id);
      },
    };
    live.add(handle);
    return handle;
  }

  return {
    engine,
    sprites,
    sequenceLines,
    /** Everything still drawn goes. */
    destroy() {
      for (const item of [...live]) item.destroy();
    },
  };
}
