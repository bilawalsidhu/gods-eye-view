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
// terrain, or under Google 3D on the rendered tiles (one sample each), and
// is placed again whenever the surface settles.

import * as geo from '../../../geo/index.js';
import { rgbaFromCss } from '../../shared/color.js';
import { plausibleSurfaceHeight } from '../view.js';

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
  if (!engine?.ground || !engine?.movers)
    throw new TypeError('The Street Level display needs a globe engine');
  /** Live sprite groups and line handles, for destroy(). */
  const live = new Set();
  let serial = 0;

  const tilesShown = () => engine.maps?.photorealActive?.() === true;

  /**
   * Ground height (m) under a point and whether it came from the surface
   * shown: the terrain on the globe; under Google 3D the rendered tiles
   * (`exclude`: the sprites themselves), else the terrain. Null when
   * neither answers.
   */
  function groundHeight(lon, lat, exclude) {
    const carto = geo.cartographic.fromDegrees(lon, lat);
    let terrain;
    try {
      terrain = engine.surface.terrainHeightSupported
        ? engine.surface.terrainHeight(carto)
        : undefined;
    } catch {
      terrain = undefined;
    }
    const known = Number.isFinite(terrain);
    if (!tilesShown()) return { height: known ? terrain : null, exact: known };
    let sampled;
    try {
      sampled = engine.surface.supported
        ? engine.surface.sampleHeight(carto, exclude)
        : undefined;
    } catch {
      sampled = undefined;
    }
    if (plausibleSurfaceHeight(sampled))
      return { height: sampled, exact: true };
    return { height: known ? terrain : null, exact: false };
  }

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
    let settled = null;
    let tiles = tilesShown();
    let destroyed = false;

    const wake = () => {
      if (destroyed) return;
      dirty = true;
      engine.render.request(id);
    };
    const ownSets = () => [...banks.values()].map(({ bank }) => bank);

    function place(row) {
      const { height, exact } = groundHeight(row.lon, row.lat, ownSets());
      row.position = geo.cartesian3.fromDegrees(row.lon, row.lat, height ?? 0);
      row.exact = exact;
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
      // The surface settled (or the map stack changed): place every sprite
      // again on the globe, where terrain is cheap; under tiles only the
      // ones not on them yet.
      const loaded = engine.surface.tilesLoaded();
      const nowTiles = tilesShown();
      if ((loaded && settled === false) || nowTiles !== tiles) {
        for (const row of rows)
          if (!nowTiles || !row.exact || nowTiles !== tiles) place(row);
        dirty = true;
      }
      settled = loaded;
      tiles = nowTiles;
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
      dirty = false;
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
    const group = {
      /** Adds a sprite; the returned row is its handle. */
      add(spec) {
        const row = { ...spec, rotation: 0, position: null, exact: false };
        place(row);
        rows.add(row);
        wake();
        return row;
      },
      /** Moves or turns a sprite (`lon`, `lat`, `bearing`). */
      move(row, { lon = row.lon, lat = row.lat, bearing = row.bearing } = {}) {
        if (!rows.has(row)) return;
        const moved = lon !== row.lon || lat !== row.lat;
        Object.assign(row, { lon, lat, bearing });
        if (moved) place(row);
        wake();
      },
      remove(row) {
        if (rows.delete(row)) wake();
      },
      removeAll() {
        rows.clear();
        wake();
      },
      show(value) {
        visible = value !== false;
        wake();
      },
      shown: () => visible,
      count: () => rows.size,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        removePaint();
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
