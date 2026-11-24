/**
 * @module irishRail
 * @description Adapter for the Irish Rail realtime API's running-trains list
 * (`getCurrentTrainsXML`), turning it into the train records the GTFS-RT path
 * produces.
 *
 * The document is a flat list of `<objTrainPositions>` elements, each with
 * seven text children (TrainStatus, TrainLatitude, TrainLongitude, TrainCode,
 * TrainDate, PublicMessage, Direction). That schema is all this reads, so it
 * is read with a small scanner instead of an XML library: no DTDs, no entity
 * definitions, no attributes, no nesting beyond those two levels. A document
 * that declares a DTD or entities is refused, and every size is capped (whole
 * text, train count, field length).
 *
 * Positions are NOT GPS: the operator places each train at the station or
 * timing point its signalling system last reported. The record says so with
 * `positionSource: 'event'` (added by the rail proxy). The feed carries no
 * time for that report, so a record's time is the fetch time, labelled
 * `timestampSource: 'fetch'`, which the layer ages conservatively.
 *
 * Pure: no Node built-ins, safe for node:test and any server runtime.
 */

import { isPlausibleVehiclePosition } from './gtfsRealtime.js';

/** Longest document read (characters). A full day's list is about 35 KB. */
export const IRISH_RAIL_MAX_TEXT_CHARS = 1024 * 1024;
/** Most trains read from one document; about 80 run at once. */
export const IRISH_RAIL_MAX_TRAINS = 2000;
/** Longest accepted field (characters); the public message is the longest. */
export const IRISH_RAIL_MAX_FIELD_CHARS = 512;

const FIELDS = Object.freeze([
  'TrainStatus',
  'TrainLatitude',
  'TrainLongitude',
  'TrainCode',
  'TrainDate',
  'PublicMessage',
  'Direction',
]);

/** Error for a document this adapter will not read. */
export class IrishRailFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IrishRailFormatError';
  }
}

const NAMED_ENTITIES = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
});

/**
 * Decode the five predefined XML entities and numeric character references.
 * An unknown entity is left as written (no DTD can define one here).
 * @param {string} text
 * @returns {string}
 */
export function decodeXmlText(text) {
  return String(text).replace(
    /&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,4});/g,
    (whole, body) => {
      if (body[0] === '#') {
        const code =
          body[1] === 'x' || body[1] === 'X'
            ? Number.parseInt(body.slice(2), 16)
            : Number.parseInt(body.slice(1), 10);
        return Number.isInteger(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : whole;
      }
      return Object.hasOwn(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : whole;
    },
  );
}

/**
 * The text of `<name>...</name>` inside one train element, `''` for an empty
 * or self-closing element, null when absent or over the field cap.
 */
function readField(block, name) {
  const open = `<${name}>`;
  const start = block.indexOf(open);
  if (start < 0) {
    return block.includes(`<${name}/>`) || block.includes(`<${name} />`)
      ? ''
      : null;
  }
  const from = start + open.length;
  const end = block.indexOf(`</${name}>`, from);
  if (end < 0 || end - from > IRISH_RAIL_MAX_FIELD_CHARS * 6) return null;
  const value = decodeXmlText(block.slice(from, end)).trim();
  return value.length <= IRISH_RAIL_MAX_FIELD_CHARS ? value : null;
}

/**
 * Split the running-trains document into raw train rows.
 * @param {string} text
 * @returns {{rows: Array<Record<string, string|null>>, truncated: boolean}}
 */
export function parseIrishRailTrainsXml(text) {
  if (typeof text !== 'string') throw new IrishRailFormatError('not text');
  if (text.length > IRISH_RAIL_MAX_TEXT_CHARS)
    throw new IrishRailFormatError(`document is ${text.length} characters`);
  if (/<!DOCTYPE|<!ENTITY/i.test(text))
    throw new IrishRailFormatError('document declares a DTD');
  if (!text.includes('<ArrayOfObjTrainPositions'))
    throw new IrishRailFormatError('not a running-trains document');
  const rows = [];
  let truncated = false;
  const OPEN = '<objTrainPositions>';
  const CLOSE = '</objTrainPositions>';
  let at = text.indexOf(OPEN);
  while (at >= 0) {
    const end = text.indexOf(CLOSE, at + OPEN.length);
    if (end < 0) break;
    if (rows.length >= IRISH_RAIL_MAX_TRAINS) {
      truncated = true;
      break;
    }
    const block = text.slice(at + OPEN.length, end);
    const row = {};
    for (const name of FIELDS) row[name] = readField(block, name);
    rows.push(row);
    at = text.indexOf(OPEN, end + CLOSE.length);
  }
  return { rows, truncated };
}

