import { passesImageryFilter } from '../../filter.js';
import { metresBetween } from '../../view.js';
import { NEAREST_LIMIT, NEAREST_RADIUS_M } from './policy.js';

/**
 * Id of the nearest image around a point that passes the resolved imagery
 * filter, or null. An aborted `signal` gives up (the source may reject).
 */
export async function nearestImageId(
  source,
  { lat, lon },
  filter,
  { signal } = {},
) {
  const images = await source.nearestImages(
    { lat, lon, radius: NEAREST_RADIUS_M, limit: NEAREST_LIMIT },
    { signal },
  );
  // The API returns the images in the radius in no particular order.
  const metres = (record) => {
    const [lon2, lat2] = (record.computed_geometry || record.geometry)
      ?.coordinates || [NaN, NaN];
    const d = metresBetween({ lon, lat }, { lon: lon2, lat: lat2 });
    return Number.isFinite(d) ? d : Infinity;
  };
  const hit = [...images]
    .sort((a, b) => metres(a) - metres(b))
    .find((record) =>
      passesImageryFilter(
        {
          isPano: record.is_pano === true,
          capturedAt: Number(record.captured_at) || 0,
        },
        filter,
      ),
    );
  return hit ? String(hit.id) : null;
}
