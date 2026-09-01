/**
 * @module ognFallback
 * @description Normalizes the Open Glider Network's `lxml.php` bounding-box
 * response (the same feed powering live.glidernet.org) into a flat,
 * JSON-safe array this app renders.
 *
 * OGN tracks FLARM/OGN-tracker equipped gliders, paragliders, tow planes and
 * light GA — traffic that mostly does NOT carry an ADS-B transponder, so it
 * is invisible to both OpenSky and adsb.lol. `lxml.php` returns one `<m
 * a="..."/>` element per aircraft, its `a` attribute a comma-separated tuple:
 *
 *   lat,lon,callsign,registration,altitudeM,time,ageSec,trackDeg,speedKmh,
 *   climbMps,typeCode,receiver,flarmId,hash
 *
 * Field order verified 2026-09-01 against glidernet/ogn-live's own parser
 * (ogn.js `gesmark()`) and cross-checked against a live sample near Vienna —
 * not officially versioned or documented, so a field could shift upstream.
 */

/** OGN aircraft-type codes (glidernet/ogn-live `ftype`), 0-14. */
export const OGN_AIRCRAFT_TYPES = Object.freeze({
  0: 'unknown',
  1: 'glider',
  2: 'tow-plane',
  3: 'helicopter',
  4: 'parachute',
  5: 'drop-plane',
  6: 'hang-glider',
  7: 'paraglider',
  8: 'plane',
  9: 'jet',
  10: 'ufo',
  11: 'balloon',
  12: 'airship',
  13: 'drone',
  14: 'unknown',
  15: 'unknown',
});

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function text(value) {
  const trimmed = String(value ?? '').trim();
  return trimmed || null;
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Decode the small entity set XML attribute values can carry. */
function decodeXmlEntities(value) {
  return String(value ?? '').replace(/&(amp|lt|gt|quot|apos|#\d+);/g, (match, entity) => (
    entity[0] === '#' ? String.fromCodePoint(Number(entity.slice(1))) : (XML_ENTITIES[entity] ?? match)
  ));
}

/**
 * One `<m a="...">` element's field tuple (already comma-split) into a flat
 * record, or null when it carries no usable position.
 * @param {string[]} fields The 14 comma-separated fields of the `a` attribute.
 * @returns {object|null}
 */
export function normalizeOgnMarker(fields) {
  if (!Array.isArray(fields) || fields.length < 11) return null;
  const lat = finiteNumber(fields[0]);
  const lon = finiteNumber(fields[1]);
  if (lat === null || lon === null) return null;
  // "0" is OGN's sentinel for "no FLARM ID broadcast" (common: a contact in
  // FLARM privacy mode, or one seen only via a non-FLARM tracker) — NOT a
  // real shared id. Verified 2026-09-01 against a live 543-aircraft Austria
  // snapshot: 371 of them carried this exact sentinel, which — treated as
  // truthy — collapsed to one shared entity id and would throw on the second
  // Cesium `entities.add()` of a poll. `registration` carries a real distinct
  // value (an anonymous FLARM device hex, or a real tail number) for every
  // one of those 371 in the same snapshot; verified duplicate-free.
  const rawFlarmId = text(fields[12]);
  const flarmId = rawFlarmId === '0' ? null : rawFlarmId;
  const registration = text(fields[3]);
  const id = flarmId || registration || `${lat.toFixed(4)},${lon.toFixed(4)}`;
  const typeCode = finiteNumber(fields[10]);

  return {
    id,
    lat,
    lon,
    callsign: text(fields[2]),
    registration,
    altitudeM: finiteNumber(fields[4]),
    ageSeconds: finiteNumber(fields[6]),
    headingDeg: finiteNumber(fields[7]),
    speedMps: finiteNumber(fields[8]) === null ? null : finiteNumber(fields[8]) / 3.6,
    climbMps: finiteNumber(fields[9]),
    typeCode,
    typeLabel: OGN_AIRCRAFT_TYPES[typeCode] || 'unknown',
    receiver: text(fields[11]),
    flarmId,
  };
}

/**
 * Normalize a full `lxml.php` XML response to a flat array.
 * @param {string} xmlText Raw XML response body.
 * @returns {{time: number, aircraft: Array<object>}}
 */
export function normalizeOgnXmlResponse(xmlText) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const aircraft = [];
  if (typeof xmlText !== 'string' || !xmlText) return { time: nowSeconds, aircraft };
  // Every marker is a single self-closing element on one line — a small
  // regex extraction avoids pulling in an XML parser dependency for a
  // response this structurally simple.
  const markerPattern = /<m\s+a="([^"]*)"\s*\/?>/g;
  let match;
  while ((match = markerPattern.exec(xmlText)) !== null) {
    const fields = decodeXmlEntities(match[1]).split(',');
    const marker = normalizeOgnMarker(fields);
    if (marker) aircraft.push(marker);
  }
  return { time: nowSeconds, aircraft };
}
