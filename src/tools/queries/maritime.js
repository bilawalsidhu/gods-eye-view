/** Maritime queries over the live vessel source (src/sources/live). */

import { suggestView } from '../views.js';
import { defineTool, ToolError } from '../catalog.js';
import {
  AREA_SCHEMA,
  areaCenter,
  areaContains,
  areaRadiusKm,
  distanceKm,
  resolveArea,
} from '../area.js';
import {
  LIMIT_SCHEMA,
  capRows,
  countNoun,
  isoTime,
  thinEvenly,
} from '../results.js';

const MMSI_SCHEMA = Object.freeze({
  type: 'string',
  pattern: '^\\d{5,10}$',
  description: 'Maritime Mobile Service Identity, such as "366999712".',
});
const MAX_TRACK_POINTS = 200;
const ALL_VESSELS = 1_000_000;

const round = (value, digits) =>
  Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const text = (value) => (typeof value === 'string' && value ? value : null);

function vesselRow(record, from) {
  const point = { lat: record.latitude, lon: record.longitude };
  return {
    mmsi: record.id,
    name: text(record.name),
    imo: text(record.imo),
    type: text(record.type),
    destination: text(record.destination),
    lat: round(record.latitude, 5),
    lon: round(record.longitude, 5),
    speed_mps: round(record.speedMps, 1),
    course_deg: round(record.courseDeg, 0),
    heading_deg: round(record.headingDeg, 0),
    observed_at: isoTime(record.observedAtMs),
    ...(from ? { distance_km: round(distanceKm(from, point), 1) } : {}),
  };
}

/**
 * Every vessel the source retains, or with `area`, every vessel around it.
 * The source's default is the newest few thousand, which can leave out a
 * vessel the server still holds; asking for more than any server keeps lets
 * the server return all of them. The area lets a server answer for that
 * place alone; callers still keep only the vessels inside it.
 */
function readVessels(services, signal, area) {
  const center = area ? areaCenter(area) : null;
  return services.vessels.getSnapshot(
    {
      maxRows: ALL_VESSELS,
      ...(center
        ? {
            area: {
              lat: center.lat,
              lon: center.lon,
              radiusKm: areaRadiusKm(area),
            },
          }
        : {}),
    },
    { signal },
  );
}

function snapshotInfo(snapshot) {
  return {
    source: snapshot.source ?? null,
    coverage: snapshot.coverage ?? null,
    observed_at: isoTime(snapshot.observedAtMs),
    freshness: snapshot.freshness ?? 'unknown',
  };
}

export const vesselsInArea = defineTool({
  name: 'vessels_in_area',
  title: 'Vessels in an area',
  description:
    'Ships currently reported by AIS inside an area, nearest the center ' +
    'first, optionally filtered by vessel type.',
  inputSchema: {
    type: 'object',
    properties: {
      area: AREA_SCHEMA,
      type: {
        type: 'string',
        minLength: 1,
        maxLength: 40,
        description: 'Vessel type to match, such as "tanker" or "cargo".',
      },
      limit: LIMIT_SCHEMA,
    },
    required: ['area'],
    additionalProperties: false,
  },
  requires: ['vessels'],
  async run(args, { services, signal }) {
    const area = await resolveArea(args.area, { services, signal });
    const center = areaCenter(area);
    const snapshot = await readVessels(services, signal, area);
    const wanted = args.type?.toLowerCase();
    const rows = snapshot.records
      .filter(
        (record) =>
          areaContains(area, { lat: record.latitude, lon: record.longitude }) &&
          (!wanted || String(record.type).toLowerCase().includes(wanted)),
      )
      .map((record) => vesselRow(record, center))
      .sort((a, b) => a.distance_km - b.distance_km);
    const kind = args.type ? `${args.type} vessel` : 'vessel';
    return {
      summary:
        `${countNoun(rows.length, kind)} in ${area.label}` +
        (snapshot.freshness === 'stale' ? ' (data may be stale).' : '.'),
      data: {
        view: suggestView(services, { area, layers: ['ais-live-vessels'] }),
        ...capRows(rows, args.limit),
        ...snapshotInfo(snapshot),
      },
    };
  },
});

export const findVessel = defineTool({
  name: 'find_vessel',
  title: 'Find a vessel',
  description:
    'Find ships currently reported anywhere by MMSI, IMO number or name. ' +
    'Names match when they contain the given text.',
  inputSchema: {
    type: 'object',
    properties: {
      mmsi: MMSI_SCHEMA,
      imo: { type: 'string', pattern: '^\\d{7}$' },
      name: { type: 'string', minLength: 2, maxLength: 60 },
      limit: LIMIT_SCHEMA,
    },
    additionalProperties: false,
  },
  requires: ['vessels'],
  async run(args, { services, signal }) {
    const given = ['mmsi', 'imo', 'name'].filter((key) => args[key] != null);
    if (given.length !== 1)
      throw new ToolError(
        'invalid_arguments',
        'Give exactly one of mmsi, imo or name',
      );
    const [key] = given;
    const wanted = args[key].trim().toUpperCase();
    const matches = {
      mmsi: (record) => record.id === wanted,
      imo: (record) => String(record.imo).replace(/^IMO/i, '') === wanted,
      name: (record) => String(record.name).toUpperCase().includes(wanted),
    }[key];
    const snapshot = await readVessels(services, signal);
    const rows = snapshot.records
      .filter(matches)
      .map((record) => vesselRow(record));
    return {
      summary: rows.length
        ? `Found ${countNoun(rows.length, 'vessel')} with ${key} ${args[key]}.`
        : `No vessel with ${key} ${args[key]} is currently reported.`,
      data: {
        // Ships cannot be followed from a link; one match is framed closely.
        view:
          rows.length === 1
            ? suggestView(services, {
                point: { lat: rows[0].lat, lon: rows[0].lon },
                layers: ['ais-live-vessels'],
                altitudeM: 5_000,
              })
            : null,
        ...capRows(rows, args.limit),
        ...snapshotInfo(snapshot),
      },
    };
  },
});

export const getVesselTrack = defineTool({
  name: 'get_vessel_track',
  title: 'Vessel track',
  description:
    'Recent positions of one ship by MMSI, oldest first. Long tracks are ' +
    `evenly thinned to at most ${MAX_TRACK_POINTS} points.`,
  inputSchema: {
    type: 'object',
    properties: { mmsi: MMSI_SCHEMA },
    required: ['mmsi'],
    additionalProperties: false,
  },
  requires: ['vessels'],
  async run(args, { services, signal }) {
    const track = await services.vessels.getTrack(args.mmsi, { signal });
    const points = track.records
      .filter((point) => Number.isFinite(point.observedAtMs))
      .sort((a, b) => a.observedAtMs - b.observedAtMs);
    const kept = thinEvenly(points, MAX_TRACK_POINTS);
    return {
      summary: points.length
        ? `${countNoun(points.length, 'position')} for ${args.mmsi} from ${isoTime(points[0].observedAtMs)} to ${isoTime(points.at(-1).observedAtMs)}.`
        : `No recent track is available for ${args.mmsi}.`,
      data: {
        view: kept.length
          ? suggestView(services, {
              point: { lat: kept.at(-1).latitude, lon: kept.at(-1).longitude },
              layers: ['ais-live-vessels'],
              altitudeM: 20_000,
            })
          : null,
        mmsi: args.mmsi,
        total: points.length,
        returned: kept.length,
        thinned: kept.length < points.length,
        points: kept.map((point) => ({
          time: isoTime(point.observedAtMs),
          lat: round(point.latitude, 5),
          lon: round(point.longitude, 5),
        })),
      },
    };
  },
});
