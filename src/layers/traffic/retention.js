import {
  copyInto,
  distanceSquared,
  equalsEpsilon,
  lerpInto,
} from '../../geo/vector.js';
import { canvasOf, findCamera, findQuery } from '../../render/rendererOf.js';
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
  const heightStep = { x: 0, y: 0, z: 0 };
  const near = (a, b) =>
    equalsEpsilon(a.x, b.x, 0.01) &&
    equalsEpsilon(a.y, b.y, 0.01) &&
    equalsEpsilon(a.z, b.z, 0.01);
  const pointDistance = (a, b) => Math.sqrt(distanceSquared(a, b));
  /**
   * A point's window position, or null when it is on or behind the near
   * plane (where a projection folds back onto the screen) or does not
   * project.
   */
  function projectSafely(view, point) {
    const { pose, query } = view;
    if (pose) {
      const { position: eye, direction: d } = pose;
      const depth =
        d.x * (point.x - eye.x) +
        d.y * (point.y - eye.y) +
        d.z * (point.z - eye.z);
      if (depth <= (pose.near || 0)) return null;
    }
    const screen = query.project(point);
    return screen && Number.isFinite(screen.x) && Number.isFinite(screen.y)
      ? screen
      : null;
  }
  function nearCanvas(view, point) {
    const screen = projectSafely(view, point);
    return screen &&
      screen.x >= -100 &&
      screen.x <= view.width + 100 &&
      screen.y >= -100 &&
      screen.y <= view.height + 100
      ? screen
      : null;
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
    parts.animation.syncRenderDemand?.();
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
          waypoints: candidate.waypoints.map(({ x, y, z }) => ({ x, y, z })),
          segmentDist: candidate.segmentDist.slice(),
          source: candidate,
          targetWaypoints: candidate.waypoints.map(({ x, y, z }) => ({
            x,
            y,
            z,
          })),
          heightMoving: false,
        };
        record = { road, dots: [], target: 0, wanted: true };
        records.set(key, record);
      } else if (candidate !== record.road) {
        record.road.source = candidate;
        record.road.flow = candidate.flow;
        record.road.densityWeight = candidate.densityWeight;
        for (let i = 0; i < candidate.waypoints.length; i++) {
          const target = record.road.targetWaypoints[i];
          // A waypoint the retained road lacks counts as moved and is not
          // written, as before.
          if (!target || !near(target, candidate.waypoints[i]))
            record.road.heightMoving = state._heightPending = true;
          if (target) copyInto(candidate.waypoints[i], target);
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
  /**
   * What height easing reads of the view once a frame: the canvas size, the
   * query port to project with and the camera pose for the near plane. Null
   * when nothing can be projected yet.
   */
  function frameView() {
    const viewer = state._viewer;
    const canvas = canvasOf(viewer);
    if (!canvas?.clientHeight) return null;
    const query = findQuery(viewer);
    if (!query) return null;
    return {
      query,
      pose: findCamera(viewer)?.pose() ?? null,
      width: canvas.clientWidth,
      height: canvas.clientHeight,
    };
  }
  function easeHeights(dt) {
    const blend = Math.min(1, dt * 12);
    let view;
    state._heightPending = false;
    for (let r = 0; r < state._roads.length; r++) {
      const road = state._roads[r];
      if (!road.heightMoving) continue;
      let moving = false;
      for (let i = 0; i < road.waypoints.length; i++) {
        const point = road.waypoints[i],
          target = road.targetWaypoints[i];
        if (distanceSquared(point, target) < 0.0001) copyInto(target, point);
        else {
          if (view === undefined) view = frameView();
          const screenFrom = view && nearCanvas(view, point);
          const visible = Boolean(screenFrom);
          let step = visible
            ? blend
            : Math.min(blend, (120 * dt) / pointDistance(point, target));
          if (visible) {
            let safe = false;
            for (let attempt = 0; attempt < 16; attempt++) {
              lerpInto(point, target, step, heightStep);
              const screenTo = projectSafely(view, heightStep);
              if (!screenTo) {
                step *= 0.5;
                continue;
              }
              const pixels = Math.hypot(
                screenFrom.x - screenTo.x,
                screenFrom.y - screenTo.y,
              );
              if (pixels <= 12) {
                safe = true;
                break;
              }
              step *= 11.5 / pixels;
            }
            if (!safe) step = 0;
          }
          state._heightPending ||= !view || visible;
          lerpInto(point, target, step, point);
          moving = true;
        }
      }
      for (let i = 0; i < road.segmentDist.length; i++)
        road.segmentDist[i] = pointDistance(
          road.waypoints[i],
          road.waypoints[i + 1],
        );
      road.heightMoving = moving;
    }
  }
  /**
   * Settle every retained road on its corrected heights at once. Easing only
   * runs inside the held animation frame, so once nothing is left to animate
   * the remaining correction would otherwise stay pending indefinitely.
   * Published roads whose record was just dropped are settled too, so a later
   * held frame cannot revive their correction.
   */
  function finishHeights() {
    const roads = new Set(state._roads);
    for (const record of records.values()) roads.add(record.road);
    for (const road of roads) {
      if (!road.heightMoving) continue;
      for (let i = 0; i < road.waypoints.length; i++)
        copyInto(road.targetWaypoints[i], road.waypoints[i]);
      for (let i = 0; i < road.segmentDist.length; i++)
        road.segmentDist[i] = pointDistance(
          road.waypoints[i],
          road.waypoints[i + 1],
        );
      road.heightMoving = false;
    }
    state._heightPending = false;
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
  return { reconcile, easeHeights, finishHeights, clear, refreshCounts };
}
