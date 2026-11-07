/** Natural hazard queries: earthquakes and active fires. */

import { suggestView } from '../views.js';
import { defineTool, ToolError } from '../catalog.js';
import { AREA_SCHEMA, areaContains, resolveArea } from '../area.js';
import { LIMIT_SCHEMA, capRows, countNoun, isoTime } from '../results.js';
import {
  FIRMS_CONFIDENCE_MODES,
  MIN_FRP_MW_MAX,
  MIN_FRP_MW_MIN,
  firePassesFilter,
  normalizeFireFilter,
} from '../../data/firmsIntensity.js';
import { normalizeConfidence } from '../../data/firmsAdapt.js';

function acquiredMsUtc(acqDate, acqTime) {
  if (typeof acqDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(acqDate))
    return NaN;
  const timeText = String(acqTime ?? '').trim();
  if (!/^\d{1,4}$/.test(timeText)) return NaN;
  const hhmm = timeText.padStart(4, '0');
  const hours = Number(hhmm.slice(0, 2));
  const minutes = Number(hhmm.slice(2, 4));
  if (hours > 23 || minutes > 59) return NaN;
  const timestamp = Date.parse(
    `${acqDate}T${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}:00.000Z`,
  );
  return Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === acqDate
    ? timestamp
    : NaN;
}

export const getEarthquakes = defineTool({
  name: 'get_earthquakes',
  title: 'Recent earthquakes',
  description:
    'Earthquakes of magnitude 2.5 or more from the USGS feed for the last 24 ' +
    'hours, strongest first. Optionally limited to an area and a minimum magnitude.',
  inputSchema: {
    type: 'object',
    properties: {
      area: AREA_SCHEMA,
      min_magnitude: { type: 'number', minimum: 2.5, maximum: 10 },
      limit: LIMIT_SCHEMA,
    },
    additionalProperties: false,
  },
  requires: ['earthquakes'],
  async run(args, { services, signal }) {
    const area = args.area
      ? await resolveArea(args.area, { services, signal })
      : null;
    const minimum = args.min_magnitude ?? 2.5;
    const events = (await services.earthquakes.getSnapshot({ signal }))
      .filter(
        (event) => event.mag >= minimum && (!area || areaContains(area, event)),
      )
      .sort((a, b) => b.mag - a.mag || (b.time ?? 0) - (a.time ?? 0));
    const result = capRows(events, args.limit);
    const where = area ? ` in ${area.label}` : ' worldwide';
    const strongest = events[0]
      ? `; strongest M${events[0].mag.toFixed(1)}${events[0].place ? ` ${events[0].place}` : ''}`
      : '';
    return {
      summary: `${countNoun(events.length, 'earthquake')} of M${minimum}+ in the last 24 hours${where}${strongest}.`,
      data: {
        view: suggestView(
          services,
          area
            ? { area, layers: ['earthquakes'] }
            : {
                point: { lat: 20, lon: 0 },
                altitudeM: 15_000_000,
                layers: ['earthquakes'],
              },
        ),
        ...result,
        rows: result.rows.map((event) => ({
          id: event.usgsId ?? event.stableId,
          magnitude: event.mag,
          place: event.place,
          time: isoTime(event.time),
          lat: event.lat,
          lon: event.lon,
          depth_km: event.depthKm,
        })),
      },
    };
  },
});

export const getActiveFires = defineTool({
  name: 'get_active_fires',
  title: 'Active fires',
  description:
    'Satellite fire detections from NASA FIRMS in the last 24 hours within an ' +
    'area, most intense (fire radiative power) first. Optionally limited to a ' +
    'minimum fire radiative power in megawatts and a confidence level — the ' +
    "same filter as the Active Fires layer's intensity controls.",
  inputSchema: {
    type: 'object',
    properties: {
      area: AREA_SCHEMA,
      min_frp_mw: {
        type: 'number',
        minimum: MIN_FRP_MW_MIN,
        maximum: MIN_FRP_MW_MAX,
        description:
          'Hide detections weaker than this fire radiative power (MW). ' +
          'A typical detection is ~6 MW; 20 MW keeps the top tenth, 100 MW the top percent.',
      },
      confidence: {
        type: 'string',
        enum: [...FIRMS_CONFIDENCE_MODES],
        description:
          '"all" (default), "nominal" (nominal and high), or "high". Many of the ' +
          'strongest fires are rated low confidence, so prefer "all" unless asked.',
      },
      limit: LIMIT_SCHEMA,
    },
    required: ['area'],
    additionalProperties: false,
  },
  requires: ['fires'],
  async run(args, { services, signal }) {
    const area = await resolveArea(args.area, { services, signal });
    const snapshot = await services.fires.getSnapshot({ signal });
    if (snapshot.keyRequired)
      throw new ToolError(
        'unavailable',
        'Fire detections need a NASA FIRMS key configured for this server',
      );
    const filter = normalizeFireFilter({
      minFrp: args.min_frp_mw,
      confidence: args.confidence,
    });
    const fires = snapshot.fires
      .filter(
        (fire) =>
          areaContains(area, fire) &&
          firePassesFilter(
            {
              frp: Number(fire.frp),
              confidence: normalizeConfidence(fire.confidence),
            },
            filter,
          ),
      )
      .sort((a, b) => (b.frp ?? 0) - (a.frp ?? 0));
    const filterNotes = [
      ...(filter.minFrp > 0 ? [`≥ ${filter.minFrp} MW`] : []),
      ...(filter.confidence !== 'all'
        ? [
            `${filter.confidence === 'high' ? 'high' : 'nominal or high'} confidence`,
          ]
        : []),
    ];
    const result = capRows(fires, args.limit);
    // The proxy serves its last good snapshot when a refresh fails, and marks
    // satellites whose download failed.
    const stale = snapshot.stale === true;
    const missing = (snapshot.sources || [])
      .filter((source) => source?.ok === false)
      .map((source) => source.source);
    const notes = [
      ...(stale ? ['data may be stale'] : []),
      ...(missing.length ? [`no data from ${missing.join(', ')}`] : []),
    ];
    return {
      summary:
        `${countNoun(fires.length, 'fire detection')}` +
        (filterNotes.length ? ` (${filterNotes.join(', ')})` : '') +
        ` in ${area.label} in the last 24 hours` +
        (notes.length ? ` (${notes.join('; ')}).` : '.'),
      data: {
        view: suggestView(services, { area, layers: ['local-firms'] }),
        filter: {
          min_frp_mw: filter.minFrp,
          confidence: filter.confidence,
        },
        stale,
        missing_sources: missing,
        fetched_at: isoTime(snapshot.fetchedAt),
        ...result,
        rows: result.rows.map((fire) => ({
          lat: fire.lat,
          lon: fire.lon,
          frp_mw: fire.frp ?? null,
          confidence: fire.confidence ?? null,
          acquired: isoTime(acquiredMsUtc(fire.acqDate, fire.acqTime)),
          satellite: fire.satellite ?? null,
          day_night: fire.daynight ?? null,
        })),
      },
    };
  },
});
