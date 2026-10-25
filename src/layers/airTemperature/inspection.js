import { sampleTemperature } from './fields.js';
import { createWindInspectionMarker } from '../wind/inspection.js';

export function createTemperatureInspection({
  viewer,
  cesium,
  input,
  container,
  getSnapshot,
  onChange,
}) {
  let reading = null;
  let armed = false;
  let lease = null;
  let releaseTimer = null;
  const marker = createWindInspectionMarker({ container, viewer, cesium });
  const release = () => {
    clearTimeout(releaseTimer);
    releaseTimer = null;
    if (lease) input.releasePointer(lease);
    lease = null;
    armed = false;
  };
  function samplePoint(point) {
    if (
      !Number.isFinite(point?.lon) ||
      !Number.isFinite(point?.lat) ||
      Math.abs(point.lat) > 90 ||
      Math.abs(point.lon) > 180
    )
      return false;
    const celsius = sampleTemperature(getSnapshot(), point.lon, point.lat);
    if (celsius === null) return false;
    reading = { lon: point.lon, lat: point.lat, celsius };
    marker.show(cesium.Cartesian3.fromDegrees(point.lon, point.lat));
    onChange();
    return true;
  }
  function sampleScreen(position) {
    const ellipsoid = viewer.scene?.globe?.ellipsoid ?? cesium.Ellipsoid.WGS84;
    const world = viewer.camera.pickEllipsoid(position, ellipsoid);
    if (!world) return false;
    const location = cesium.Cartographic.fromCartesian(world, ellipsoid);
    return samplePoint({
      lon: cesium.Math.toDegrees(location.longitude),
      lat: cesium.Math.toDegrees(location.latitude),
    });
  }
  const handler =
    cesium.ScreenSpaceEventHandler && viewer.scene?.canvas
      ? new cesium.ScreenSpaceEventHandler(viewer.scene.canvas)
      : null;
  handler?.setInputAction((click) => {
    if (!armed || !input?.isLeaseCurrent(lease)) return;
    if (sampleScreen(click.position)) {
      armed = false;
      // A timer retains ownership through every listener of this same DOM click.
      releaseTimer = setTimeout(release, 0);
      onChange();
    }
  }, cesium.ScreenSpaceEventType.LEFT_CLICK);
  const keydown = (event) => {
    if (event.key === 'Escape' && armed) {
      release();
      onChange();
    }
  };
  const target = container?.ownerDocument;
  target?.addEventListener?.('keydown', keydown);
  return {
    samplePoint,
    sampleCenter() {
      const canvas = viewer.scene?.canvas;
      return canvas
        ? sampleScreen(
            new cesium.Cartesian2(
              canvas.clientWidth / 2,
              canvas.clientHeight / 2,
            ),
          )
        : false;
    },
    setArmed(value) {
      release();
      if (value && handler && getSnapshot()?.scalar) {
        lease = input?.claimPointer('air-temperature') ?? null;
        armed = Boolean(lease);
      }
      onChange();
    },
    isArmed: () => armed,
    getReading: () => reading,
    refresh() {
      if (reading) samplePoint(reading);
    },
    clear() {
      release();
      reading = null;
      marker.clear();
    },
    destroy() {
      this.clear();
      handler?.destroy();
      target?.removeEventListener?.('keydown', keydown);
      marker.destroy();
    },
  };
}
