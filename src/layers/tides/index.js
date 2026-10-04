import * as Cesium from 'cesium';
import {
  TIDES_LAYER_ID,
  TIDE_WINDOW_AFTER_MS,
  TIDE_WINDOW_BEFORE_MS,
  tideHeightAt,
  tideSpan,
  tideTrendAt,
  waterEllipsoidHeight,
} from './model.js';
import { findTideStation, nearestTideStation } from './stations.js';
import { createWaterSurface } from './rendering.js';
import { createTidePanel } from './panel.js';
export * from './model.js';
export * from './stations.js';
export { createNoaaTideSource } from './source.js';

const RENDER_HOLD_ID = TIDES_LAYER_ID;
/** Playback speed: simulated milliseconds per real millisecond (1 h / s). */
const PLAY_RATE = 3600;
/** Refetch when the drawn window drifts this close to the edge of the data. */
const REFETCH_MARGIN_MS = 6 * 3600_000;

/**
 * Coastal tides: an animated sea surface that rises and falls with NOAA's
 * predicted tide over the photorealistic tiles or terrain, with a scrubber to
 * move through the next two days.
 */
export function createTidesLayer({
  source,
  render = {},
  now = Date.now,
  panelParent,
} = {}) {
  if (typeof source?.getPredictions !== 'function')
    throw new TypeError('Coastal tides require a prediction source');
  const {
    governorRequestRender = () => {},
    holdContinuousRender = () => {},
    releaseContinuousRender = () => {},
  } = render;

  let viewer = null;
  let enabled = false;
  let surface = null;
  let station = null;
  let predictions = null; // { stationId, turns }
  let request = null;
  let panel = null;
  let removePreRender = null;
  let removeMoveEnd = null;
  let previousDepthTest = null;
  let lastError = null;
  let lastUpdate = null;

  // Time model: 'live' tracks the wall clock; 'paused' holds an offset from
  // now; 'playing' advances that offset at PLAY_RATE.
  let mode = 'live';
  let offsetMs = 0;
  let lastFrameMs = null;
  let extraM = 0;
  let calibrationM = 0;
  let lastPanelRender = 0;

  const currentTimeMs = () => now() + (mode === 'live' ? 0 : offsetMs);

  function statusText() {
    if (lastError) return lastError;
    if (!station) return 'Fly to a coast near a supported NOAA station.';
    if (!predictions || predictions.stationId !== station.id)
      return 'Loading NOAA predictions…';
    return 'Predicted tide, NOAA CO-OPS. Not for navigation.';
  }

  function tideNow() {
    if (!predictions || !station || predictions.stationId !== station.id)
      return { tideM: null, trend: null };
    const t = currentTimeMs();
    return {
      tideM: tideHeightAt(predictions.turns, t),
      trend: tideTrendAt(predictions.turns, t),
    };
  }

  function renderPanel(force = false) {
    const wall = now();
    if (!panel || (!force && wall - lastPanelRender < 250)) return;
    lastPanelRender = wall;
    const { tideM, trend } = tideNow();
    panel.render({
      station,
      tideM,
      trend,
      timeMs: currentTimeMs(),
      offsetMs: mode === 'live' ? 0 : offsetMs,
      mode,
      extraM,
      calibrationM,
      status: statusText(),
    });
  }

  function frame() {
    if (!enabled) return;
    const wall = now();
    if (mode === 'playing' && lastFrameMs !== null) {
      offsetMs += (wall - lastFrameMs) * PLAY_RATE;
      if (offsetMs > TIDE_WINDOW_AFTER_MS) offsetMs = -TIDE_WINDOW_BEFORE_MS;
    }
    lastFrameMs = wall;
    const { tideM } = tideNow();
    if (surface) {
      surface.setShow(Number.isFinite(tideM));
      if (Number.isFinite(tideM))
        surface.setHeight(
          waterEllipsoidHeight(station, tideM, { calibrationM, extraM }),
        );
    }
    renderPanel();
  }

  function setStation(next) {
    if (next?.id === station?.id) return;
    surface?.destroy();
    surface = null;
    station = next;
    lastError = null;
    if (station && viewer) {
      surface = createWaterSurface(viewer.scene, station);
      surface.setShow(false);
    }
    void load();
    renderPanel(true);
  }

  function pickStationFromCamera() {
    if (!viewer) return;
    const carto = viewer.camera.positionCartographic;
    const found = nearestTideStation(
      Cesium.Math.toDegrees(carto.latitude),
      Cesium.Math.toDegrees(carto.longitude),
    );
    // Above ~400 km the camera sees a whole coastline; keep whatever is drawn.
    if (!found && carto.height > 400_000) return;
    setStation(found?.station ?? null);
  }

  async function load() {
    if (!enabled || !station) return false;
    const span = predictions?.stationId === station.id ? tideSpan(predictions.turns) : null;
    if (
      span &&
      span.startMs <= now() - TIDE_WINDOW_BEFORE_MS &&
      span.endMs >= now() + TIDE_WINDOW_AFTER_MS + REFETCH_MARGIN_MS
    )
      return true;
    request?.abort();
    const controller = new AbortController();
    request = controller;
    const wanted = station;
    const beginMs = now() - TIDE_WINDOW_BEFORE_MS;
    const endMs = now() + TIDE_WINDOW_AFTER_MS;
    try {
      const result = await source.getPredictions({
        stationId: wanted.id,
        beginMs,
        endMs,
        signal: controller.signal,
      });
      if (controller.signal.aborted || station !== wanted || !enabled)
        return false;
      predictions = result;
      lastError = null;
      lastUpdate = now();
      governorRequestRender('coastal-tides');
      return true;
    } catch (error) {
      if (controller.signal.aborted || station !== wanted || !enabled)
        return false;
      console.warn('[Data:Tides] Prediction fetch failed:', error);
      lastError = 'NOAA tide predictions are unavailable right now.';
      return false;
    } finally {
      if (request === controller) request = null;
      renderPanel(true);
    }
  }

  const handlers = {
    onScrub(ms) {
      offsetMs = ms;
      mode = 'paused';
      renderPanel(true);
    },
    onLive() {
      mode = 'live';
      offsetMs = 0;
      renderPanel(true);
    },
    onTogglePlay() {
      if (mode === 'playing') mode = 'paused';
      else {
        if (mode === 'live') offsetMs = 0;
        mode = 'playing';
        lastFrameMs = now();
      }
      renderPanel(true);
    },
    onExtra(m) {
      extraM = Number.isFinite(m) ? m : 0;
      renderPanel(true);
    },
    onCalibration(m) {
      calibrationM = Number.isFinite(m) ? m : 0;
      renderPanel(true);
    },
    onGoToStation(id) {
      const target = findTideStation(id);
      if (!target || !viewer) return;
      setStation(target);
      // Look at the shore from the water side, a little south of the gauge.
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(
          target.lon,
          target.lat - 0.035,
          1500,
        ),
        orientation: {
          heading: 0,
          pitch: Cesium.Math.toRadians(-28),
          roll: 0,
        },
        duration: 2.5,
      });
    },
  };

  const layer = {
    id: TIDES_LAYER_ID,
    name: 'Coastal Tides',
    icon: '🌊',
    source: 'NOAA CO-OPS',
    updateInterval: 15 * 60_000,

    init(nextViewer) {
      if (viewer) throw new Error('Coastal tides are already initialized');
      viewer = nextViewer;
      panel = createTidePanel({ handlers, parent: panelParent });
    },

    enable() {
      if (!viewer || enabled) return;
      enabled = true;
      mode = 'live';
      offsetMs = 0;
      lastFrameMs = null;
      // Water must hide behind land on the terrain globe too, not only behind
      // 3D Tiles; restore the scene's own setting on disable.
      previousDepthTest = viewer.scene.globe.depthTestAgainstTerrain;
      viewer.scene.globe.depthTestAgainstTerrain = true;
      removePreRender = viewer.scene.preRender.addEventListener(frame);
      removeMoveEnd = viewer.camera.moveEnd.addEventListener(
        pickStationFromCamera,
      );
      holdContinuousRender(RENDER_HOLD_ID);
      panel?.setVisible(true);
      pickStationFromCamera();
      renderPanel(true);
    },

    disable() {
      if (!enabled) return;
      enabled = false;
      request?.abort();
      request = null;
      removePreRender?.();
      removeMoveEnd?.();
      removePreRender = removeMoveEnd = null;
      if (previousDepthTest !== null && viewer)
        viewer.scene.globe.depthTestAgainstTerrain = previousDepthTest;
      previousDepthTest = null;
      surface?.destroy();
      surface = null;
      station = null;
      releaseContinuousRender(RENDER_HOLD_ID);
      panel?.setVisible(false);
    },

    async update() {
      if (!enabled) return false;
      return load();
    },

    destroy() {
      layer.disable();
      panel?.destroy();
      panel = null;
      predictions = null;
      viewer = null;
    },

    getStats() {
      return {
        count: station ? 1 : 0,
        lastUpdate,
        error: lastError,
      };
    },
  };
  return layer;
}
