/** Bike-share and public transit queries. */

import { suggestView } from '../views.js';
import {
  parseStationInformation,
  parseStationStatus,
} from '../../sources/gbfsStations.js';
import {
  FEED_STALE_AFTER_MS,
  isStaleVehicleFix,
} from '../../layers/transit/policy.js';
import { defineTool, ToolError } from '../catalog.js';
import {
  AREA_SCHEMA,
  areaCenter,
  areaContains,
  areaRadiusKm,
  distanceKm,
  resolveArea,
} from '../area.js';
import { LIMIT_SCHEMA, capRows, countNoun, isoTime } from '../results.js';

const MAX_SYSTEMS = 3;

const round = (value, digits) =>
  Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

/**
 * Systems or feeds whose coverage reaches the area, nearest first: the
 * nearest MAX_SYSTEMS are read and the rest are returned as `skipped`.
 */
function covering(area, entries, centerOf, radiusOf) {
  const center = areaCenter(area);
  const reach = areaRadiusKm(area);
  const reaching = entries
    .map((entry) => ({ entry, distance: distanceKm(center, centerOf(entry)) }))
    .filter(({ entry, distance }) => distance <= reach + radiusOf(entry))
    .sort((a, b) => a.distance - b.distance)
    .map(({ entry }) => entry);
  return {
    selected: reaching.slice(0, MAX_SYSTEMS),
    skipped: reaching.slice(MAX_SYSTEMS),
  };
}

/** A note naming systems left out of an answer, or an empty list. */
const skippedNote = (skipped, nameOf) =>
  skipped.length
    ? [
        `${skipped.length} more not searched: ${skipped.map(nameOf).join(', ')}; use a smaller area`,
      ]
    : [];

export const getBikeShare = defineTool({
  name: 'get_bike_share',
  title: 'Bike-share stations',
  description:
    'Live bike-share stations in an area from public GBFS feeds, nearest the ' +
    'center first, with bikes and docks available.',
  inputSchema: {
    type: 'object',
    properties: { area: AREA_SCHEMA, limit: LIMIT_SCHEMA },
    required: ['area'],
    additionalProperties: false,
  },
  requires: ['bikeshare'],
  async run(args, { services, signal }) {
    const area = await resolveArea(args.area, { services, signal });
    const { bikeshare } = services;
    const { selected: systems, skipped } = covering(
      area,
      bikeshare.systems,
      (system) => ({ lat: system.centerLat, lon: system.centerLon }),
      (system) => system.loadRadiusKm,
    );
    if (!systems.length)
      return {
        summary: `No supported bike-share system covers ${area.label}.`,
        data: { ...capRows([], args.limit), systems: [] },
      };
    const center = areaCenter(area);
    const results = await Promise.allSettled(
      systems.map(async (system) => {
        const [information, status] = await Promise.all([
          bikeshare.getStations(system.stationInformationUrl, { signal }),
          bikeshare.getStations(system.stationStatusUrl, { signal }),
        ]);
        const live = parseStationStatus(status);
        return [...parseStationInformation(information).values()].map(
          (station) => ({ system, station, live: live.get(station.stationId) }),
        );
      }),
    );
    signal?.throwIfAborted();
    if (results.every((result) => result.status === 'rejected'))
      throw new ToolError(
        'unavailable',
        'Bike-share feeds are unavailable right now',
      );
    const rows = results
      .flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
      .filter(({ station }) => areaContains(area, station))
      .map(({ system, station, live }) => ({
        system: system.city,
        provider: system.provider ?? null,
        station_id: station.stationId,
        name: station.name || null,
        lat: round(station.lat, 6),
        lon: round(station.lon, 6),
        bikes_available: live?.bikesAvailable ?? null,
        docks_available: live?.docksAvailable ?? null,
        capacity: station.capacity,
        renting: (live?.isRenting ?? station.isRenting) === true,
        returning: (live?.isReturning ?? station.isReturning) === true,
        last_reported: Number.isFinite(live?.lastReported)
          ? isoTime(live.lastReported * 1000)
          : null,
        distance_km: round(distanceKm(center, station), 2),
      }))
      .sort((a, b) => a.distance_km - b.distance_km);
    const bikes = rows.reduce(
      (sum, row) => sum + (row.bikes_available ?? 0),
      0,
    );
    const failed = results.filter(
      (result) => result.status === 'rejected',
    ).length;
    const notes = [
      ...(failed ? [`${countNoun(failed, 'system')} unavailable`] : []),
      ...skippedNote(skipped, (system) => system.city),
    ];
    return {
      summary:
        `${countNoun(rows.length, 'bike-share station')} in ${area.label} with ` +
        `${countNoun(bikes, 'bike')} available` +
        (notes.length ? ` (${notes.join('; ')}).` : '.'),
      data: {
        view: suggestView(services, { area, layers: ['bikeshare'] }),
        ...capRows(rows, args.limit),
        systems: systems.map((system) => system.city),
        systems_not_searched: skipped.map((system) => system.city),
        bikes_available: bikes,
      },
    };
  },
});

