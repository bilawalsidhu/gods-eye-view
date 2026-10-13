import { readResponseJsonCapped } from './httpBody.js';

/** Same-origin acquisition boundary. A missing provider never becomes synthetic data. */
export function createAreaAssessmentSource({ fetchImpl = fetch } = {}) {
  return {
    async read(metric, point, { signal, metrics, radius } = {}) {
      const query = new URLSearchParams({
        metric,
        lat: point.lat,
        lon: point.lon,
      });
      if (metric === 'nearby') {
        query.set('metrics', metrics.join(','));
        query.set('radius', radius);
      }
      const timeout = AbortSignal.timeout(metric === 'nearby' ? 240000 : 90000);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const response = await fetchImpl(`/api/area-assessment?${query}`, {
        signal: combined,
      });
      if (!response.ok) throw new Error('Source unavailable. Try again later.');
      const data = await readResponseJsonCapped(
        response,
        metric === 'nearby' ? 1024000 : 512000,
        combined,
      );
      if (
        data.metric !== metric ||
        !['available', 'unavailable'].includes(data.status)
      )
        throw new Error('Invalid source response.');
      return data;
    },
  };
}
