// The cyclone advisories on the globe contract, the same on every engine:
// storm centres and forecast points are point movers drawn over the scene,
// each storm's forecast track is a ground corridor set and its cone a ground
// polygon set (fill and an outline on every ring). Points beyond the
// ellipsoid horizon are hidden, and a storm's track and cone are hidden
// while an inscribed WGS84 sphere hides their bounding sphere, checked on
// the frames the camera moved. Storm names and lead hours go to the shared
// overlay host at the anchors the points use (labels.js).

import * as geo from '../../../geo/index.js';
import { rgbaFromCss } from '../../shared/color.js';
import { coherentCycloneGeometry } from '../rendering.js';
import {
  CYCLONE_ACCENT,
  CYCLONE_MARKER_PX,
  CYCLONE_SELECTED_ACCENT,
  createCycloneLabels,
} from '../labels.js';

const LAYER = 'weather-cyclones';
const [R, G, B] = rgbaFromCss(CYCLONE_ACCENT).rgba();
const BLUE = Object.freeze([R, G, B, 1]);
const GOLD = Object.freeze(rgbaFromCss(CYCLONE_SELECTED_ACCENT).rgba());
const WHITE = Object.freeze([1, 1, 1, 1]);
const BLACK = Object.freeze([0, 0, 0, 1]);
const TRACK_WIDTH_PX = 2.5;
const CONE_FILL = Object.freeze([R, G, B, 0.16]);
const CONE_OUTLINE = Object.freeze({ color: [R, G, B, 0.55], widthPx: 1 });
// A status-only point still has a useful regional camera destination.
const MIN_FOCUS_RADIUS_M = 500_000;
const OCCLUDER_RADIUS = geo.ellipsoid.WGS84.minimumRadius;
// The source validates at most 32 storms and 500 forecast fixes.
const CENTER_CAPACITY = 32;
const FORECAST_CAPACITY = 500;

const zeroCounts = () => ({
  storms: 0,
  tracks: 0,
  cones: 0,
  forecastPoints: 0,
});

const position = ({ longitude, latitude }) =>
  geo.cartesian3.fromDegrees(longitude, latitude, 0);
const coordinate = (pair) =>
  position({ longitude: pair[0], latitude: pair[1] });

/**
 * Cesium's Occluder.isBoundingSphereVisible for an occluder sphere at the
 * Earth's centre of the WGS84 minimum radius, seen from `camera`. It only
 * hides a sphere wholly behind the planet, so a partly visible track or
 * cone stays shown; from inside the occluder nothing is visible.
 */
export function cycloneSphereVisible(sphere, camera) {
  const cameraSq = geo.cartesian3.magnitudeSquared(camera);
  const occluderSq = OCCLUDER_RADIUS * OCCLUDER_RADIUS;
  if (!(cameraSq > occluderSq)) return false;
  const horizon = Math.sqrt(cameraSq - occluderSq);
  const radius = sphere.radius;
  const toCamera = geo.cartesian3.distanceSquared(sphere.center, camera);
  let temp = OCCLUDER_RADIUS - radius;
  temp = geo.cartesian3.magnitudeSquared(sphere.center) - temp * temp;
  if (radius < OCCLUDER_RADIUS) {
    if (!(temp > 0)) return false;
    temp = Math.sqrt(temp) + horizon;
    return temp * temp + radius * radius > toCamera;
  }
  if (!(temp > 0)) return true;
  const radiusSq = radius * radius;
  if ((horizon * horizon + occluderSq) * radiusSq > toCamera * occluderSq)
    return true;
  temp = Math.sqrt(temp) + horizon;
  return temp * temp + radiusSq > toCamera;
}

/**
 * @param {import('../../../globe/contract.js').GlobeEngine} engine
 * @param {{ overlayHost?: object }} [options] The overlay host the storm
 *   cards and lead-hour labels publish to (labels.js has the default).
 */
