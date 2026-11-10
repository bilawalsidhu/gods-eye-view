import { evaluateWithGeo } from './geometry.mjs';
import { whenSettled, whenTilesLoaded } from './ready.mjs';

/** Preserve the oblique fixture's native collision and flight-arc settings. */
export function moveTrafficCamera(page, view, seconds) {
  return evaluateWithGeo(
    page,
    async (geo, view, duration) => {
      const { engine, viewer } = window.__godsEyeView;
      const native = engine.kind === 'cesium';
      const camera = native ? viewer.camera : engine.camera;
      // These low-altitude fixture poses must not be lifted by native collision.
      if (native)
        viewer.scene.screenSpaceCameraController.enableCollisionDetection = false;
      camera.cancelFlight();
      await new Promise((resolve) =>
        camera.flyTo({
          destination: geo.cartesian3.fromDegrees(
            view.lon,
            view.lat,
            view.height,
          ),
          orientation: {
            heading: ((view.heading ?? 0) * Math.PI) / 180,
            pitch: ((view.pitch ?? -45) * Math.PI) / 180,
            roll: 0,
          },
          duration,
          // An automatic high arc crosses the traffic layer's activation ceiling.
          maximumHeight: Math.max(view.height, engine.camera.height()),
          complete: resolve,
          cancel: resolve,
        }),
      );
    },
    view,
    seconds,
  );
}

/** Compare the layer's camera-event sample with the view currently on screen. */
export function trafficReadiness() {
  const { engine, dataManager } = window.__godsEyeView;
  const pose = engine.camera.pose();
  const view = [
    pose.cartographic.latitude,
    pose.cartographic.longitude,
    pose.cartographic.height / 10000,
    pose.heading,
    pose.pitch,
  ];
  const layer = dataManager.layers.get('traffic').module;
  const stats = layer.getStats();
  const work = layer.getLoadingDiagnostics();
  const coverageViewKey = stats.roadBounds?.coverage?.viewKey ?? null;
  const coverage = coverageViewKey?.split(',').map(Number);
  // Allow rounding and sub-metre settling, not another altitude or camera view.
  // Angles are radians; scaled height has a one-metre tolerance.
  const tolerances = [1e-7, 1e-7, 1e-4, 1e-6, 1e-6];
  const viewMatches = Boolean(
    coverage?.length === view.length &&
    view.every((value, i) => {
      if (!Number.isFinite(value) || !Number.isFinite(coverage[i]))
        return false;
      const delta = value - coverage[i];
      const distance =
        i === 1 || i === 3
          ? Math.abs(Math.atan2(Math.sin(delta), Math.cos(delta)))
          : Math.abs(delta);
      return distance <= tolerances[i];
    }),
  );
  return {
    viewKey: view.map((value) => Number(value).toFixed(7)).join(','),
    coverageViewKey,
    viewMatches,
    count: stats.count,
    loading: stats.loading,
    surfacePending: stats.surfacePending,
    ...work,
    error: stats.error,
    detailError: stats.detailError,
    // Missing local heights can outlive the last pass in an oblique view.
    // Wait for acquisition, publication and scheduled refinement to finish.
    settled:
      viewMatches && stats.count > 0 && !stats.loading && !work.surfaceWaiting,
  };
}

/** A quiet loader can still be waiting for its camera-change debounce. */
export async function whenTrafficSettled(page) {
  await whenTilesLoaded(page);
  await whenSettled(page);
  let handle;
  try {
    handle = await page.waitForFunction(`(${trafficReadiness})().settled`, {
      timeout: 60000,
      polling: 100,
    });
  } catch (error) {
    if (error.name !== 'TimeoutError') throw error;
    const observed = await page.evaluate(trafficReadiness);
    throw new Error(`Readiness timeout: traffic; ${JSON.stringify(observed)}`, {
      cause: error,
    });
  } finally {
    await handle?.dispose();
  }
}
