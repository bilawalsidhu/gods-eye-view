import * as Cesium from 'cesium';
import { DEFAULT_HISTORY_LAYERS } from './positionHistory.js';

/**
 * Rewind and scrub the recorded position history.
 *
 * The live layers cannot render backwards (their snapshot renderers reconcile
 * forward-only state), so rewind draws its own overlay: one point per entity
 * at the interpolated display time plus a short trail, while the live layers'
 * visuals are suppressed through `setPresentationSuppressed(true)`. Reaching
 * the newest recorded time while replaying forward resumes live automatically.
 */
export const REWIND_RATES = Object.freeze([0, 1, 4, 16]);
export const DEFAULT_REWIND_MS = -10 * 60_000;
export const LAYER_COLORS = Object.freeze({
  flights: Object.freeze([1.0, 0.72, 0.2]),
  military: Object.freeze([1.0, 0.32, 0.3]),
  'ais-live-vessels': Object.freeze([0.25, 0.9, 1.0]),
});
const POINT_PX = 6;
const TRAIL_MS = 60_000;
const TRAIL_REFRESH_MS = 400;
const TIME_NOTIFY_MS = 200;
const SUPPRESS_REASSERT_MS = 1_000;
const MAX_RATE = 64;

function layerColor(layerId, alpha = 1) {
  const rgb = LAYER_COLORS[layerId] || [0.85, 0.85, 0.85];
  return new Cesium.Color(rgb[0], rgb[1], rgb[2], alpha);
}

/**
 * @param {object} options
 * @param {object} options.viewer Cesium viewer (needs `scene.primitives`).
 * @param {object} options.history Position history (`createPositionHistory`).
 * @param {string[]} [options.layers] Layer ids whose live visuals are hidden.
 * @param {(layerId: string) => object|null} [options.resolveLayerModule]
 * @param {(reason?: string) => void} [options.requestRender]
 * @param {(owner: string) => void} [options.holdRender]
 * @param {(owner: string) => void} [options.releaseRender]
 * @param {(state: object, kind: string) => void} [options.onChange]
 * @param {() => void} [options.onEnterRewind]
 * @param {() => void} [options.onExitRewind]
 */
