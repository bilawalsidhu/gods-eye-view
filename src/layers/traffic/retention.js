import * as Cesium from 'cesium';
import { MAX_DOTS, roadDotBudget } from './policy.js';

export const DOT_CHANGE_BUDGET = 768;
export const DOT_FADE_MS = 180;

/** Geometry identity excludes heights, flow and snapshot/collection ordering. */
export function roadIdentity(road) {
  return `${road.directFlow ? 'tomtom' : 'osm'}:${road.type}:${road.oneway}:${road.coords.map(([lon, lat]) => `${lon.toFixed(7)},${lat.toFixed(7)}`).join(';')}`;
}

/** Retain one road and its dot population across tile and surface publications. */
export function createRetention({ state, parts }) {
  const records = new Map();
  const heightStep = new Cesium.Cartesian3();
  const screenFrom = new Cesium.Cartesian2();
  const screenTo = new Cesium.Cartesian2();
  const eye = new Cesium.Cartesian3();
  function projectSafely(scene, point, screen) {
    if (scene.camera.viewMatrix) {
      Cesium.Matrix4.multiplyByPoint(scene.camera.viewMatrix, point, eye);
      if (eye.z >= -(scene.camera.frustum?.near || 0)) return false;
    }
    return (
      Boolean(
        Cesium.SceneTransforms.worldToWindowCoordinates(scene, point, screen),
      ) &&
      Number.isFinite(screen.x) &&
      Number.isFinite(screen.y)
    );
  }
  function nearCanvas(scene, point, screen) {
    return (
      projectSafely(scene, point, screen) &&
      screen.x >= -100 &&
      screen.x <= scene.canvas.clientWidth + 100 &&
      screen.y >= -100 &&
      screen.y <= scene.canvas.clientHeight + 100
    );
  }
  let timer = null;
  let altitude = 0;
  const schedule = () => {
    if (timer !== null) return;
    state._populationPending = true;
    timer =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(pump)
        : setTimeout(pump, 16);
  };
  function pump() {
    timer = null;
    if (!state._enabled) return;
    let budget = DOT_CHANGE_BUDGET;
    let pending = false;
    const now = Date.now();
    // Removing a road or reducing density fades only surplus dots. A retained
    // dot never changes road, direction, segment or progress.
    for (const record of records.values()) {
      record.road.flow = record.road.source.flow;
      if (
        record.road.flow?.closure ||
        (state._liveMode &&
          !record.road.flow &&
          state._uncoveredMode === 'hide')
      )
        record.target = 0;
      for (let i = record.dots.length - 1; i >= 0 && budget > 0; i--) {
        const dot = record.dots[i];
        if (!dot.retiring || now - dot.retiring < DOT_FADE_MS) continue;
        state._pointCollection.remove(dot.point);
        const last = state._dots.pop();
        if (last !== dot) {
          state._dots[dot.index] = last;
          last.index = dot.index;
        }
        record.dots.splice(i, 1);
        budget--;
        state._motion.removed++;
      }
      let active = 0;
      for (const dot of record.dots) if (!dot.retiring) active++;
      for (
        let i = record.dots.length - 1;
        active > record.target && i >= 0 && budget > 0;
        i--
      ) {
        const dot = record.dots[i];
        if (dot.retiring) continue;
        dot.retiring = now;
        active--;
        budget--;
      }
      if (active < record.target && budget > 0) {
        const count = Math.min(
          record.target - active,
          budget,
          MAX_DOTS - state._dots.length,
        );
        if (count > 0) {
          const before = state._dots.length;
          parts.animation.spawnDotsForRoad(record.road, altitude, count);
          for (let i = before; i < state._dots.length; i++)
            record.dots.push(state._dots[i]);
          budget -= state._dots.length - before;
          active += state._dots.length - before;
        }
      }
      if (active !== record.target || record.dots.length !== active)
        pending = true;
      if (!record.target && !record.dots.length)
        records.delete(record.road.key);
    }
    refreshCounts();
    state._populationPending = pending;
    if (pending) schedule();
  }
  function refreshCounts() {
    const counts = state._bucketCounts;
    counts.free = counts.slow = counts.jam = counts.sim = 0;
    let count = 0;
    for (const dot of state._dots) {
      if (!dot.point.show) continue;
      counts[dot.bucket || 'sim']++;
      count++;
    }
    state._count = count;
  }
  function reconcile(roads, height, replace) {
    altitude = height;
    if (replace) for (const record of records.values()) record.wanted = false;
    for (const candidate of roads) {
      const key = candidate.key || roadIdentity(candidate);
      candidate.key = key;
      let record = records.get(key);
      if (!record) {
        // Surface sampling owns the incoming arrays. Animation owns copies,
        // so an asynchronous height pass cannot move half a road in one frame.
        const road = {
          ...candidate,
          waypoints: candidate.waypoints.map((p) => Cesium.Cartesian3.clone(p)),
          segmentDist: candidate.segmentDist.slice(),
          source: candidate,
          targetWaypoints: candidate.waypoints.map((p) =>
            Cesium.Cartesian3.clone(p),
          ),
          heightMoving: false,
        };
        record = { road, dots: [], target: 0, wanted: true };
        records.set(key, record);
      } else if (candidate !== record.road) {
        record.road.source = candidate;
        record.road.flow = candidate.flow;
        record.road.densityWeight = candidate.densityWeight;
        for (let i = 0; i < candidate.waypoints.length; i++) {
          if (
            !Cesium.Cartesian3.equalsEpsilon(
              record.road.targetWaypoints[i],
              candidate.waypoints[i],
              0,
              0.01,
            )
          )
            record.road.heightMoving = state._heightPending = true;
          Cesium.Cartesian3.clone(
            candidate.waypoints[i],
            record.road.targetWaypoints[i],
          );
        }
      }
      record.wanted = true;
    }
    const wanted = [];
    for (const record of records.values()) {
      if (record.wanted) wanted.push(record.road);
      else record.target = 0;
    }
    const budgets = parts.model.allocateRoadDotBudgets(
      wanted,
      altitude,
      roadDotBudget(altitude),
    );
    for (let i = 0; i < wanted.length; i++)
      records.get(wanted[i].key).target = budgets[i];
    state._roads = wanted;
    state._motion.publishes++;
    // First paint gets one bounded batch without an additional frame wait.
    if (!state._dots.length && timer === null) pump();
    else schedule();
  }
  function easeHeights(dt) {
    const blend = Math.min(1, dt * 12);
    const scene = state._viewer?.scene;
    const canProject =
      scene?.canvas?.clientHeight && scene.camera && scene.frameState;
    state._heightPending = false;
    for (let r = 0; r < state._roads.length; r++) {
      const road = state._roads[r];
      if (!road.heightMoving) continue;
      let moving = false;
      for (let i = 0; i < road.waypoints.length; i++) {
        const point = road.waypoints[i],
          target = road.targetWaypoints[i];
        if (Cesium.Cartesian3.distanceSquared(point, target) < 0.0001)
          Cesium.Cartesian3.clone(target, point);
        else {
          const visible = canProject && nearCanvas(scene, point, screenFrom);
          let step = visible
            ? blend
            : Math.min(
                blend,
                (120 * dt) / Cesium.Cartesian3.distance(point, target),
              );
          if (visible) {
            let safe = false;
            for (let attempt = 0; attempt < 16; attempt++) {
              Cesium.Cartesian3.lerp(point, target, step, heightStep);
              if (!projectSafely(scene, heightStep, screenTo)) {
                step *= 0.5;
                continue;
              }
              const pixels = Cesium.Cartesian2.distance(screenFrom, screenTo);
              if (pixels <= 12) {
                safe = true;
                break;
              }
              step *= 11.5 / pixels;
            }
            if (!safe) step = 0;
          }
          state._heightPending ||= !canProject || visible;
          Cesium.Cartesian3.lerp(point, target, step, point);
          moving = true;
        }
      }
      for (let i = 0; i < road.segmentDist.length; i++)
        road.segmentDist[i] = Cesium.Cartesian3.distance(
          road.waypoints[i],
          road.waypoints[i + 1],
        );
      road.heightMoving = moving;
    }
  }
  function clear() {
    if (timer !== null) {
      if (typeof cancelAnimationFrame === 'function')
        cancelAnimationFrame(timer);
      else clearTimeout(timer);
      timer = null;
    }
    records.clear();
    state._populationPending = false;
    state._heightPending = false;
  }
  return { reconcile, easeHeights, clear, refreshCounts };
}
