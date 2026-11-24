/**
 * @module railSiriVm
 * @description Adapter for SIRI Vehicle Monitoring (SIRI Lite `vm`, as
 * Entur publishes it at `api.entur.io/realtime/v1/rest/vm`), turning each
 * `<VehicleActivity>` into the train records the GTFS-RT path produces.
 *
 * Only the handful of elements a position needs are read (RecordedAtTime,
 * ValidUntilTime, LineRef, VehicleMode, VehicleLocation, Bearing, Delay,
 * VehicleJourneyRef, VehicleRef), with a small scanner instead of an XML
 * library: no DTDs, no entity definitions, attributes ignored, an optional
 * namespace prefix on any element. A document that declares a DTD or
 * entities is refused, and every size is capped (whole text, activity count,
 * field length).
 *
 * The positions are the operator's own GPS reports, each with the time it
 * was recorded, so records carry `timestampSource: 'vehicle'`. An activity
 * whose `ValidUntilTime` has passed is dropped, as is one whose
 * `VehicleMode` says it is not a train (Entur lists replacement buses under
 * the train lines).
 *
 * Pure: no Node built-ins, safe for node:test and any server runtime.
 */

import { isPlausibleVehiclePosition } from './gtfsRealtime.js';
import { decodeXmlText } from './irishRail.js';

/** Longest document read (characters). SJ Nord's is about 7 KB. */
export const SIRI_VM_MAX_TEXT_CHARS = 2 * 1024 * 1024;
/** Most activities read from one document. */
export const SIRI_VM_MAX_ACTIVITIES = 5000;
/** Longest accepted field (characters). */
export const SIRI_VM_MAX_FIELD_CHARS = 256;

/** Error for a document this adapter will not read. */
export class SiriVmFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SiriVmFormatError';
  }
}

