/**
 * WZDx (Work Zone Data Exchange) WorkZoneFeed normalisation, shared by the
 * server snapshot (server/providers/wzdx.js) and its tests. Pure: no Cesium,
 * DOM or i18n catalog.
 *
 * Accepted: WZDx 4.0, 4.1 and 4.2 WorkZoneFeed GeoJSON (usdot-jpo-ode/wzdx
 * schemas/4.x). 4.0 names the header `road_event_feed_info`; 4.1 renamed it
 * `feed_info` and some producers send both. Version 3.x is a different shape
 * (no `core_details`) and no configured feed publishes it, so it is refused
 * rather than half-read.
 */

/** Versions this normaliser reads, as `feed_info.version` states them. */
export const WZDX_VERSIONS = Object.freeze(['4.0', '4.1', '4.2']);
/** Events planned to start further ahead than this are left out. */
export const WZDX_LOOKAHEAD_MS = 7 * 24 * 3600_000;
/** Douglas–Peucker tolerance, about one lane width. */
export const WZDX_SIMPLIFY_M = 11;
export const WZDX_MAX_LINE_VERTICES = 200;
export const WZDX_MAX_EVENT_LINES = 8;
export const WZDX_MAX_EVENT_VERTICES = 600;
export const WZDX_MAX_FEED_EVENTS = 5000;
const MAX_TEXT = 300;
const MAX_ROAD_NAMES = 3;
const MAX_ROAD_NAME = 80;
const MAX_ID = 160;

export const WZDX_EVENT_TYPES = Object.freeze(['work-zone', 'detour']);
export const WZDX_DIRECTIONS = Object.freeze([
  'northbound',
  'eastbound',
  'southbound',
  'westbound',
  'inner-loop',
  'outer-loop',
  'undefined',
  'unknown',
]);
export const WZDX_VEHICLE_IMPACTS = Object.freeze([
  'all-lanes-closed',
  'some-lanes-closed',
  'some-lanes-closed-merge-left',
  'some-lanes-closed-merge-right',
  'some-lanes-closed-split',
  'alternating-one-way',
  'flagging',
  'temporary-traffic-signal',
  'all-lanes-open',
  'all-lanes-open-shift-left',
  'all-lanes-open-shift-right',
  'unknown',
]);

// C0/C1 controls, bidi embeddings/overrides/isolates and zero-width marks.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;