export function createTimeTravel({
  viewer,
  history,
  layers = DEFAULT_HISTORY_LAYERS,
  resolveLayerModule = () => null,
  requestRender = () => viewer?.scene?.requestRender?.(),
  holdRender = null,
  releaseRender = null,
  onChange = null,
  onEnterRewind = null,
  onExitRewind = null,
  raf = (cb) => globalThis.requestAnimationFrame?.(cb),
  caf = (id) => globalThis.cancelAnimationFrame?.(id),
  now = () => globalThis.performance?.now?.() ?? Date.now(),
  wallNow = Date.now,
  createPoints = () => new Cesium.PointPrimitiveCollection(),
  createPolylines = () => new Cesium.PolylineCollection(),
  createTrailMaterial = (layerId) =>
    Cesium.Material.fromType('Color', { color: layerColor(layerId, 0.55) }),
  maxTrails = 250,
} = {}) {
  const state = {
    mode: 'live',
    displayTimeMs: NaN,
    offsetMs: 0,
    rate: 1,
    aheadMs: 0,
  };
  const MAX_FORECAST_MS = 15 * 60_000;
  const listeners = new Set();
  if (typeof onChange === 'function') listeners.add(onChange);
  let points = null;
  let polylines = null;
  const pointById = new Map();
  const trailById = new Map();
  const seen = new Set();
  const entities = [];
  const trailScratch = [];
  const scratchCartesian = new Cesium.Cartesian3();
  let rafId = null;
  let lastFrameMs = NaN;
  let renderedTimeMs = NaN;
  let renderedRevision = -1;
  let lastTrailMs = -Infinity;
  let lastNotifyMs = -Infinity;
  let lastSuppressMs = -Infinity;
  let holding = false;
  let destroyed = false;

  function snapshot() {
    const { oldestT, newestT } = history.range();
    return {
      mode: state.mode,
      displayTimeMs: state.displayTimeMs,
      offsetMs:
        state.mode === 'rewind'
          ? state.displayTimeMs - wallNow()
          : state.mode === 'forecast'
            ? state.aheadMs
            : 0,
      rate: state.rate,
      oldestT,
      newestT,
    };
  }
  function notify(kind) {
    if (kind === 'time') {
      const at = now();
      if (at - lastNotifyMs < TIME_NOTIFY_MS) return;
      lastNotifyMs = at;
    }
    const current = snapshot();
    for (const listener of listeners) {
      try {
        listener(current, kind);
      } catch (error) {
        console.warn('[TimeTravel] listener error:', error);
      }
    }
  }

  function setLiveSuppressed(suppressed) {
    for (const layerId of layers) {
      const module = resolveLayerModule(layerId);
      try {
        module?.setPresentationSuppressed?.(suppressed);
      } catch (error) {
        console.warn('[TimeTravel] suppress failed:', layerId, error);
      }
    }
  }
  function syncHold() {
    const wanted =
      (state.mode === 'rewind' && state.rate > 0) || state.mode === 'forecast';
    if (wanted && !holding) {
      holding = true;
      holdRender?.('time-travel');
    } else if (!wanted && holding) {
      holding = false;
      releaseRender?.('time-travel');
    }
  }

  function ensurePrimitives() {
    const collection = viewer?.scene?.primitives;
    if (!points) {
      points = createPoints();
      collection?.add?.(points);
    }
    if (!polylines) {
      polylines = createPolylines();
      collection?.add?.(polylines);
    }
  }
  function removePrimitives() {
    const collection = viewer?.scene?.primitives;
    if (points) {
      collection?.remove?.(points);
      points = null;
    }
    if (polylines) {
      collection?.remove?.(polylines);
      polylines = null;
    }
    pointById.clear();
    trailById.clear();
  }

  function cameraCartographic() {
    const carto = viewer?.camera?.positionCartographic;
    if (!carto) return null;
    return {
      lat: Cesium.Math.toDegrees(carto.latitude),
      lon: Cesium.Math.toDegrees(carto.longitude),
    };
  }

  function renderTrails(t) {
    if (!polylines) return;
    const camera = cameraCartographic();
    let candidates = entities;
    if (camera && entities.length > maxTrails) {
      candidates = entities
        .map((entity) => {
          const dLat = entity.lat - camera.lat;
          const dLon = ((entity.lon - camera.lon + 540) % 360) - 180;
          return { entity, d: dLat * dLat + dLon * dLon };
        })
        .sort((a, b) => a.d - b.d)
        .slice(0, maxTrails)
        .map((item) => item.entity);
    } else if (entities.length > maxTrails)
      candidates = entities.slice(0, maxTrails);
    seen.clear();
    for (const entity of candidates) {
      const key = `${entity.layerId}:${entity.id}`;
      history.trailPositions(
        entity.layerId,
        entity.id,
        t - TRAIL_MS,
        t,
        trailScratch,
      );
      if (trailScratch.length < 3) continue;
      trailScratch.push(entity.lon, entity.lat, entity.heightM);
      const positions = Cesium.Cartesian3.fromDegreesArrayHeights(trailScratch);
      let line = trailById.get(key);
      if (!line) {
        line = polylines.add({
          positions,
          width: 1.5,
          material: createTrailMaterial(entity.layerId),
        });
        trailById.set(key, line);
      } else line.positions = positions;
      seen.add(key);
    }
    for (const [key, line] of trailById) {
      if (seen.has(key)) continue;
      polylines.remove(line);
      trailById.delete(key);
    }
  }

  function renderOverlay({ force = false } = {}) {
    if ((state.mode !== 'rewind' && state.mode !== 'forecast') || !points)
      return;
    const t = state.displayTimeMs;
    const revision = history.revision;
    if (!force && t === renderedTimeMs && revision === renderedRevision) return;
    renderedTimeMs = t;
    renderedRevision = revision;
    if (state.mode === 'forecast') history.forecastAt(t, entities);
    else history.entitiesAt(t, entities);
    seen.clear();
    for (const entity of entities) {
      const key = `${entity.layerId}:${entity.id}`;
      const position = Cesium.Cartesian3.fromDegrees(
        entity.lon,
        entity.lat,
        entity.heightM,
        Cesium.Ellipsoid.WGS84,
        scratchCartesian,
      );
      let point = pointById.get(key);
      if (!point) {
        point = points.add({
          position,
          color: layerColor(
            entity.layerId,
            entity.predicted ? entity.confidence : 1,
          ),
          outlineColor: new Cesium.Color(0, 0, 0, 0.65),
          outlineWidth: 1,
          pixelSize: POINT_PX,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          id: {
            timeTravel: true,
            layerId: entity.layerId,
            id: entity.id,
            label: entity.label,
          },
        });
        pointById.set(key, point);
      } else {
        point.position = position;
        if (entity.predicted)
          point.color = layerColor(entity.layerId, entity.confidence);
      }
      seen.add(key);
    }
    for (const [key, point] of pointById) {
      if (seen.has(key)) continue;
      points.remove(point);
      pointById.delete(key);
    }
    const at = now();
    if (force || at - lastTrailMs >= TRAIL_REFRESH_MS) {
      lastTrailMs = at;
      renderTrails(t);
    }
    requestRender('time-travel');
  }

  function clampToRange(t) {
    const { oldestT, newestT } = history.range();
    if (!Number.isFinite(oldestT) || !Number.isFinite(newestT)) return NaN;
    return Math.min(newestT, Math.max(oldestT, t));
  }

  function enterRewind() {
    if (state.mode === 'rewind') return;
    state.mode = 'rewind';
    ensurePrimitives();
    setLiveSuppressed(true);
    lastSuppressMs = now();
    try {
      onEnterRewind?.();
    } catch (error) {
      console.warn('[TimeTravel] enter hook failed:', error);
    }
    lastFrameMs = NaN;
    if (rafId == null) rafId = raf(frame);
  }

  function frame(frameNowMs) {
    rafId = null;
    if (destroyed || (state.mode !== 'rewind' && state.mode !== 'forecast'))
      return;
    if (state.mode === 'forecast') {
      state.displayTimeMs = wallNow() + state.aheadMs;
      renderOverlay();
      rafId = raf(frame);
      return;
    }
    step(Number.isFinite(frameNowMs) ? frameNowMs : now());
    if (state.mode === 'rewind') rafId = raf(frame);
  }

  /** Advance the display clock to a frame time; exposed for tests. */
  function step(frameNowMs) {
    if (state.mode !== 'rewind') return state;
    const dt = Number.isFinite(lastFrameMs)
      ? Math.max(0, frameNowMs - lastFrameMs)
      : 0;
    lastFrameMs = frameNowMs;
    if (frameNowMs - lastSuppressMs >= SUPPRESS_REASSERT_MS) {
      lastSuppressMs = frameNowMs;
      setLiveSuppressed(true);
    }
    if (state.rate > 0 && dt > 0) {
      const { newestT } = history.range();
      const next = state.displayTimeMs + dt * state.rate;
      if (Number.isFinite(newestT) && next >= newestT) {
        resumeLive('caught-up');
        return state;
      }
      state.displayTimeMs = next;
      notify('time');
    }
    renderOverlay();
    return state;
  }

  function rewind(offsetMs = DEFAULT_REWIND_MS) {
    if (destroyed) return false;
    const offset = Number(offsetMs);
    if (!Number.isFinite(offset) || offset >= 0) return false;
    const target = clampToRange(wallNow() + offset);
    if (!Number.isFinite(target)) return false;
    const { newestT } = history.range();
    if (target >= newestT && state.mode === 'live') return false;
    enterRewind();
    state.displayTimeMs = target;
    state.rate = 1;
    syncHold();
    renderOverlay({ force: true });
    notify('mode');
    return true;
  }

  /** Show dead-reckoned positions aheadMs into the future, moving with the clock. */
  function forecast(aheadMs = 5 * 60_000) {
    if (destroyed) return false;
    const ahead = Number(aheadMs);
    if (!Number.isFinite(ahead) || ahead <= 0) return false;
    const { newestT } = history.range();
    if (!Number.isFinite(newestT)) return false;
    if (state.mode === 'rewind') resumeLive('forecast');
    if (state.mode !== 'forecast') {
      state.mode = 'forecast';
      ensurePrimitives();
      setLiveSuppressed(true);
      lastSuppressMs = now();
      try {
        onEnterRewind?.();
      } catch (error) {
        console.warn('[TimeTravel] enter hook failed:', error);
      }
      if (rafId == null) rafId = raf(frame);
    }
    state.aheadMs = Math.min(MAX_FORECAST_MS, ahead);
    state.displayTimeMs = wallNow() + state.aheadMs;
    state.rate = 1;
    syncHold();
    renderOverlay({ force: true });
    notify('mode');
    return true;
  }

  function seekTo(timestampMs) {
    if (destroyed) return false;
    const target = clampToRange(Number(timestampMs));
    if (!Number.isFinite(target)) return false;
    enterRewind();
    state.displayTimeMs = target;
    lastFrameMs = NaN;
    syncHold();
    renderOverlay({ force: true });
    notify('seek');
    return true;
  }

  function setRate(rate) {
    if (destroyed) return state.rate;
    const value = Number(rate);
    if (!Number.isFinite(value) || value < 0 || value > MAX_RATE)
      return state.rate;
    state.rate = value;
    lastFrameMs = NaN;
    syncHold();
    notify('rate');
    return state.rate;
  }

  function resumeLive(reason = 'user') {
    if (state.mode !== 'rewind' && state.mode !== 'forecast') return false;
    state.mode = 'live';
    state.aheadMs = 0;
    state.displayTimeMs = NaN;
    state.rate = 1;
    if (rafId != null) {
      caf(rafId);
      rafId = null;
    }
    syncHold();
    removePrimitives();
    renderedTimeMs = NaN;
    renderedRevision = -1;
    setLiveSuppressed(false);
    try {
      onExitRewind?.(reason);
    } catch (error) {
      console.warn('[TimeTravel] exit hook failed:', error);
    }
    requestRender('time-travel-live');
    notify('mode');
    return true;
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function destroy() {
    if (destroyed) return;
    resumeLive('destroy');
    destroyed = true;
    listeners.clear();
  }

  return {
    rewind,
    seekTo,
    setRate,
    forecast,
    resumeLive,
    state: snapshot,
    range: () => history.range(),
    subscribe,
    step,
    layers: [...layers],
    get destroyed() {
      return destroyed;
    },
    destroy,
  };
}
