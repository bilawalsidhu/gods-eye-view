import * as Cesium from 'cesium';
import {
  HEIGHT_GATE_M,
  MOVE_END_DEBOUNCE_MS,
  cameraFetchPlan,
  deriveViewCentre,
  viewSpanKm,
} from '../../sources/hamRepeaters.js';

/** Where the camera looks, how high it is and how wide the view is. */
export function createCamera({ state: layerState, parts }) {
  function cameraView() {
    const viewer = layerState._viewer;
    const carto = viewer?.camera?.positionCartographic;
    if (!carto) return null;
    const nadir = {
      lat: Cesium.Math.toDegrees(carto.latitude),
      lon: Cesium.Math.toDegrees(carto.longitude),
    };
    let hit = null;
    try {
      const canvas = viewer.scene?.canvas;
      const width = canvas?.clientWidth || canvas?.width || 0;
      const height = canvas?.clientHeight || canvas?.height || 0;
      if (
        width &&
        height &&
        typeof viewer.camera.pickEllipsoid === 'function'
      ) {
        const point = viewer.camera.pickEllipsoid(
          new Cesium.Cartesian2(width / 2, height / 2),
          Cesium.Ellipsoid.WGS84,
        );
        if (point) {
          const hitCarto = Cesium.Cartographic.fromCartesian(point);
          hit = {
            lat: Cesium.Math.toDegrees(hitCarto.latitude),
            lon: Cesium.Math.toDegrees(hitCarto.longitude),
          };
        }
      }
    } catch {
      hit = null;
    }
    const centre = deriveViewCentre({ nadir, hit, heightM: carto.height });
    let spanKm = null;
    try {
      const rectangle = viewer.camera.computeViewRectangle?.(
        viewer.scene?.globe?.ellipsoid || Cesium.Ellipsoid.WGS84,
      );
      if (rectangle)
        spanKm =
          viewSpanKm({
            south: Cesium.Math.toDegrees(rectangle.south),
            north: Cesium.Math.toDegrees(rectangle.north),
            west: Cesium.Math.toDegrees(rectangle.west),
            east: Cesium.Math.toDegrees(rectangle.east),
          })?.spanKm ?? null;
    } catch {
      spanKm = null;
    }
    if (spanKm === null) spanKm = Math.max(30, (carto.height / 1000) * 1.2);
    return { heightM: carto.height, centre, spanKm };
  }

  function scheduleCameraLoad() {
    if (!layerState._enabled) return;
    clearTimeout(layerState._debounceTimer);
    layerState._debounceTimer = setTimeout(() => {
      layerState._debounceTimer = null;
      void loadFromCamera({ origin: 'camera' });
    }, MOVE_END_DEBOUNCE_MS);
  }

  function installCameraWatch() {
    const camera = layerState._viewer?.camera;
    if (!camera?.moveEnd || layerState._removeMoveEnd) return;
    layerState._removeMoveEnd = camera.moveEnd.addEventListener(() =>
      scheduleCameraLoad(),
    );
  }

  function removeCameraWatch() {
    layerState._removeMoveEnd?.();
    layerState._removeMoveEnd = null;
    clearTimeout(layerState._debounceTimer);
    layerState._debounceTimer = null;
  }

  /** Load around the view when the fetch plan says so (or `force` bypasses the gate). */
  async function loadFromCamera({
    force = false,
    origin = 'camera',
    signal = null,
  } = {}) {
    const view = cameraView();
    if (!view) {
      layerState._gate = Object.freeze({
        heightM: null,
        withinGate: false,
        gateM: HEIGHT_GATE_M,
      });
      parts.presentation.emitState();
      return { ok: false, fetched: false, reason: 'no-camera' };
    }
    const plan = cameraFetchPlan({
      heightM: view.heightM,
      centre: view.centre,
      spanKm: view.spanKm,
      last: layerState._area,
      force,
    });
    const gateChanged = layerState._gate.withinGate !== plan.withinGate;
    layerState._gate = Object.freeze({
      heightM: Math.round(view.heightM),
      withinGate: plan.withinGate,
      gateM: HEIGHT_GATE_M,
    });
    if (!plan.fetch) {
      if (gateChanged) parts.presentation.emitState();
      return {
        ok: true,
        fetched: false,
        reason: plan.reason,
        area: layerState._area,
      };
    }
    const result = await parts.ingestion.loadAround(
      plan.lat,
      plan.lon,
      plan.radiusKm,
      {
        origin,
        reason: plan.reason,
        signal,
      },
    );
    return { ...result, fetched: result.ok, reason: plan.reason };
  }

  /** LOAD HERE: the view centre, whatever the height. */
  function loadHere(options = {}) {
    return loadFromCamera({
      force: true,
      origin: options.origin || 'user',
      signal: options.signal || null,
    });
  }

  return {
    cameraView,
    scheduleCameraLoad,
    installCameraWatch,
    removeCameraWatch,
    loadFromCamera,
    loadHere,
  };
}
