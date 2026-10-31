// Joins MnDOT's three public IRIS sign feeds into the lit-sign list the
// message-signs proxy serves. dms_pub gives where each sign is, dms_message
// which message it shows and sign_message the message itself. Pure and
// server-importable; the proxy and its tests share it.

import { MAX_MULTI_CHARS, parseMultiText, stripUnsafeText } from './multi.js';

const SIGN_NAME_RE = /^[A-Za-z0-9_.-]{1,40}$/;
/** IRIS message names; also the only names the GIF route will relay. */
export const MESSAGE_NAME_RE = /^(msg|sys)_[0-9A-F]{8}$/;
const LOCATION_MAX_CHARS = 120;
const MALFORMED = 'Malformed message signs response';

/** Minnesota with slack for the border corridors (as the CCTV pack). */
function isMinnesotaCoordinate(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= 43.4 &&
    lat <= 49.5 &&
    lon >= -97.3 &&
    lon <= -89.4
  );
}

function byName(rows) {
  const map = new Map();
  for (const row of rows) {
    const name = row?.name;
    if (typeof name === 'string' && !map.has(name)) map.set(name, row);
  }
  return map;
}

function cleanLocation(text, fallback) {
  const location = stripUnsafeText(text)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LOCATION_MAX_CHARS);
  return location || fallback;
}

/**
 * Join the three feeds. A feed that is not an array fails the whole join;
 * individual bad rows are skipped.
 *
 * @param {{ signs: unknown, states: unknown, messages: unknown }} feeds
 *   dms_pub, dms_message and sign_message as parsed JSON.
 * @returns {{ signs: object[], joinMisses: number }} Lit signs, and how many
 *   otherwise-valid signs named a message sign_message did not have.
 */
export function joinMessageSigns({ signs, states, messages }) {
  if (![signs, states, messages].every(Array.isArray)) {
    throw new Error(MALFORMED);
  }
  const stateBySign = byName(states);
  const messageByName = byName(messages);
  const seen = new Set();
  const lit = [];
  let joinMisses = 0;

  for (const sign of signs) {
    const id = sign?.name;
    if (typeof id !== 'string' || !SIGN_NAME_RE.test(id) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const { lat, lon } = sign;
    if (!isMinnesotaCoordinate(lat, lon)) continue;
    const state = stateBySign.get(id);
    // Anything but a literal false keeps the sign out, so a renamed or
    // malformed flag fails closed.
    if (!state || state.failed !== false) continue;
    const message = state.msg_current;
    if (typeof message !== 'string' || !MESSAGE_NAME_RE.test(message)) {
      continue;
    }
    const record = messageByName.get(message);
    if (!record) {
      joinMisses += 1;
      continue;
    }
    const multi =
      typeof record.multi === 'string'
        ? record.multi.slice(0, MAX_MULTI_CHARS)
        : '';
    const { visibleChars, hasGraphic } = parseMultiText(multi);
    if (!visibleChars && !hasGraphic) continue;
    lit.push({
      id,
      provider: 'mndot',
      lat,
      lon,
      location: cleanLocation(sign.location, id),
      message,
      multi,
    });
  }
  return { signs: lit, joinMisses };
}
