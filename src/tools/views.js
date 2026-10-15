/**
 * Suggested views: the God's Eye View view that shows a tool's answer, and
 * the link that opens it when the app's address is known.
 */

import { createView, viewUrl } from '../view/index.js';
import { areaCenter, areaRadiusKm } from './area.js';

const MIN_ALTITUDE_M = 500;
const MAX_ALTITUDE_M = 15_000_000;
// A top-down view sees roughly this many meters of ground per meter of altitude.
const GROUND_PER_ALTITUDE = 0.55;
const POINT_ALTITUDE_M = 50_000;

/** A camera looking straight down that frames a resolved area. */
export function cameraForArea(area) {
  const center = areaCenter(area);
  return {
    lat: center.lat,
    lon: center.lon,
    altitude_m: Math.min(
      MAX_ALTITUDE_M,
      Math.max(
        MIN_ALTITUDE_M,
        (areaRadiusKm(area) * 1000) / GROUND_PER_ALTITUDE,
      ),
    ),
  };
}

const EARTH_RADIUS_M = 6_371_008.8;

/**
 * The camera position for looking at a point from `altitudeM` with a heading
 * and a tilt: straight above it when looking down, otherwise pulled back
 * along the heading so the point stays in the middle of the view.
 */
export function cameraLookingAt(
  target,
  { altitudeM, headingDeg = 0, pitchDeg = -90 },
) {
  const camera = {
    lat: target.lat,
    lon: target.lon,
    altitude_m: altitudeM,
    heading_deg: headingDeg,
    pitch_deg: pitchDeg,
  };
  if (pitchDeg <= -89.5) return camera;
  // Ground distance from the camera to the point it looks at, on flat ground.
  const back = altitudeM / Math.tan((-Math.min(pitchDeg, -5) * Math.PI) / 180);
  const heading = (headingDeg * Math.PI) / 180;
  const lat =
    target.lat -
    ((back * Math.cos(heading)) / EARTH_RADIUS_M) * (180 / Math.PI);
  const lon =
    target.lon -
    ((back * Math.sin(heading)) /
      (EARTH_RADIUS_M * Math.cos((target.lat * Math.PI) / 180))) *
      (180 / Math.PI);
  return {
    ...camera,
    lat: Math.max(-90, Math.min(90, lat)),
    lon: ((((lon + 180) % 360) + 360) % 360) - 180,
  };
}

/** The app's address, or null when it is not configured. */
function appUrl(services) {
  try {
    return services.app?.baseUrl ? new URL(services.app.baseUrl).href : null;
  } catch {
    return null;
  }
}

/**
 * A view of an area or point with layers on and optionally something
 * followed, plus `url` (null without the app's address). A point is framed
 * from `altitudeM` above it.
 */
export function suggestView(
  services,
  { area, point, layers = [], follow = null, altitudeM = POINT_ALTITUDE_M },
) {
  const camera = area
    ? cameraForArea(area)
    : { lat: point.lat, lon: point.lon, altitude_m: altitudeM };
  const view = createView({ camera, layers, follow });
  const base = appUrl(services);
  return { ...view, url: base ? viewUrl(base, view) : null };
}
