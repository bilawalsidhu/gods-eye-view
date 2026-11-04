/** Current, source-dated AQHI readings near an area; no map or provider mutation. */
import {
  AIR_QUALITY_PROVIDERS,
  OBSERVATION_MAX_AGE_MS,
  airQualityBandById,
  readingsAreStale,
} from '../../layers/airQuality/model.js';
import { defineTool, ToolError } from '../catalog.js';
import {
  AREA_SCHEMA,
  areaCenter,
  areaContains,
  distanceKm,
  resolveArea,
} from '../area.js';
import { LIMIT_SCHEMA, capRows, countNoun, isoTime } from '../results.js';

const CLOCK_SKEW_MS = 5 * 60_000;
const cleanName = (value) =>
  typeof value === 'string'
    ? value.replace(/[\p{C}\s]+/gu, ' ').trim().slice(0, 100) || null
    : null;

export const getAirQuality = defineTool({
  name: 'get_air_quality',
  title: 'Air quality observations',
  description:
    'Current Canadian Air Quality Health Index (AQHI) station readings in an area. ' +
    'Reports observed times, scale, health-risk bands and source coverage; ' +
    'missing or stale observations must not be interpreted as clean air.',
  inputSchema: {
    type: 'object',
    properties: { area: AREA_SCHEMA, limit: LIMIT_SCHEMA },
    required: ['area'],
    additionalProperties: false,
  },
  requires: ['airQuality'],
  async run(args, { services, signal }) {
    const area = await resolveArea(args.area, { services, signal });
    const readings = await services.airQuality.getSnapshot({ signal });
    if (!Array.isArray(readings))
      throw new ToolError('malformed', 'Air quality source returned no reading list');

    const now = Date.now();
    const center = areaCenter(area);
    const eligible = readings.filter(
      (reading) =>
        reading &&
        AIR_QUALITY_PROVIDERS[reading.provider] &&
        Number.isFinite(reading.value) &&
        Number.isFinite(reading.lat) &&
        Number.isFinite(reading.lon) &&
        Number.isFinite(reading.observedMs) &&
        reading.observedMs <= now + CLOCK_SKEW_MS &&
        now - reading.observedMs <= OBSERVATION_MAX_AGE_MS &&
        airQualityBandById(reading.band) &&
        areaContains(area, { lat: reading.lat, lon: reading.lon }),
    );
    const rows = eligible
      .map((reading) => {
        const provider = AIR_QUALITY_PROVIDERS[reading.provider];
        return {
          id: cleanName(reading.id),
          station: cleanName(reading.name),
          provider: reading.provider,
          scale: provider.scale,
          value: reading.value,
          band: reading.band,
          health_risk: airQualityBandById(reading.band).risk,
          lat: Number(reading.lat.toFixed(5)),
          lon: Number(reading.lon.toFixed(5)),
          observed_at: isoTime(reading.observedMs),
          distance_km: Number(
            distanceKm(center, { lat: reading.lat, lon: reading.lon }).toFixed(1),
          ),
        };
      })
      .sort(
        (a, b) =>
          a.distance_km - b.distance_km ||
          (a.id ?? '').localeCompare(b.id ?? ''),
      );
    const stale = readingsAreStale(eligible, now);
    const newest = eligible.length
      ? Math.max(...eligible.map((reading) => reading.observedMs))
      : null;
    const count = countNoun(rows.length, 'AQHI observation');
    return {
      summary: rows.length
        ? count + ' in ' + area.label + " from Canada's ECCC network" +
          (stale ? ' (data may be stale)' : '') + '.'
        : 'No current ECCC AQHI observations in ' + area.label +
          '; ECCC covers Canada only, and missing readings do not imply clean air.',
      data: {
        source: AIR_QUALITY_PROVIDERS.eccc.network,
        coverage: AIR_QUALITY_PROVIDERS.eccc.coverage,
        scale: AIR_QUALITY_PROVIDERS.eccc.scale,
        stale,
        newest_observation_at: isoTime(newest),
        ...capRows(rows, args.limit),
      },
    };
  },
});
