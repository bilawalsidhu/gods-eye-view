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

/** A quiet loader can still be waiting for its camera-change debounce. */
export async function whenTrafficSettled(page) {
  await whenTilesLoaded(page);
  await whenSettled(page);
  const handle = await page.waitForFunction(
    () => {
      const { engine, dataManager } = window.__godsEyeView;
      const pose = engine.camera.pose();
      const viewKey = [
        pose.cartographic.latitude,
        pose.cartographic.longitude,
        pose.cartographic.height / 10000,
        pose.heading,
        pose.pitch,
      ]
        .map((value) => Number(value || 0).toFixed(7))
        .join(',');
      const stats = dataManager.layers.get('traffic').module.getStats();
      return (
        stats.roadBounds?.coverage?.viewKey === viewKey &&
        stats.count > 0 &&
        !stats.loading &&
        !stats.surfacePending
      );
    },
    { timeout: 60000, polling: 100 },
  );
  await handle.dispose();
}
