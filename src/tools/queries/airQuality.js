/** Read-only air-quality observations, using the layer's portable model. */
import {
  AIR_QUALITY_PROVIDERS,
  OBSERVATION_MAX_AGE_MS,
  airQualityBandById,
  readingsAreStale,
} from '../../layers/airQuality/model.js';
import { suggestView } from '../views.js';
import { defineTool, ToolError } from '../catalog.js';
import {
  AREA_SCHEMA,
  areaCenter,
  areaContains,
  distanceKm,
  resolveArea,
} from '../area.js';
import { LIMIT_SCHEMA, capRows, isoTime } from '../results.js';

const round = (value, digits) =>
  Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

function displayText(value) {
  if (typeof value !== 'string') return null;
  return (
    value
      .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160) || null
  );
}

/** The query reports observations, not an inference of air quality where none exist. */
export const getAirQuality = defineTool({
  name: 'get_air_quality',
  title: 'Air quality observations',
  description:
    'Recent air-quality station readings in an area, nearest first, with ' +
    'their original index scale, risk band, observation time, and coverage. ' +
    'The current ECCC AQHI provider covers Canada only.',
  inputSchema: {
    type: 'object',
    properties: { area: AREA_SCHEMA, limit: LIMIT_SCHEMA },
    required: ['area'],
    additionalProperties: false,
  },
  requires: ['airQuality'],
  async run(args, { services, signal }) {
    const area = await resolveArea(args.area, { services, signal });
    const snapshot = await services.airQuality.getSnapshot({ signal });
    if (!Array.isArray(snapshot))
      throw new ToolError(
        'malformed',
        'Air-quality observations are malformed',
      );
    const now = Date.now();
    // The source already rejects observations older than six hours. Recheck
    // at query time because a cached source result may have aged since then.
    const current = snapshot.filter(
      (reading) =>
        Object.hasOwn(AIR_QUALITY_PROVIDERS, reading?.provider) &&
        Number.isFinite(reading?.value) &&
        airQualityBandById(reading?.band) &&
        Number.isFinite(reading?.lat) &&
        Number.isFinite(reading?.lon) &&
        Number.isFinite(reading?.observedMs) &&
        reading.observedMs <= now &&
        now - reading.observedMs <= OBSERVATION_MAX_AGE_MS,
    );
    const center = areaCenter(area);
    const matched = current.filter((reading) =>
      areaContains(area, { lat: reading.lat, lon: reading.lon }),
    );
    const stale = readingsAreStale(matched, now);
    const rows = matched
      .map((reading) => ({
        id: displayText(reading.id),
        station: displayText(reading.name),
        provider: reading.provider,
        scale: reading.scale,
        value: reading.value,
        band: reading.band,
        risk: airQualityBandById(reading.band).risk,
        lat: round(reading.lat, 5),
        lon: round(reading.lon, 5),
        observed_at: isoTime(reading.observedMs),
        distance_km: round(distanceKm(center, reading), 1),
      }))
      .sort(
        (a, b) =>
          a.distance_km - b.distance_km ||
          String(a.id).localeCompare(String(b.id)),
      );
    const coverage = AIR_QUALITY_PROVIDERS.eccc.coverage;
    const summary = rows.length
      ? `${rows.length} recent air-quality station ${rows.length === 1 ? 'reading' : 'readings'} in ${area.label}${stale ? ' (feed may be stale)' : ''}.`
      : `No recent ECCC AQHI readings found in ${area.label}. This does not establish clean air; the current network covers Canada only.`;
    return {
      summary,
      data: {
        view: suggestView(services, { area, layers: ['air-quality'] }),
        coverage,
        source: AIR_QUALITY_PROVIDERS.eccc.network,
        stale,
        max_observation_age_ms: OBSERVATION_MAX_AGE_MS,
        ...capRows(rows, args.limit),
      },
    };
  },
});