export function createCyclonesDisplay(engine, { overlayHost } = {}) {
  const labels = createCycloneLabels({ engine, host: overlayHost });
  // Mover set ids stay unique when a set is rebuilt larger.
  let setSeq = 0;
  const pointSet = (role, capacity, outlinePx, sizePx, order) =>
    engine.movers.createSet({
      id: `${LAYER}-${role}-${++setSeq}`,
      kind: 'point',
      capacity,
      order,
      pickable: true,
      // Cesium: disableDepthTestDistance Infinity.
      depthTest: 'always',
      point: { sizePx, outlinePx, outlineColor: BLACK },
    });
  const centerSet = (capacity) =>
    pointSet('centers', capacity, 2, CYCLONE_MARKER_PX.storm, 1);
  const forecastSet = (capacity) =>
    pointSet('forecasts', capacity, 1, CYCLONE_MARKER_PX.forecast, 0);
  let centers = centerSet(CENTER_CAPACITY);
  let forecasts = forecastSet(FORECAST_CAPACITY);
  let centerRows = [];
  let forecastRows = [];
  // storm id → { sphere, tracks?, cones?, shown }
  let storms = new Map();
  // pickId → storm id, for the ground and mover sets drawn now.
  let pickIds = new Map();
  let owners = new Set();
  let counts = zeroCounts();
  let selected = null;
  let destroyed = false;
  let removePreRender = null;
  const lastCamera = geo.cartesian3.create(Number.NaN, 0, 0);

  const render = () => engine.render.request(LAYER);

  function paintCenters() {
    centerRows.forEach((row, index) => {
      const highlight = row.stormId === selected;
      centers.set(index, {
        color: highlight ? GOLD : BLUE,
        scale: highlight
          ? CYCLONE_MARKER_PX.selected / CYCLONE_MARKER_PX.storm
          : 1,
      });
    });
    centers.commit();
  }

  function cull(force = false) {
    const camera = engine.camera.livePosition;
    if (!force && geo.cartesian3.equals(camera, lastCamera)) return;
    geo.cartesian3.clone(camera, lastCamera);
    for (const [set, rows] of [
      [centers, centerRows],
      [forecasts, forecastRows],
    ]) {
      let changed = false;
      rows.forEach((row, index) => {
        const show = engine.projector.horizonVisible(row.position);
        if (show === row.show) return;
        row.show = show;
        set.set(index, { show });
        changed = true;
      });
      if (changed) set.commit();
    }
    for (const storm of storms.values()) {
      if (!storm.tracks && !storm.cones) continue;
      const show = cycloneSphereVisible(storm.sphere, camera);
      if (show === storm.shown) continue;
      storm.shown = show;
      storm.tracks?.show(show);
      storm.cones?.show(show);
    }
  }

  function syncHorizonListener() {
    if (!storms.size) {
      removePreRender?.();
      removePreRender = null;
      return;
    }
    removePreRender ??= engine.frames.preRender.addEventListener(() => cull());
  }

  function destroySets(record) {
    record.tracks?.destroy();
    record.cones?.destroy();
  }

  function groundSet(record, key, kind, order, items) {
    if (!items.length) {
      record[key]?.destroy();
      record[key] = null;
      return;
    }
    record[key] ??= engine.ground.createSet({
      id: `${LAYER}-${key}:${record.id}`,
      kind,
      order,
      pickable: true,
    });
    record[key].replace(items);
    record[key].commit();
    owners.add(record[key].id);
  }

  function ensureCapacity(needed, current, make) {
    if (needed <= current.capacity) return current;
    current.set.destroy();
    let capacity = current.capacity;
    while (capacity < needed) capacity *= 2;
    return { set: make(capacity), capacity };
  }
  let centerCapacity = CENTER_CAPACITY;
  let forecastCapacity = FORECAST_CAPACITY;

  function clear() {
    removePreRender?.();
    removePreRender = null;
    for (const record of storms.values()) destroySets(record);
    storms = new Map();
    pickIds = new Map();
    owners = new Set();
    centerRows = [];
    forecastRows = [];
    if (!destroyed) {
      centers.setCount(0);
      centers.commit();
      forecasts.setCount(0);
      forecasts.commit();
    }
    labels.clear();
    selected = null;
    counts = zeroCounts();
    render();
  }

  return {
    /**
     * Draws a snapshot in place of the last one; false when it was aborted
     * or the display is destroyed (nothing of it is drawn then).
     */
    setSnapshot(snapshot, { signal } = {}) {
      signal?.throwIfAborted();
      if (destroyed) return false;
      const nextStorms = new Map();
      const nextPickIds = new Map();
      const nextCenters = [];
      const nextForecasts = [];
      const nextLabels = [];
      const nextCounts = zeroCounts();
      const builds = [];
      for (const storm of snapshot.storms) {
        const prefix = `cyclone:${storm.id}:`;
        const center = position(storm.position);
        const extent = [center];
        const own = (id) => {
          nextPickIds.set(id, storm.id);
          return id;
        };
        nextCenters.push({
          id: own(`${prefix}center`),
          stormId: storm.id,
          position: center,
          show: null,
        });
        const label = {
          id: storm.id,
          name: storm.name,
          classification: storm.classification,
          windKt: storm.windKt,
          position: center,
          forecasts: [],
        };
        nextLabels.push(label);
        nextCounts.storms++;
        const tracks = [];
        const cones = [];
        if (coherentCycloneGeometry(storm)) {
          const lines =
            storm.track?.type === 'LineString'
              ? [storm.track.coordinates]
              : storm.track?.coordinates || [];
          lines.forEach((line, index) => {
            extent.push(...line.map(coordinate));
            tracks.push({
              positions: line,
              color: BLUE,
              widthPx: TRACK_WIDTH_PX,
              pickId: own(`${prefix}track:${index}`),
            });
            nextCounts.tracks++;
          });
          const polygons =
            storm.cone?.type === 'Polygon'
              ? [storm.cone.coordinates]
              : storm.cone?.coordinates || [];
          polygons.forEach((rings, index) => {
            // Each exterior keeps its own holes; edges are great circles,
            // across the antimeridian too.
            extent.push(...rings[0].map(coordinate));
            cones.push({
              rings,
              fill: CONE_FILL,
              outline: CONE_OUTLINE,
              pickId: own(`${prefix}cone:${index}`),
            });
            nextCounts.cones++;
          });
          storm.forecastPoints.forEach((point, index) => {
            if (point.tauHours === 0) return;
            const at = position(point.position);
            extent.push(at);
            nextForecasts.push({
              id: own(`${prefix}forecast:${index}`),
              stormId: storm.id,
              position: at,
              show: null,
            });
            label.forecasts.push({ tauHours: point.tauHours, position: at });
            nextCounts.forecastPoints++;
          });
        }
        const sphere = geo.boundingSphere.fromPoints(extent);
        sphere.radius = Math.max(sphere.radius, MIN_FOCUS_RADIUS_M);
        nextStorms.set(storm.id, {
          id: storm.id,
          sphere,
          tracks: storms.get(storm.id)?.tracks ?? null,
          cones: storms.get(storm.id)?.cones ?? null,
          shown: null,
        });
        builds.push({ id: storm.id, tracks, cones });
      }
      // Sets of storms that left go; the others are rebuilt in place.
      for (const [id, record] of storms)
        if (!nextStorms.has(id)) destroySets(record);
      owners = new Set();
      for (const { id, tracks, cones } of builds) {
        const record = nextStorms.get(id);
        // Cones under every track.
        groundSet(record, 'cones', 'polygon', 0, cones);
        groundSet(record, 'tracks', 'corridor', 1, tracks);
      }
      const grownCenters = ensureCapacity(
        nextCenters.length,
        { set: centers, capacity: centerCapacity },
        centerSet,
      );
      centers = grownCenters.set;
      centerCapacity = grownCenters.capacity;
      const grownForecasts = ensureCapacity(
        nextForecasts.length,
        { set: forecasts, capacity: forecastCapacity },
        forecastSet,
      );
      forecasts = grownForecasts.set;
      forecastCapacity = grownForecasts.capacity;
      nextCenters.forEach((row, index) =>
        centers.set(index, {
          position: row.position,
          pickId: row.id,
          show: true,
        }),
      );
      centers.setCount(nextCenters.length);
      nextForecasts.forEach((row, index) =>
        forecasts.set(index, {
          position: row.position,
          pickId: row.id,
          color: WHITE,
          show: true,
        }),
      );
      forecasts.setCount(nextForecasts.length);
      forecasts.commit();
      owners.add(centers.id).add(forecasts.id);
      storms = nextStorms;
      pickIds = nextPickIds;
      centerRows = nextCenters;
      forecastRows = nextForecasts;
      counts = nextCounts;
      paintCenters();
      cull(true);
      syncHorizonListener();
      labels.setSnapshot(nextLabels, selected);
      render();
      return true;
    },
    setSelection(id) {
      selected = id;
      if (!destroyed) paintCenters();
      labels.setSelection(id);
      render();
    },
    /** Whether a pick id is one of the current advisory's drawn things. */
    ownsPickId: (id) => typeof id === 'string' && pickIds.has(id),
    /** The storm a pick of this display names, else null. */
    pickStorm(picked) {
      if (!picked || !owners.has(picked.owner)) return null;
      return pickIds.get(picked.id) ?? null;
    },
    getFocusSphere: (id) => storms.get(id)?.sphere ?? null,
    clear,
    destroy() {
      if (destroyed) return;
      clear();
      destroyed = true;
      centers.destroy();
      forecasts.destroy();
    },
    getDiagnostics() {
      return {
        ...counts,
        dataSources: Number(storms.size > 0),
        entities: pickIds.size,
        selectedId: selected,
        timerActive: false,
      };
    },
  };
}