export const getTransitVehicles = defineTool({
  name: 'get_transit_vehicles',
  title: 'Transit vehicles',
  description:
    'Live positions of buses, trains and other transit vehicles in an area ' +
    'from public GTFS-Realtime feeds, optionally for one route.',
  inputSchema: {
    type: 'object',
    properties: {
      area: AREA_SCHEMA,
      route: {
        type: 'string',
        minLength: 1,
        maxLength: 64,
        description:
          'Route id or vehicle label to match, such as "1" or "Red".',
      },
      limit: LIMIT_SCHEMA,
    },
    required: ['area'],
    additionalProperties: false,
  },
  requires: ['transit'],
  async run(args, { services, signal }) {
    const area = await resolveArea(args.area, { services, signal });
    const { selected: feeds, skipped } = covering(
      area,
      await services.transit.getFeeds({ signal }),
      (feed) => feed.center,
      (feed) => feed.loadRadiusKm ?? 0,
    );
    if (!feeds.length)
      return {
        summary: `No supported transit feed covers ${area.label}.`,
        data: { ...capRows([], args.limit), feeds: [] },
      };
    const center = areaCenter(area);
    const now = services.clock?.now() ?? Date.now();
    const results = await Promise.allSettled(
      feeds.map(async (feed) => {
        const response = await services.transit.requestSnapshot(feed.id, {
          signal,
        });
        if (!response.ok) throw new Error(`Transit HTTP ${response.status}`);
        const snapshot = await response.json();
        // The app's freshness rules: the operator's fetch time ages the
        // snapshot, and fixes older than the vehicle limit are not shown.
        const fetchedAt = Number.isFinite(snapshot.fetchedAt)
          ? Math.min(snapshot.fetchedAt, now)
          : now;
        const contacted = Number.parseInt(
          response.headers?.get?.('x-transit-contact') || '',
          10,
        );
        const answeredAt = Math.max(
          fetchedAt,
          Number.isFinite(contacted) ? Math.min(contacted, now) : fetchedAt,
        );
        const stale =
          response.headers?.get?.('x-gev-cache') === 'STALE-ERROR' ||
          now - answeredAt > FEED_STALE_AFTER_MS;
        const vehicles = snapshot.vehicles || [];
        const current = vehicles.filter(
          (vehicle) => !isStaleVehicleFix(vehicle, now, fetchedAt),
        );
        return {
          stale,
          expired: vehicles.length - current.length,
          vehicles: current.map((vehicle) => ({ feed, vehicle })),
        };
      }),
    );
    signal?.throwIfAborted();
    if (results.every((result) => result.status === 'rejected'))
      throw new ToolError(
        'unavailable',
        'Transit feeds are unavailable right now',
      );
    const wanted = args.route?.trim().toLowerCase();
    const rows = results
      .flatMap((result) =>
        result.status === 'fulfilled' ? result.value.vehicles : [],
      )
      .filter(({ vehicle }) => areaContains(area, vehicle))
      .filter(
        ({ vehicle }) =>
          !wanted ||
          [vehicle.routeId, vehicle.label].some(
            (value) => String(value || '').toLowerCase() === wanted,
          ),
      )
      .map(({ feed, vehicle }) => ({
        feed: feed.name,
        id: vehicle.id,
        label: vehicle.label ?? null,
        route_id: vehicle.routeId ?? null,
        trip_id: vehicle.tripId ?? null,
        lat: vehicle.lat,
        lon: vehicle.lon,
        bearing_deg: round(vehicle.bearing, 0),
        speed_mps: round(vehicle.speedMps, 1),
        status: vehicle.status ?? null,
        occupancy: vehicle.occupancy ?? null,
        updated: Number.isFinite(vehicle.timestamp)
          ? isoTime(vehicle.timestamp * 1000)
          : null,
        distance_km: round(distanceKm(center, vehicle), 2),
      }))
      .sort((a, b) => a.distance_km - b.distance_km);
    const failed = results.filter(
      (result) => result.status === 'rejected',
    ).length;
    const answered = results
      .filter((result) => result.status === 'fulfilled')
      .map((result) => result.value);
    const staleFeeds = answered.filter((feed) => feed.stale).length;
    const expired = answered.reduce((total, feed) => total + feed.expired, 0);
    const notes = [
      ...(failed ? [`${countNoun(failed, 'feed')} unavailable`] : []),
      ...(staleFeeds
        ? [
            `${countNoun(staleFeeds, 'feed')} stale; positions may be out of date`,
          ]
        : []),
      ...skippedNote(skipped, (feed) => feed.name),
    ];
    const what = args.route ? ` on route ${args.route}` : '';
    return {
      summary:
        `${countNoun(rows.length, 'transit vehicle')}${what} in ${area.label}` +
        (notes.length ? ` (${notes.join('; ')}).` : '.'),
      data: {
        view: suggestView(services, { area, layers: ['transit'] }),
        ...capRows(rows, args.limit),
        stale: staleFeeds > 0,
        expired_positions_dropped: expired,
        feeds_not_searched: skipped.map((feed) => feed.name),
        feeds: feeds.map((feed, index) => ({
          name: feed.name,
          status:
            results[index].status === 'rejected'
              ? 'unavailable'
              : results[index].value.stale
                ? 'stale'
                : 'current',
          operator: feed.operator ?? null,
          attribution: feed.attribution ?? null,
          license: feed.license ?? null,
        })),
      },
    };
  },
});

