import {
  nearbyAreaPoints,
  servicesAtCandidate,
} from '../../../src/data/areaAssessment.js';

/** One interactive search at a time; no background crawling or invented observations. */
export function createNearbySearch(providers) {
  let busy = false;
  return async (point, { metrics, radius }) => {
    if (busy)
      return {
        status: 'unavailable',
        reason: 'Another nearby search is running. Try again shortly.',
      };
    busy = true;
    try {
      const started = Date.now();
      const safeRead = async (metric, location) => {
        try {
          return {
            ...(await providers[metric](location)),
            fetchedAt: new Date().toISOString(),
          };
        } catch {
          return {
            status: 'unavailable',
            reason: 'Source temporarily unavailable.',
          };
        }
      };
      const services = metrics.includes('services')
        ? await safeRead('services', point)
        : null;
      const candidates = [];
      for (const location of nearbyAreaPoints(point, radius)) {
        if (Date.now() - started > 150000) break;
        const observations = Object.fromEntries(
          await Promise.all(
            metrics.map(async (metric) => [
              metric,
              metric === 'services'
                ? servicesAtCandidate(services, location)
                : await safeRead(metric, location),
            ]),
          ),
        );
        candidates.push({ point: location, observations });
      }
      return {
        status: 'available',
        candidates,
        radius,
        warning:
          'Up to nine sampled locations, not an exhaustive search or a guarantee of the best place. Source resolution may be coarser than the spacing. Service comparisons reuse the same non-exhaustive POI sample.',
      };
    } finally {
      busy = false;
    }
  };
}
