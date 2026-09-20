import { haversineKm } from '../watchEngine.js';

/**
 * Tool pack: forward prediction. Dead-reckons every recent track ahead in
 * time using the position history buffer, either as an on-globe forecast
 * layer (the scrubber goes past LIVE) or as a direct answer ("which flights
 * will be over the stadium at kickoff?").
 */
export const schemas = Object.freeze([
  {
    name: 'predict_positions',
    description:
      'Show where aircraft and ships will be N minutes from now, dead-reckoned from their current speed and heading, drawn on the globe with confidence fading over time. "Show me five minutes ahead", "fast forward ten minutes". Use resume_live to return.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { minutes: { type: 'number', minimum: 1, maximum: 15 } },
      required: ['minutes'],
    },
  },
  {
    name: 'who_will_be_near',
    description:
      'Which aircraft or ships will be within a radius of a point N minutes from now ("which flights will be over the stadium at kickoff", "what ships reach the harbor in 20 minutes"). Omit latitude/longitude to use the current camera position.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        latitude: { type: 'number' },
        longitude: { type: 'number' },
        km: { type: 'number', minimum: 1, maximum: 500 },
        minutes: { type: 'number', minimum: 1, maximum: 30 },
        layer: {
          type: 'string',
          enum: ['flights', 'military', 'ais-live-vessels', 'any'],
        },
      },
      required: ['km', 'minutes'],
    },
  },
]);

export function createHandlers(context) {
  const history = () =>
    context.getHistory?.() || globalThis.window?.__gevPositionHistory || null;
  return {
    async predict_positions({ minutes = 5 } = {}) {
      const travel = context.getTimeTravel?.();
      if (!travel?.forecast)
        return {
          ok: false,
          error: 'Prediction is not available in this build',
        };
      const range = history()?.range?.();
      if (!range?.newestT)
        return {
          ok: false,
          error: 'No position history yet; try again in a minute',
        };
      const ahead = Math.min(15, Math.max(1, Number(minutes) || 5));
      const ok = travel.forecast(ahead * 60_000);
      const preview =
        history()?.forecastAt?.(Date.now() + ahead * 60_000) || [];
      return {
        ok,
        minutesAhead: ahead,
        tracksPredicted: preview.length,
        note: 'Predicted points fade with confidence; say "back to live" to return.',
      };
    },
    async who_will_be_near({
      latitude,
      longitude,
      km = 25,
      minutes = 10,
      layer = 'any',
    } = {}) {
      const h = history();
      if (!h?.forecastAt)
        return {
          ok: false,
          error: 'Prediction is not available in this build',
        };
      const camera = context.camera?.();
      const lat = Number.isFinite(latitude) ? latitude : camera?.lat;
      const lon = Number.isFinite(longitude) ? longitude : camera?.lon;
      if (!Number.isFinite(lat) || !Number.isFinite(lon))
        return {
          ok: false,
          error: 'No point given and camera position unavailable',
        };
      const at = Date.now() + Math.min(30, Math.max(1, minutes)) * 60_000;
      const predicted = h.forecastAt(at, [], { maxAheadMs: 30 * 60_000 });
      const hits = predicted
        .filter((e) => layer === 'any' || e.layerId === layer)
        .map((e) => ({
          ...e,
          distanceKm: Math.round(haversineKm(e.lat, e.lon, lat, lon) * 10) / 10,
        }))
        .filter((e) => e.distanceKm <= km)
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .slice(0, 15)
        .map((e) => ({
          layerId: e.layerId,
          id: e.id,
          label: e.label,
          distanceKm: e.distanceKm,
          confidence: Math.round(e.confidence * 100) / 100,
          ...(Number.isFinite(e.heightM) && e.heightM > 0
            ? { altitudeM: Math.round(e.heightM) }
            : {}),
        }));
      return {
        ok: true,
        minutesAhead: minutes,
        center: { latitude: lat, longitude: lon, km },
        count: hits.length,
        predicted: hits,
        caveat:
          'Straight-line dead reckoning from the last known speed and heading; confidence decays with lead time.',
      };
    },
  };
}