const FLOW_ZOOMS = [12, 11, 10, 9];
const CONGESTED_LEVEL = 0.5;

/** Length in kilometers of a `[lon, lat]` line. */
function lineKm(coords) {
  let total = 0;
  for (let index = 1; index < coords.length; index += 1)
    total += distanceKm(
      { lat: coords[index - 1][1], lon: coords[index - 1][0] },
      { lat: coords[index][1], lon: coords[index][0] },
    );
  return total;
}

/**
 * The parts of a `[lon, lat]` line inside an area. Box areas keep the whole
 * line (tiles are already clipped to the box); radius areas cut each segment
 * where it crosses the circle, by bisection.
 */
function insideParts(coords, area) {
  if (!area.center) return [coords];
  const inside = ([lon, lat]) => areaContains(area, { lat, lon });
  // Where the segment from-to crosses the circle, on its inside, found by
  // bisection. One end must be inside and the other outside.
  const edge = (from, to) => {
    let a = from;
    let b = to;
    for (let step = 0; step < 20; step += 1) {
      const middle = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (inside(middle) === inside(from)) a = middle;
      else b = middle;
    }
    return inside(from) ? a : b;
  };
  const parts = [];
  let current = inside(coords[0]) ? [coords[0]] : null;
  for (let index = 1; index < coords.length; index += 1) {
    const from = coords[index - 1];
    const to = coords[index];
    const fromIn = inside(from);
    const toIn = inside(to);
    if (fromIn && toIn) current.push(to);
    else if (fromIn) {
      current.push(edge(from, to));
      parts.push(current);
      current = null;
    } else if (toIn) current = [edge(from, to), to];
    else {
      // Both ends outside: the segment may still cut across the circle.
      const middle = Array.from({ length: 15 }, (_, step) => {
        const t = (step + 1) / 16;
        return [
          from[0] + (to[0] - from[0]) * t,
          from[1] + (to[1] - from[1]) * t,
        ];
      }).find(inside);
      if (middle) parts.push([edge(middle, from), edge(middle, to)]);
    }
  }
  if (current) parts.push(current);
  return parts.filter((part) => part.length > 1);
}

