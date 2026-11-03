/** The bundled Bhote Koshi 2026 outburst flood event pack. */

import { suggestView } from '../views.js';
import { BHOTE_KOSHI_FLOOD_PATH } from '../../data/bhoteKoshiFloodPath.js';
import { defineTool, ToolError } from '../catalog.js';
import { distanceKm } from '../area.js';

const EVENT_ID = 'bhote-koshi-2026';
const ATTRIBUTION =
  'Imagery: Vantor Open Data; reconstruction: GeoPera (CC BY-NC 4.0). ' +
  'Linked witness posts and the GeoGeorgeShadrach geolocation map keep ' +
  "their owners' terms.";

const round = (value, digits) =>
  Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

/** Length of a `[lon, lat]` line in kilometers. */
function pathLengthKm(path) {
  let total = 0;
  for (let index = 1; index < path.length; index += 1)
    total += distanceKm(
      { lat: path[index - 1][1], lon: path[index - 1][0] },
      { lat: path[index][1], lon: path[index][0] },
    );
  return total;
}

const pathPoint = ([lon, lat]) => ({ lat, lon });

/** The box around a `[lon, lat]` path, as an area to frame. */
function pathArea(path) {
  const lons = path.map(([lon]) => lon);
  const lats = path.map(([, lat]) => lat);
  return {
    west: Math.min(...lons),
    south: Math.min(...lats),
    east: Math.max(...lons),
    north: Math.max(...lats),
  };
}

function evidenceRow(record) {
  return {
    sequence: record.sequence ?? null,
    id: record.id,
    title: record.title ?? null,
    summary: record.summary ?? null,
    phase: record.phase ?? null,
    lat: round(record.lat, 5),
    lon: round(record.lon, 5),
    location_confidence: record.confidence?.location ?? null,
    time_confidence: record.confidence?.time ?? null,
    captured_at: record.timing?.capturedAt ?? null,
    in_imagery: record.imageryCoverage === 'within',
    source_url: record.media?.sourceUrl ?? null,
    platform: record.media?.platform ?? null,
    via: record.provenance?.via ?? null,
  };
}

export const getBhoteKoshiFlood = defineTool({
  name: 'get_bhote_koshi_flood',
  title: 'Bhote Koshi flood',
  description:
    "The 26 August 2026 Bhote Koshi outburst flood in Nepal as God's Eye " +
    'View maps it: the evidence trail of geolocated public witness posts ' +
    'from the collapse to Devighat in story order, the mapped flood path, ' +
    'and the before and after satellite imagery. A visualization, not an ' +
    'official hazard model; capture times are unverified.',
  inputSchema: {
    type: 'object',
    properties: {
      phase: {
        type: 'string',
        minLength: 1,
        maxLength: 40,
        description: 'Only evidence in a phase, such as "downstream passage".',
      },
    },
    additionalProperties: false,
  },
  requires: ['events'],
  async run(args, { services, signal }) {
    const event = await services.events.getEvent(EVENT_ID, { signal });
    if (!Array.isArray(event?.evidenceSpine))
      throw new ToolError('malformed', 'The event pack has no evidence');
    const wanted = args.phase?.toLowerCase();
    const evidence = event.evidenceSpine
      .filter((record) => !wanted || record.phase?.toLowerCase() === wanted)
      .sort((a, b) => a.sequence - b.sequence)
      .map(evidenceRow);
    const phases = [
      ...new Set(event.evidenceSpine.map((record) => record.phase)),
    ];
    const lengthKm = round(pathLengthKm(BHOTE_KOSHI_FLOOD_PATH), 1);
    const { imagery = {} } = event;
    return {
      summary:
        `${event.title}, observed ${event.observedDate}: ${evidence.length} ` +
        `evidence record${evidence.length === 1 ? '' : 's'}` +
        (args.phase ? ` in the ${args.phase} phase` : '') +
        ` along a ${lengthKm} km mapped flood path.`,
      data: {
        view: suggestView(services, {
          area: pathArea(BHOTE_KOSHI_FLOOD_PATH),
          layers: ['bhote-koshi-2026'],
        }),
        id: event.id,
        title: event.title,
        observed_date: event.observedDate,
        caveat: event.reconstruction?.caveat ?? null,
        phases,
        evidence,
        witnesses: (event.witnessAnchors || []).map((anchor) => ({
          title: anchor.title ?? null,
          lat: round(anchor.lat, 6),
          lon: round(anchor.lon, 6),
          source_url: anchor.sourceUrl ?? null,
          provenance: anchor.provenance ?? null,
        })),
        flood_path: {
          start: pathPoint(BHOTE_KOSHI_FLOOD_PATH[0]),
          end: pathPoint(BHOTE_KOSHI_FLOOD_PATH.at(-1)),
          length_km: lengthKm,
          description:
            'Simplified river centerline from the debris-dammed lake to Trishuli Bazaar.',
        },
        imagery: {
          box: imagery.rectangle ?? null,
          before: imagery.before
            ? {
                observed_at: imagery.before.observedAt,
                source: imagery.before.source,
              }
            : null,
          after: imagery.after
            ? {
                observed_at: imagery.after.observedAt,
                source: imagery.after.source,
              }
            : null,
        },
        attribution: ATTRIBUTION,
      },
    };
  },
});
