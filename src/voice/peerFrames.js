/**
 * Browser side of peer federation (server/providers/ollama/peers.js): frames
 * that arrive from another God's Eye View globe through the local voice
 * socket, plus the share-alerts preference. Spoken peer alerts need nothing
 * here: they reach the browser as ordinary `notice` frames prefixed
 * "From <peer>:" and tagged `origin`. A shared saved place arrives as
 * {type:'peer_place', place:{name,lat,lon,alt?,heading?,pitch?,roll?}, origin}
 * and is filed into local memory as "<name> (from <peer>)".
 *
 * The adapter (localVoiceSession.js) calls applyPeerFrame(frame, { memory,
 * toast }) for frames it does not otherwise handle.
 */
export const SHARE_ALERTS_STORAGE_KEY = 'gev:voice-peers:share-alerts:v1';
export const PEER_PLACE_FRAME = 'peer_place';
/** Camera height used when a peer shared a place without an altitude. */
export const DEFAULT_PEER_PLACE_ALT_M = 2000;

/**
 * Store a place shared by a peer globe and tell the user. Returns
 * { type:'peer_place', peer, name, place } when a place was saved, null when
 * the frame is not a usable peer_place.
 */
export function applyPeerFrame(frame, { memory, toast = () => {} } = {}) {
  if (!frame || frame.type !== PEER_PLACE_FRAME) return null;
  const place = frame.place;
  const lat = Number(place?.lat);
  const lon = Number(place?.lon);
  const label = String(place?.name || '').trim();
  if (!label || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const peer = String(frame.origin || frame.peer || 'peer').trim() || 'peer';
  const name = `${label} (from ${peer})`;
  const saved =
    memory?.rememberPlace?.(name, {
      lat,
      lon,
      alt: finiteOr(place.alt, DEFAULT_PEER_PLACE_ALT_M),
      heading: finiteOr(place.heading, 0),
      pitch: finiteOr(place.pitch, -45),
      roll: finiteOr(place.roll, 0),
    }) ?? null;
  if (!saved) return null;
  try {
    toast(`${peer} shared "${label}" — saved as "${name}"`);
  } catch {
    /* toast is best effort */
  }
  return { type: PEER_PLACE_FRAME, peer, name, place: saved };
}

/**
 * Whether this globe's spoken alerts should be shared with peers. Stored per
 * browser under SHARE_ALERTS_STORAGE_KEY ("1" / "0"); defaults to true.
 * Written by the share_alerts voice tool; the adapter reads it when it
 * decides whether a watch alert also goes out through the hub.
 */
export function readShareAlerts(storage = safeStorage()) {
  try {
    const raw = storage?.getItem(SHARE_ALERTS_STORAGE_KEY);
    return raw === null || raw === undefined ? true : raw !== '0';
  } catch {
    return true;
  }
}

export function writeShareAlerts(enabled, storage = safeStorage()) {
  try {
    storage?.setItem(SHARE_ALERTS_STORAGE_KEY, enabled ? '1' : '0');
    return true;
  } catch {
    return false;
  }
}

function finiteOr(value, fallback) {
  const number = Number(value);
  return value !== undefined && value !== null && Number.isFinite(number)
    ? number
    : fallback;
}

function safeStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}