/** `<Name>` or `<prefix:Name>` (no attributes kept), up to its close. */
function readField(block, name) {
  const match = new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?${name}(?:\\s[^>]*)?>([^<]*)</(?:[A-Za-z_][\\w.-]*:)?${name}>`,
  ).exec(block);
  if (!match || match[1].length > SIRI_VM_MAX_FIELD_CHARS * 6) return null;
  const value = decodeXmlText(match[1]).trim();
  return value.length <= SIRI_VM_MAX_FIELD_CHARS ? value : null;
}

/**
 * Seconds in an ISO 8601 duration as SIRI writes a delay (`PT0S`,
 * `PT2M30S`, `-PT45S`, `P1DT1H`), or null.
 * @param {string|null} text
 * @returns {number|null}
 */
export function parseIsoDurationSec(text) {
  const match =
    /^(-)?P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
      String(text ?? '').trim(),
    );
  if (!match || !(match[2] || match[3] || match[4] || match[5])) return null;
  const [, sign, d = 0, h = 0, m = 0, s = 0] = match;
  const total =
    Number(d) * 86_400 + Number(h) * 3600 + Number(m) * 60 + Number(s);
  return Math.round(sign ? -total : total);
}

/** Epoch seconds of an ISO date-time with its offset, or null. */
function epochSeconds(text) {
  const ms = Date.parse(String(text ?? ''));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/**
 * Split a SIRI VM document into raw activity rows.
 * @param {string} text
 * @returns {{rows: Array<Record<string, string|null>>, truncated: boolean,
 *   responseTimestamp: string|null}}
 */
export function parseSiriVmXml(text) {
  if (typeof text !== 'string') throw new SiriVmFormatError('not text');
  if (text.length > SIRI_VM_MAX_TEXT_CHARS)
    throw new SiriVmFormatError(`document is ${text.length} characters`);
  if (/<!DOCTYPE|<!ENTITY/i.test(text))
    throw new SiriVmFormatError('document declares a DTD');
  if (!/<(?:[A-Za-z_][\w.-]*:)?VehicleMonitoringDelivery[\s>]/.test(text))
    throw new SiriVmFormatError('not a vehicle monitoring document');
  const open = /<(?:[A-Za-z_][\w.-]*:)?VehicleActivity(?:\s[^>]*)?>/g;
  const close = /<\/(?:[A-Za-z_][\w.-]*:)?VehicleActivity>/g;
  const rows = [];
  let truncated = false;
  let found;
  while ((found = open.exec(text))) {
    close.lastIndex = open.lastIndex;
    const end = close.exec(text);
    if (!end) break;
    if (rows.length >= SIRI_VM_MAX_ACTIVITIES) {
      truncated = true;
      break;
    }
    const block = text.slice(open.lastIndex, end.index);
    rows.push({
      recordedAt: readField(block, 'RecordedAtTime'),
      validUntil: readField(block, 'ValidUntilTime'),
      lineRef: readField(block, 'LineRef'),
      mode: readField(block, 'VehicleMode'),
      latitude: readField(block, 'Latitude'),
      longitude: readField(block, 'Longitude'),
      bearing: readField(block, 'Bearing'),
      delay: readField(block, 'Delay'),
      journeyRef:
        readField(block, 'VehicleJourneyRef') ??
        readField(block, 'DatedVehicleJourneyRef'),
      vehicleRef: readField(block, 'VehicleRef'),
      lineName: readField(block, 'PublishedLineName'),
    });
    open.lastIndex = end.index + end[0].length;
  }
  const head = text.slice(0, 4096);
  return {
    rows,
    truncated,
    responseTimestamp: readField(head, 'ResponseTimestamp'),
  };
}

/**
 * Turn a SIRI VM document into unclassified train records in the shape the
 * GTFS-RT path produces (src/data/gtfsRealtime.js), plus `delaySec`.
 *
 * `routeId` is the `LineRef` (Entur: the same `<codespace>:Line:<n>` ids as
 * the static GTFS), `tripId` the `VehicleJourneyRef` (Entur: a
 * `DatedServiceJourney`, not the GTFS trip id; the timetable matches the
 * train to a run by line and position instead). One record per vehicle:
 * a vehicle listed twice keeps its latest report.
 *
 * @param {string} text The XML document.
 * @param {number} fetchedAtS Fetch time (epoch seconds), used when an
 *   activity carries no RecordedAtTime and to drop expired activities.
 * @returns {{entityCount: number, truncated: boolean,
 *   feedTimestamp: number|null, vehicles: object[]}}
 */
export function decodeSiriVehicleMonitoring(text, fetchedAtS) {
  const { rows, truncated, responseTimestamp } = parseSiriVmXml(text);
  const byId = new Map();
  for (const row of rows) {
    if (row.mode && !/^rail$/i.test(row.mode)) continue;
    const lat = Number.parseFloat(row.latitude ?? '');
    const lon = Number.parseFloat(row.longitude ?? '');
    if (!isPlausibleVehiclePosition(lat, lon)) continue;
    const validUntil = epochSeconds(row.validUntil);
    if (validUntil !== null && validUntil < fetchedAtS) continue;
    const id = row.vehicleRef || row.journeyRef;
    if (!id || !/^[\w:.-]{1,128}$/.test(id)) continue;
    const recorded = epochSeconds(row.recordedAt);
    const bearing = Number.parseFloat(row.bearing ?? '');
    const record = {
      id,
      lat: Number(lat.toFixed(6)),
      lon: Number(lon.toFixed(6)),
      bearing:
        Number.isFinite(bearing) && bearing >= 0 && bearing <= 360
          ? bearing
          : null,
      speedMps: null,
      timestamp: recorded ?? fetchedAtS,
      timestampSource: recorded === null ? 'fetch' : 'vehicle',
      routeId: row.lineRef || null,
      tripId: row.journeyRef || null,
      directionId: null,
      label: row.lineName || null,
      stopId: null,
      status: null,
      occupancy: null,
      delaySec: parseIsoDurationSec(row.delay),
    };
    const known = byId.get(id);
    if (!known || record.timestamp >= known.timestamp) byId.set(id, record);
  }
  return {
    entityCount: rows.length,
    truncated,
    feedTimestamp: epochSeconds(responseTimestamp),
    vehicles: [...byId.values()],
  };
}
