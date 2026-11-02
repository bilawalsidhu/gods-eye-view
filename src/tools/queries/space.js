/** Space queries: launches, satellite passes and satellites overhead. */

import { suggestView } from '../views.js';
import { twoline2satrec } from 'satellite.js';
import {
  findNextSatellitePass,
  lookAnglesAt,
} from '../../data/satellitePass.js';
import { parseTleText, tleCatalogNumber } from '../../sources/tle.js';
import { POINT_SCHEMA, resolvePoint } from '../area.js';
import { defineTool, ToolError } from '../catalog.js';
import { LIMIT_SCHEMA, capRows, countNoun, isoTime } from '../results.js';

const text = (value) => (typeof value === 'string' && value ? value : null);

export const getRecentLaunches = defineTool({
  name: 'get_recent_launches',
  title: 'Recent launches',
  description:
    'Orbital launches from Launch Library 2 over the last 30 days, newest ' +
    'first, with provider, rocket, pad, mission and outcome.',
  inputSchema: {
    type: 'object',
    properties: { limit: LIMIT_SCHEMA },
    additionalProperties: false,
  },
  requires: ['launches'],
  async run(args, { services, signal }) {
    const { payload, stale } = services.launches.getLaunchSnapshot
      ? await services.launches.getLaunchSnapshot({ signal })
      : {
          payload: await services.launches.getLaunches({ signal }),
          stale: false,
        };
    const launches = Array.isArray(payload) ? payload : payload.results;
    if (!Array.isArray(launches))
      throw new ToolError('malformed', 'The launch feed returned no launches');
    const rows = launches
      .map((launch) => ({
        id: text(launch?.id),
        name: text(launch?.name),
        time: text(launch?.net),
        status: text(launch?.status?.name),
        provider: text(launch?.launch_service_provider?.name),
        rocket: text(
          launch?.rocket?.configuration?.full_name ??
            launch?.rocket?.configuration?.name,
        ),
        pad: text(launch?.pad?.name),
        location: text(launch?.pad?.location?.name),
        mission: text(launch?.mission?.name),
        orbit: text(launch?.mission?.orbit?.name),
      }))
      .filter((launch) => launch.name)
      .sort((a, b) => String(b.time).localeCompare(String(a.time)));
    const result = capRows(rows, args.limit);
    return {
      summary:
        `${countNoun(rows.length, 'launch', 'launches')} in the last 30 days${rows[0] ? `; latest ${rows[0].name}` : ''}` +
        (stale ? ' (data may be stale).' : '.'),
      data: {
        view: suggestView(services, {
          point: { lat: 20, lon: 0 },
          altitudeM: 15_000_000,
          layers: ['rocket-launches'],
        }),
        ...result,
        stale,
      },
    };
  },
});

// Groups served by the satellite catalog route; `stations` includes the ISS.
const GROUPS = [
  'stations',
  'visual',
  'gps-ops',
  'glo-ops',
  'galileo',
  'geo',
  'starlink',
];
const ISS_NORAD = 25544;
const COMPASS = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
];
const GROUP_SCHEMA = {
  type: 'string',
  enum: GROUPS,
  description: 'CelesTrak group to search (default "stations").',
};

const compass = (degrees) =>
  COMPASS[Math.round((((degrees % 360) + 360) % 360) / 22.5) % 16];
const round = (value, digits) =>
  Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const nowMs = (services) => services.clock?.now() ?? Date.now();

/** A view following a satellite from above an observer. */
function followSatellite(services, point, satellite) {
  return satellite.norad
    ? suggestView(services, {
        point,
        altitudeM: 3_000_000,
        follow: { kind: 'satellite', id: String(satellite.norad) },
      })
    : null;
}

async function readCatalog(services, group, signal) {
  const result = await services.satellites.readGroup(group, { signal });
  if (!result.ok)
    throw new ToolError(
      'unavailable',
      `The ${group} satellite catalog is unavailable (HTTP ${result.status})`,
    );
  const entries = parseTleText(result.text).flatMap((entry) => {
    try {
      return [
        {
          ...entry,
          norad: tleCatalogNumber(entry.line1),
          satrec: twoline2satrec(entry.line1, entry.line2),
        },
      ];
    } catch {
      return [];
    }
  });
  // The proxy serves its last copy when CelesTrak is down; old orbital
  // elements make predictions drift.
  return { entries, stale: result.stale === true };
}

function matchSatellite(entries, wanted) {
  if (wanted == null)
    return entries.find((entry) => entry.norad === ISS_NORAD) ?? null;
  const text = String(wanted).trim().toUpperCase();
  const number = /^\d+$/.test(text) ? Number(text) : null;
  return (
    entries.find((entry) => number != null && entry.norad === number) ??
    entries.find((entry) => entry.name.toUpperCase() === text) ??
    entries.find((entry) => entry.name.toUpperCase().includes(text)) ??
    null
  );
}