/**
 * Read the three lines of a public message. The operator separates lines
 * with a literal backslash-n; a real newline is accepted too.
 *
 *   A118\n14:50 - Dublin Connolly to Belfast (0 mins late)\nDeparted Dundalk next stop Newry
 *   E244\nHowth to Bray\nExpected Departure 16:35
 *   A311\n15:05 - Tralee to Mallow(-2 mins late)\nTERMINATED Mallow at 16:34
 *
 * @param {string|null} message
 * @returns {{origin: string|null, destination: string|null,
 *   scheduledDeparture: string|null, delaySec: number|null,
 *   event: 'departed'|'arrived'|'expected'|'terminated'|null,
 *   lastStop: string|null, nextStop: string|null}}
 */
export function parsePublicMessage(message) {
  const result = {
    origin: null,
    destination: null,
    scheduledDeparture: null,
    delaySec: null,
    event: null,
    lastStop: null,
    nextStop: null,
  };
  const lines = String(message ?? '')
    .split(/\\n|\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const route =
    /^(?:(\d{1,2}:\d{2})\s*-\s*)?(.+?)\s+to\s+(.+?)(?:\s*\((-?\d{1,4})\s*mins?\s+late\))?$/i.exec(
      lines[1] || '',
    );
  if (route) {
    result.scheduledDeparture = route[1] || null;
    result.origin = route[2].trim();
    result.destination = route[3].trim();
    if (route[4] !== undefined) result.delaySec = Number(route[4]) * 60;
  }
  const event = lines[2] || '';
  let match;
  if (
    (match = /^(Departed|Arrived)\s+(.+?)\s+next stop\s+(.+)$/i.exec(event))
  ) {
    result.event =
      match[1].toLowerCase() === 'departed' ? 'departed' : 'arrived';
    result.lastStop = match[2].trim();
    result.nextStop = match[3].trim();
  } else if (/^Expected Departure\b/i.test(event)) {
    result.event = 'expected';
  } else if (
    (match = /^TERMINATED\s+(.+?)\s+at\s+\d{1,2}:\d{2}/i.exec(event))
  ) {
    result.event = 'terminated';
    result.lastStop = match[1].trim();
  }
  return result;
}

/**
 * Turn the running-trains document into unclassified train records in the
 * shape the GTFS-RT path produces (src/data/gtfsRealtime.js), plus the
 * delay the public message states (`delaySec`). The message's last and next
 * stop and the row's direction only decide `status`; nothing reads them
 * further, so they do not leave the server.
 *
 * Status `T` (terminated) trains are dropped: they are out of service, parked
 * at the end of their run. Status `N` trains are due to start within ten
 * minutes and stand at their origin (`STOPPED_AT`). A running train is
 * `STOPPED_AT` after "Arrived" and `IN_TRANSIT_TO` its next stop after
 * "Departed".
 *
 * @param {string} text The XML document.
 * @param {number} fetchedAtS Fetch time (epoch seconds), the only time the
 *   feed lets a record carry.
 * @returns {{entityCount: number, truncated: boolean, vehicles: object[]}}
 */
export function decodeIrishRailTrains(text, fetchedAtS) {
  const { rows, truncated } = parseIrishRailTrainsXml(text);
  const seen = new Set();
  const vehicles = [];
  for (const row of rows) {
    const code = row.TrainCode;
    if (!code || !/^[A-Z0-9]{1,8}$/.test(code) || seen.has(code)) continue;
    const status = row.TrainStatus;
    if (status !== 'R' && status !== 'N') continue;
    const lat = Number.parseFloat(row.TrainLatitude ?? '');
    const lon = Number.parseFloat(row.TrainLongitude ?? '');
    if (!isPlausibleVehiclePosition(lat, lon)) continue;
    seen.add(code);
    const message = parsePublicMessage(row.PublicMessage);
    const routeId =
      message.origin && message.destination
        ? `${message.origin} - ${message.destination}`
        : null;
    vehicles.push({
      id: code,
      lat: Number(lat.toFixed(6)),
      lon: Number(lon.toFixed(6)),
      bearing: null,
      speedMps: null,
      timestamp: fetchedAtS,
      timestampSource: 'fetch',
      routeId,
      tripId: code,
      directionId: null,
      label: routeId
        ? `${code} ${message.origin} to ${message.destination}`
        : code,
      stopId: null,
      status:
        // i18n-ignore: GTFS-Realtime status codes, not UI text
        status === 'N' || message.event === 'arrived'
          ? 'STOPPED_AT'
          : message.event === 'departed'
            ? 'IN_TRANSIT_TO'
            : null,
      occupancy: null,
      delaySec: message.delaySec,
    });
  }
  return { entityCount: rows.length, truncated, vehicles };
}
