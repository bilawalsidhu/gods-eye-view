import { sampleWind, windSpeed } from './model.js';
import { sampleScalar } from './fields.js';

const DIRECTIONS = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
];
export const WIND_UNITS = Object.freeze({
  'km/h': 3.6,
  'm/s': 1,
  mph: 2.2369362921,
});

/** Meteorological bearing is where the wind comes FROM, not where it travels. */
export function windFrom(u, v) {
  if (Math.hypot(u, v) < 0.2) return 'Calm';
  const bearing = ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360;
  return DIRECTIONS[Math.round(bearing / 22.5) % 16];
}

export function formatWindSpeed(speed, units = 'km/h') {
  const unit = Object.hasOwn(WIND_UNITS, units) ? units : 'km/h';
  return `${(speed * WIND_UNITS[unit]).toFixed(1)} ${unit}`;
}

/** A deliberate snapshot at the map center; does not own pointer input. */
export function inspectWindAtCenter(
  snapshot,
  viewer,
  cesium,
  { units, overlay, model, validTime, status, position } = {},
) {
  const scene = viewer?.scene;
  const canvas = scene?.canvas;
  const ellipsoid = scene?.globe?.ellipsoid || cesium.Ellipsoid?.WGS84;
  const point =
    position ||
    (canvas &&
      viewer.camera?.pickEllipsoid?.(
        new cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2),
        ellipsoid,
      ));
  if (!point || !snapshot?.u || !snapshot?.v)
    return {
      coordinates: 'No surface reading',
      wind: 'Aim the map center at Earth',
      model,
      validTime,
      status,
      explanation:
        'A location reading needs a loaded forecast and the Earth at the center of the view.',
    };
  const location = cesium.Cartographic.fromCartesian(point, ellipsoid);
  const lon = cesium.Math.toDegrees(location.longitude);
  const lat = cesium.Math.toDegrees(location.latitude);
  const vector = sampleWind(
    { ...snapshot.grid, u: snapshot.u, v: snapshot.v },
    lon,
    lat,
  );
  const speed = windSpeed(vector.u, vector.v);
  const from = windFrom(vector.u, vector.v);
  const scalar = ['temperature', 'pressure'].includes(overlay)
    ? sampleScalar(snapshot, lon, lat, overlay)
    : null;
  return {
    position: point,
    speed,
    from,
    units,
    coordinates: `${Math.abs(lat).toFixed(2)}°${lat < 0 ? 'S' : 'N'} · ${Math.abs(lon).toFixed(2)}°${lon < 0 ? 'W' : 'E'}`,
    wind: `${formatWindSpeed(speed, units)}${from === 'Calm' ? ' · calm' : ` from ${from}`}`,
    scalarKind: overlay,
    scalarLabel:
      overlay === 'speed'
        ? 'Wind speed'
        : overlay === 'temperature'
          ? 'Air temperature · 2 m'
          : overlay === 'pressure'
            ? 'Sea-level pressure'
            : null,
    scalarValue:
      overlay === 'speed'
        ? formatWindSpeed(speed, units)
        : scalar == null
          ? null
          : `${scalar.toFixed(1)} ${overlay === 'temperature' ? '°C' : 'hPa'}`,
    model,
    validTime,
    status,
    explanation:
      'Interpolated model forecast on an approximately 1° grid. Broad weather patterns, not a street-level measurement.',
  };
}

/** One passive marker for the captured location; it never samples on camera movement. */
export function createWindInspectionMarker({ container, viewer, cesium }) {
  let removeRender = null;
  let marker = null;
  const clear = () => {
    removeRender?.();
    removeRender = null;
    marker?.remove();
    marker = null;
    viewer?.scene?.requestRender?.();
  };
  return {
    show(position) {
      clear();
      const scene = viewer?.scene;
      if (
        !position ||
        !container?.ownerDocument?.createElement ||
        !scene?.postRender?.addEventListener ||
        !scene.cartesianToCanvasCoordinates
      )
        return;
      marker = container.ownerDocument.createElement('div');
      marker.className = 'gev-wind-inspection-marker';
      marker.setAttribute('aria-hidden', 'true');
      marker.style.cssText =
        'position:absolute;width:18px;height:18px;border:2px solid #fff;border-radius:50%;box-shadow:0 0 0 2px #153440,0 0 0 5px rgba(102,225,242,.35);transform:translate(-50%,-50%);pointer-events:none;z-index:150;';
      container.appendChild(marker);
      const occluder = new cesium.EllipsoidalOccluder(
        scene.globe?.ellipsoid || cesium.Ellipsoid.WGS84,
        viewer.camera.positionWC,
      );
      const render = () => {
        occluder.cameraPosition = viewer.camera.positionWC;
        const point = scene.cartesianToCanvasCoordinates(position);
        const visible =
          point &&
          point.x >= 0 &&
          point.y >= 0 &&
          point.x <= scene.canvas.clientWidth &&
          point.y <= scene.canvas.clientHeight &&
          (scene.mode !== cesium.SceneMode.SCENE3D ||
            occluder.isPointVisible(position));
        marker.hidden = !visible;
        if (!visible) return;
        const canvasRect = scene.canvas.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        marker.style.left = `${point.x + canvasRect.left - containerRect.left}px`;
        marker.style.top = `${point.y + canvasRect.top - containerRect.top}px`;
      };
      removeRender = scene.postRender.addEventListener(render);
      render();
      scene.requestRender?.();
    },
    clear,
    destroy: clear,
  };
}