export const nextSatellitePass = defineTool({
  name: 'next_satellite_pass',
  title: 'Next satellite pass',
  description:
    'When a satellite next rises over an observer, with rise, peak and set ' +
    'times, peak elevation, rise direction and naked-eye visibility. Defaults ' +
    'to the International Space Station.',
  inputSchema: {
    type: 'object',
    properties: {
      location: POINT_SCHEMA,
      satellite: {
        type: 'string',
        minLength: 1,
        maxLength: 80,
        description:
          'Satellite name or NORAD catalog number (default the ISS).',
      },
      group: GROUP_SCHEMA,
      min_elevation_deg: { type: 'number', minimum: 0, maximum: 80 },
      visible_only: {
        type: 'boolean',
        description: 'Only passes visible to the naked eye.',
      },
      hours: { type: 'number', minimum: 1, maximum: 72 },
    },
    required: ['location'],
    additionalProperties: false,
  },
  requires: ['satellites'],
  async run(args, { services, signal }) {
    const point = await resolvePoint(args.location, { services, signal });
    const group = args.group ?? 'stations';
    const { entries, stale } = await readCatalog(services, group, signal);
    const staleNote = stale ? ' (orbit data may be stale)' : '';
    const satellite = matchSatellite(entries, args.satellite);
    if (!satellite)
      throw new ToolError(
        'invalid_arguments',
        `No satellite matching "${args.satellite ?? 'ISS'}" is in the ${group} group`,
      );
    const hours = args.hours ?? 24;
    const pass = findNextSatellitePass({
      satrec: satellite.satrec,
      latDeg: point.lat,
      lonDeg: point.lon,
      fromMs: nowMs(services),
      minElevDeg: args.min_elevation_deg ?? 10,
      horizonHours: hours,
      requireVisible: args.visible_only === true,
    });
    const name = satellite.name;
    if (!pass)
      return {
        summary: `${name} has no ${args.visible_only ? 'visible ' : ''}pass over ${point.label} in the next ${hours} hours${staleNote}.`,
        data: {
          view: followSatellite(services, point, satellite),
          stale,
          location: point,
          satellite: name,
          norad: satellite.norad,
          pass: null,
        },
      };
    return {
      summary:
        `${name} next rises over ${point.label} at ${isoTime(pass.riseMs)} in the ${compass(pass.riseAzDeg)}, ` +
        `peaking at ${Math.round(pass.maxElevDeg)}°` +
        `${pass.visible ? '; visible to the naked eye' : ''}${staleNote}.`,
      data: {
        view: followSatellite(services, point, satellite),
        stale,
        location: point,
        satellite: name,
        norad: satellite.norad,
        pass: {
          rise: isoTime(pass.riseMs),
          peak: isoTime(pass.maxElevMs),
          set: isoTime(pass.setMs),
          max_elevation_deg: round(pass.maxElevDeg, 1),
          rise_azimuth_deg: round(pass.riseAzDeg, 0),
          rise_direction: compass(pass.riseAzDeg),
          visible: pass.visible,
        },
      },
    };
  },
});

export const satellitesOverhead = defineTool({
  name: 'satellites_overhead',
  title: 'Satellites overhead',
  description:
    'Satellites in a group that are above an observer right now, highest first, ' +
    'with elevation and direction.',
  inputSchema: {
    type: 'object',
    properties: {
      location: POINT_SCHEMA,
      group: GROUP_SCHEMA,
      min_elevation_deg: { type: 'number', minimum: 0, maximum: 90 },
      limit: LIMIT_SCHEMA,
    },
    required: ['location'],
    additionalProperties: false,
  },
  requires: ['satellites'],
  async run(args, { services, signal }) {
    const point = await resolvePoint(args.location, { services, signal });
    const group = args.group ?? 'stations';
    const minimum = args.min_elevation_deg ?? 10;
    const at = nowMs(services);
    const { entries, stale } = await readCatalog(services, group, signal);
    const rows = entries
      .flatMap((entry) => {
        const look = lookAnglesAt(entry.satrec, at, point.lat, point.lon);
        return look && look.elevDeg >= minimum
          ? [
              {
                name: entry.name,
                norad: entry.norad,
                elevation_deg: round(look.elevDeg, 1),
                azimuth_deg: round(look.azDeg, 0),
                direction: compass(look.azDeg),
              },
            ]
          : [];
      })
      .sort((a, b) => b.elevation_deg - a.elevation_deg);
    return {
      summary:
        `${countNoun(rows.length, 'satellite')} from the ${group} group ${rows.length === 1 ? 'is' : 'are'} at least ${minimum}° above ${point.label} at ${isoTime(at)}` +
        (stale ? ' (orbit data may be stale).' : '.'),
      data: {
        view: suggestView(services, {
          point,
          altitudeM: 3_000_000,
          layers: ['satellites'],
        }),
        ...capRows(rows, args.limit),
        stale,
        location: point,
        group,
        at: isoTime(at),
      },
    };
  },
});