/** Plain, bounded text: tags and control/bidi characters removed. */
export function cleanText(value, max = MAX_TEXT) {
  if (typeof value !== 'string') return null;
  const text = value
    .replace(/<[^>]*>/g, ' ')
    .replace(UNSAFE_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

const instant = (value) => {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

function validPosition(position) {
  if (!Array.isArray(position) || position.length < 2) return false;
  const [lon, lat] = position;
  return (
    Number.isFinite(lon) &&
    Number.isFinite(lat) &&
    Math.abs(lon) <= 180 &&
    Math.abs(lat) <= 90
  );
}

/**
 * Flatten any GeoJSON geometry into lines and points. Every source vertex is
 * validated, not only the ones simplification keeps: one bad vertex makes
 * the whole geometry invalid (null) rather than being silently dropped.
 * @returns {{lines:number[][][], points:number[][]}|null}
 */
export function flattenGeometry(geometry, depth = 0) {
  if (!geometry || typeof geometry !== 'object' || depth > 2) return null;
  const { type, coordinates } = geometry;
  const lines = [];
  const points = [];
  const line = (positions) => {
    if (!Array.isArray(positions) || !positions.every(validPosition))
      return false;
    if (positions.length >= 2) lines.push(positions);
    else if (positions.length === 1) points.push(positions[0]);
    return true;
  };
  switch (type) {
    case 'LineString':
      if (!line(coordinates)) return null;
      break;
    case 'MultiLineString':
      if (!Array.isArray(coordinates) || !coordinates.every(line)) return null;
      break;
    case 'Point':
      if (!validPosition(coordinates)) return null;
      points.push(coordinates);
      break;
    case 'MultiPoint':
      if (!Array.isArray(coordinates) || !coordinates.every(validPosition))
        return null;
      points.push(...coordinates);
      break;
    case 'GeometryCollection': {
      if (!Array.isArray(geometry.geometries)) return null;
      for (const part of geometry.geometries) {
        const flat = flattenGeometry(part, depth + 1);
        if (!flat) return null;
        lines.push(...flat.lines);
        points.push(...flat.points);
      }
      break;
    }
    default:
      return null;
  }
  return { lines, points };
}

const M_PER_DEG = 111_320;

/** Planar metres around a reference latitude (fine at work-zone scale). */
function projector(lat0) {
  const kx = M_PER_DEG * Math.cos((lat0 * Math.PI) / 180);
  return ([lon, lat]) => [lon * kx, lat * M_PER_DEG];
}

function segmentDistance(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length2 = dx * dx + dy * dy;
  const t =
    length2 > 0
      ? Math.max(
          0,
          Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2),
        )
      : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Douglas–Peucker over [lon, lat] positions with a tolerance in metres. */
export function simplifyLine(positions, toleranceM = WZDX_SIMPLIFY_M) {
  if (positions.length <= 2) return positions.slice();
  const project = projector(positions[0][1]);
  const planar = positions.map(project);
  const keep = new Uint8Array(positions.length);
  keep[0] = 1;
  keep[positions.length - 1] = 1;
  const stack = [[0, positions.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let farthest = -1;
    let distance = toleranceM;
    for (let index = first + 1; index < last; index++) {
      const d = segmentDistance(planar[index], planar[first], planar[last]);
      if (d > distance) {
        distance = d;
        farthest = index;
      }
    }
    if (farthest > 0) {
      keep[farthest] = 1;
      stack.push([first, farthest], [farthest, last]);
    }
  }
  return positions.filter((_, index) => keep[index]);
}

/** Evenly thin a line to at most `max` vertices, keeping both ends. */
export function capLine(positions, max = WZDX_MAX_LINE_VERTICES) {
  if (positions.length <= max) return positions;
  const out = [];
  for (let index = 0; index < max; index++)
    out.push(
      positions[Math.round((index * (positions.length - 1)) / (max - 1))],
    );
  return out;
}

const round5 = (value) => Math.round(value * 1e5) / 1e5;
const roundPosition = ([lon, lat]) => [round5(lon), round5(lat)];

/** The point halfway along a line by length. */
export function lineMidpoint(positions) {
  if (positions.length === 1) return positions[0];
  const project = projector(positions[0][1]);
  const planar = positions.map(project);
  const lengths = [];
  let total = 0;
  for (let index = 1; index < planar.length; index++) {
    const length = Math.hypot(
      planar[index][0] - planar[index - 1][0],
      planar[index][1] - planar[index - 1][1],
    );
    lengths.push(length);
    total += length;
  }
  if (!(total > 0)) return positions[0];
  let walked = 0;
  for (let index = 0; index < lengths.length; index++) {
    if (walked + lengths[index] >= total / 2) {
      const t = lengths[index] ? (total / 2 - walked) / lengths[index] : 0;
      const [aLon, aLat] = positions[index];
      const [bLon, bLat] = positions[index + 1];
      return [aLon + (bLon - aLon) * t, aLat + (bLat - aLat) * t];
    }
    walked += lengths[index];
  }
  return positions[positions.length - 1];
}

/** Simplified, capped lines and one marker anchor for an event geometry. */
export function eventGeometry(flat) {
  let budget = WZDX_MAX_EVENT_VERTICES;
  const lines = [];
  for (const source of flat.lines) {
    if (lines.length >= WZDX_MAX_EVENT_LINES || budget < 2) break;
    const line = capLine(
      simplifyLine(source),
      Math.min(WZDX_MAX_LINE_VERTICES, budget),
    ).map(roundPosition);
    budget -= line.length;
    lines.push(line);
  }
  const anchor = lines.length
    ? lineMidpoint(lines[0])
    : flat.points.length
      ? flat.points[0]
      : null;
  return anchor ? { lines, anchor: roundPosition(anchor) } : null;
}

const pick = (value, allowed, fallback) =>
  allowed.includes(value) ? value : fallback;

function workersPresent(properties) {
  const presence = properties.worker_presence;
  if (typeof presence?.are_workers_present === 'boolean')
    return presence.are_workers_present;
  // WZDx 3.x/4.0 producers may still send the older flag.
  return typeof properties.workers_present === 'boolean'
    ? properties.workers_present
    : null;
}

/** The feed header: 4.1+ `feed_info`, or 4.0 `road_event_feed_info`. */
export function wzdxFeedInfo(payload) {
  const info = payload?.feed_info ?? payload?.road_event_feed_info;
  return info && typeof info === 'object' ? info : null;
}

/**
 * Normalise one WZDx WorkZoneFeed into compact event records.
 *
 * Ended events (end_date in the past) and events starting more than
 * WZDX_LOOKAHEAD_MS ahead are left out: the layer shows what is on the road
 * now and in the coming week, and producers routinely keep finished closures
 * in their feeds (Kentucky's had 94 of 233 on 24 Oct 2026) or list projects
 * months ahead. An individually malformed feature is skipped; only a payload
 * that is not a WZDx 4.0–4.2 feature collection is refused.
 *
 * @param {object} payload Parsed feed body.
 * @param {{id:string}} feed The configured feed.
 * @param {{now?:number}} options
 * @returns {{version:string, events:object[], counts:{features:number,
 *   kept:number, ended:number, future:number, invalid:number,
 *   capped:number, duplicateIds:number}, updatedAt:number|null}}
 */
export function normalizeWzdxFeed(payload, feed, { now = Date.now() } = {}) {
  const info = wzdxFeedInfo(payload);
  if (!info || !Array.isArray(payload?.features))
    throw Object.assign(new Error('invalid_feed'), { code: 'invalid' });
  const version = String(info.version ?? '').trim();
  if (!WZDX_VERSIONS.includes(version))
    throw Object.assign(new Error('unsupported_version'), {
      code: 'unsupported_version',
    });
  const counts = {
    features: payload.features.length,
    kept: 0,
    ended: 0,
    future: 0,
    invalid: 0,
    capped: 0,
    duplicateIds: 0,
  };
  const events = [];
  const seen = new Map();
  for (const feature of payload.features) {
    const properties = feature?.properties;
    const core = properties?.core_details;
    const rawId = feature?.id ?? properties?.id;
    const eventType = core?.event_type;
    if (
      !core ||
      typeof core !== 'object' ||
      !WZDX_EVENT_TYPES.includes(eventType) ||
      (typeof rawId !== 'string' && !Number.isFinite(rawId))
    ) {
      counts.invalid++;
      continue;
    }
    const start = instant(properties.start_date);
    const end = instant(properties.end_date);
    if (end !== null && end < now) {
      counts.ended++;
      continue;
    }
    if (start !== null && start > now + WZDX_LOOKAHEAD_MS) {
      counts.future++;
      continue;
    }
    const flat = flattenGeometry(feature.geometry);
    const geometry = flat && eventGeometry(flat);
    if (!geometry) {
      counts.invalid++;
      continue;
    }
    if (events.length >= WZDX_MAX_FEED_EVENTS) {
      counts.capped++;
      continue;
    }
    // Producers reuse one id for several segments (North Dakota and Kentucky
    // both do), so a repeat gets its occurrence number instead of being lost.
    const baseId = `${feed.id}:${String(rawId).slice(0, MAX_ID)}`;
    const occurrence = (seen.get(baseId) ?? 0) + 1;
    seen.set(baseId, occurrence);
    if (occurrence > 1) counts.duplicateIds++;
    const id = occurrence > 1 ? `${baseId}#${occurrence}` : baseId;
    const roads = Array.isArray(core.road_names)
      ? core.road_names
          .map((name) => cleanText(name, MAX_ROAD_NAME))
          .filter(Boolean)
          .slice(0, MAX_ROAD_NAMES)
      : [];
    events.push({
      id,
      feed: feed.id,
      type: eventType,
      roads,
      direction: pick(core.direction, WZDX_DIRECTIONS, 'unknown'),
      description: cleanText(core.description) ?? cleanText(core.name),
      start,
      end,
      // Detours carry no vehicle_impact; it is a work-zone property.
      impact:
        eventType === 'work-zone'
          ? pick(properties.vehicle_impact, WZDX_VEHICLE_IMPACTS, 'unknown')
          : null,
      workers: eventType === 'work-zone' ? workersPresent(properties) : null,
      updated: instant(core.update_date),
      anchor: geometry.anchor,
      lines: geometry.lines,
    });
  }
  counts.kept = events.length;
  return { version, events, counts, updatedAt: instant(info.update_date) };
}

/** Vertex count of a set of events' lines. */
export function eventVertexCount(events) {
  let total = 0;
  for (const event of events)
    for (const line of event.lines) total += line.length;
  return total;
}
