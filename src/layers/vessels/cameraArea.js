import { toLonLatH } from '../../geo/ellipsoid.js';
import { canvasOf, findCamera, findQuery } from '../../render/rendererOf.js';
import { viewAreaRadiusKm } from './viewArea.js';

/**
 * The area a viewer is looking at, as `{ lat, lon, radiusKm }`: centered on
 * the point in the middle of the screen (or below the camera when the middle
 * shows sky), sized by the camera's height. Null for a view that wants every
 * vessel.
 */
export function vesselViewArea(viewer) {
  const pose = findCamera(viewer)?.pose();
  const radiusKm = viewAreaRadiusKm(pose?.height);
  if (radiusKm == null) return null;
  let { lat, lon } = pose;
  const canvas = canvasOf(viewer);
  if (canvas?.clientWidth && canvas?.clientHeight) {
    try {
      const hit = findQuery(viewer)?.pickEllipsoid(
        canvas.clientWidth / 2,
        canvas.clientHeight / 2,
      );
      const center = hit ? toLonLatH(hit) : null;
      if (center) ({ lat, lon } = center);
    } catch {
      /* the camera position stands in */
    }
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon, radiusKm };
}