async function readFlow(traffic, area, signal) {
  const box = {
    west: area.west,
    south: area.south,
    east: area.east,
    north: area.north,
  };
  for (const zoom of FLOW_ZOOMS) {
    try {
      if (traffic.fetchFlowDetail)
        return await traffic.fetchFlowDetail(box, { zoom, signal });
      return {
        segments: await traffic.fetchFlowForBounds(box, { zoom, signal }),
        partial: false,
      };
    } catch (error) {
      if (error?.code !== 'TILE_VIEW_TOO_WIDE') throw error;
    }
  }
  throw new ToolError(
    'invalid_arguments',
    'The area is too large for traffic detail; use a city-sized area',
  );
}

export const getTrafficFlow = defineTool({
  name: 'get_traffic_flow',
  title: 'Traffic flow',
  description:
    'Live road traffic in a city-sized area from TomTom: average speed as a ' +
    'share of free-flow speed, congested and closed road length, and a ' +
    'breakdown by road category.',
  inputSchema: {
    type: 'object',
    properties: { area: AREA_SCHEMA },
    required: ['area'],
    additionalProperties: false,
  },
  requires: ['traffic'],
  async run(args, { services, signal }) {
    const area = await resolveArea(args.area, { services, signal });
    if (area.west > area.east)
      throw new ToolError(
        'invalid_arguments',
        'The area must not cross the antimeridian',
      );
    const status = await services.traffic.getStatus({ signal });
    if (!status.hasKey)
      throw new ToolError(
        'unavailable',
        'Live traffic needs a TomTom key configured for this server',
      );
    const flow = await readFlow(services.traffic, area, signal);
    // Tiles cover the area's box; a radius area keeps only the parts of each
    // road inside its circle.
    const segments = flow.segments
      .filter(
        (segment) => Array.isArray(segment.coords) && segment.coords.length > 1,
      )
      .flatMap((segment) =>
        insideParts(segment.coords, area).map((coords) => ({
          ...segment,
          coords,
        })),
      );
    const categories = new Map();
    let measuredKm = 0;
    let weighted = 0;
    let congestedKm = 0;
    let closedKm = 0;
    for (const segment of segments) {
      const km = lineKm(segment.coords);
      const key = segment.roadCategory || 'other';
      const entry = categories.get(key) || {
        km: 0,
        weighted: 0,
        congestedKm: 0,
      };
      entry.km += km;
      if (segment.closure) closedKm += km;
      if (Number.isFinite(segment.trafficLevel)) {
        measuredKm += km;
        weighted += segment.trafficLevel * km;
        entry.weighted += segment.trafficLevel * km;
        if (segment.trafficLevel < CONGESTED_LEVEL) {
          congestedKm += km;
          entry.congestedKm += km;
        }
      }
      categories.set(key, entry);
    }
    const percent = (part, whole) =>
      whole > 0 ? Math.round((part / whole) * 100) : null;
    const speedPct = percent(weighted, measuredKm);
    const byCategory = [...categories.entries()]
      .map(([category, entry]) => ({
        category,
        road_km: round(entry.km, 1),
        speed_pct_of_free_flow: percent(entry.weighted, entry.km),
        congested_km: round(entry.congestedKm, 1),
      }))
      .sort((a, b) => b.road_km - a.road_km);
    return {
      summary:
        (segments.length
          ? `Traffic in ${area.label}: ${speedPct ?? 'unknown'}% of free-flow speed on average; ` +
            `${round(congestedKm, 1)} km congested of ${round(measuredKm, 1)} km measured` +
            (closedKm > 0 ? `; ${round(closedKm, 1)} km closed.` : '.')
          : `No live traffic is reported in ${area.label}.`) +
        (flow.partial
          ? ' Some map tiles did not load, so these figures are partial.'
          : ''),
      data: {
        view: suggestView(services, { area, layers: ['traffic'] }),
        area: area.label,
        partial: flow.partial,
        speed_pct_of_free_flow: speedPct,
        measured_km: round(measuredKm, 1),
        congested_km: round(congestedKm, 1),
        closed_km: round(closedKm, 1),
        congested_below_pct: CONGESTED_LEVEL * 100,
        by_category: byCategory,
      },
    };
  },
});
