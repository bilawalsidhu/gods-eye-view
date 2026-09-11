import { XMLParser } from 'fast-xml-parser';
import { cotAffiliation } from './cotEvent.js';

/**
 * @file Cursor-on-Target (CoT) wire decoding — server-only.
 *
 * Pulls in fast-xml-parser, which the browser layer (takEvents.js) never
 * needs — it only ever sees the already-decoded JSON this produces.
 * @module data/cotDecode
 */

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
/** Detail sub-tree passthrough is capped — CoT extensions can carry
 * arbitrarily large embedded content (imagery, chat, file shares) that a
 * Phase-1 point-display layer has no use for. */
const MAX_DETAIL_JSON_BYTES = 8192;

/**
 * Split a growing TCP byte-stream buffer into complete top-level
 * `<event>...</event>` (or self-closing `<event .../>`) documents.
 *
 * A CoT `<event>` never nests another `<event>`, so this only needs to find
 * matching top-level boundaries, not a full XML parse. ponytail: a literal
 * (unescaped) `>` inside an attribute value would confuse the opening-tag
 * scan — legal XML, but not something real TAK traffic does in practice;
 * revisit with a proper streaming parser if that ever surfaces.
 *
 * Any bytes before the first `<event` (e.g. an `<?xml?>` prologue, or
 * whitespace between messages) are dropped rather than kept.
 *
 * @param {string} buffer
 * @returns {{events: string[], remainder: string}} Complete event documents
 *   found, and whatever incomplete tail should be prepended to the next chunk.
 */
export function extractCotEvents(buffer) {
  const events = [];
  let rest = buffer;
  for (;;) {
    const startIdx = rest.indexOf('<event');
    if (startIdx === -1) return { events, remainder: '' };
    if (startIdx > 0) rest = rest.slice(startIdx);

    const tagEnd = rest.indexOf('>');
    if (tagEnd === -1) return { events, remainder: rest }; // opening tag not fully arrived

    if (rest[tagEnd - 1] === '/') {
      events.push(rest.slice(0, tagEnd + 1));
      rest = rest.slice(tagEnd + 1);
      continue;
    }
    const CLOSE_TAG = '</event>';
    const closeIdx = rest.indexOf(CLOSE_TAG, tagEnd);
    if (closeIdx === -1) return { events, remainder: rest }; // body not fully arrived
    events.push(rest.slice(0, closeIdx + CLOSE_TAG.length));
    rest = rest.slice(closeIdx + CLOSE_TAG.length);
  }
}

/**
 * Decode one complete CoT `<event>` XML document into a plain record.
 * @param {string} xmlString
 * @returns {object|null} Null for anything unusable: not an event, missing
 *   uid/type, or no valid point (routes/shapes/chat — non-point CoT objects
 *   — are out of scope for this Phase-1 point layer; see issue #7).
 */
export function decodeCotEvent(xmlString) {
  const parsed = parser.parse(xmlString);
  const event = parsed?.event;
  if (!event) return null;
  const uid = event['@_uid'];
  const type = event['@_type'];
  if (!uid || !type) return null;

  const point = event.point || {};
  const lat = Number(point['@_lat']);
  const lon = Number(point['@_lon']);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return null;

  const detail = event.detail || {};
  const contact = detail.contact || {};
  const group = detail.__group || {};
  const takv = detail.takv || {};
  const track = detail.track || {};
  const status = detail.status || {};
  // `Number('')` is 0, not NaN — an empty (present-but-blank) attribute must
  // read as missing, not as a real zero value (0 altitude, 0° heading, ...).
  const num = (v) => {
    if (v === '' || v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  let detailRaw = null;
  try {
    const json = JSON.stringify(detail);
    // .length is UTF-16 code units, not bytes — a non-ASCII callsign etc.
    // could run ~2x that in real UTF-8 bytes, so measure the actual bytes.
    if (json && Buffer.byteLength(json, 'utf8') <= MAX_DETAIL_JSON_BYTES) detailRaw = detail;
  } catch {
    // Non-serializable detail (shouldn't happen from an XML parse) — drop
    // the passthrough, keep the well-known fields below.
  }

  return {
    uid: String(uid),
    type: String(type),
    affiliation: cotAffiliation(type),
    how: event['@_how'] || null,
    time: event['@_time'] || null,
    start: event['@_start'] || null,
    stale: event['@_stale'] || null,
    latitude: lat,
    longitude: lon,
    hae: num(point['@_hae']),
    ce: num(point['@_ce']),
    le: num(point['@_le']),
    callsign: contact['@_callsign'] || null,
    groupName: group['@_name'] || null,
    groupRole: group['@_role'] || null,
    device: takv['@_device'] || null,
    platform: takv['@_platform'] || null,
    version: takv['@_version'] || null,
    course: num(track['@_course']),
    speed: num(track['@_speed']),
    battery: status['@_battery'] || null,
    detail: detailRaw,
  };
}
