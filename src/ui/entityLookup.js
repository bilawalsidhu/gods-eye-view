// Things found anywhere by a host's entity lookup (the `entityLookup` option
// of createApplicationControls, src/app/controls.js): the answers the search
// box lists as rows, and finding one picked there in its layer. Its layer is
// switched on as a click would; one the layer already holds is picked as a
// Context row picks it, and one it does not hold yet is centred on once and
// picked when the layer's next load has it. It is never followed.

import { isWorldTime } from '../time/worldClock.js';

/** The kinds a lookup may answer with, and the layer each is shown in. */
export const LOOKUP_LAYERS = Object.freeze({
  aircraft: 'flights',
  vessel: 'ais-live-vessels',
  camera: 'cctv',
  satellite: 'satellites',
});
/** The most matches the search box lists from one answer. */
export const MAX_LOOKUP_MATCHES = 8;
/** How long a picked match may take to arrive in its layer, in ms. */
export const LOOKUP_ARRIVAL_MS = 20_000;
/** How often the layer is asked again while a picked match is on its way, in ms. */
export const LOOKUP_RECHECK_MS = 500;

const text = (value) => String(value ?? '').trim() || null;

/**
 * A lookup's answer as the search box lists it: aircraft, ships, cameras and
 * satellites with an id and a valid position, once each by layer and id, at
 * most MAX_LOOKUP_MATCHES, in the order given. `layerId` is the answer's,
 * else its kind's layer. A ship's MMSI is its `mmsi`, else an id of nine
 * digits. One the host marks `placed: false` (its layer will not draw it at
 * the time asked: no position then) is kept with or without a position,
 * which is then where it was last seen; its `detail` says why. An answer's
 * `at` (epoch ms) is the world time its position is from, when the host
 * placed it at another time than the one asked.
 * @param {unknown} answer What `entityLookup` resolved with.
 * @returns {Array<{kind: string, id: string, name: ?string, detail: ?string, lat: ?number, lon: ?number, layerId: string, mmsi: ?string, placed: boolean, at: ?number}>}
 */
export function lookupMatches(answer) {
  if (!Array.isArray(answer)) return [];
  const seen = new Set();
  const matches = [];
  for (const item of answer) {
    const kind = item?.kind;
    if (!Object.hasOwn(LOOKUP_LAYERS, kind)) continue;
    const id = text(item.id);
    const layerId = text(item.layerId) || LOOKUP_LAYERS[kind];
    const placed = item.placed !== false;
    const lat = item.lat == null ? NaN : Number(item.lat);
    const lon = item.lon == null ? NaN : Number(item.lon);
    const located =
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      Math.abs(lat) <= 90 &&
      Math.abs(lon) <= 180;
    if (!id || seen.has(`${layerId}:${id}`) || (placed && !located)) continue;
    seen.add(`${layerId}:${id}`);
    matches.push({
      kind,
      id,
      name: text(item.name),
      detail: text(item.detail),
      lat: located ? lat : null,
      lon: located ? lon : null,
      layerId,
      mmsi:
        kind === 'vessel'
          ? text(item.mmsi) || (/^\d{9}$/.test(id) ? id : null)
          : null,
      placed,
      at: placed && isWorldTime(item.at) ? item.at : null,
    });
    if (matches.length === MAX_LOOKUP_MATCHES) break;
  }
  return matches;
}

const same = (a, b) =>
  a != null &&
  b != null &&
  String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/**
 * The id the layer holds a match under, or null: the record its layer finds
 * for the match's id whose own id is that id, else the record it finds for
 * the match's MMSI whose MMSI is that MMSI. Never a record found by name.
 */
export function loadedId(dataManager, match) {
  const module = dataManager?.layers?.get?.(match?.layerId)?.module;
  if (typeof module?.findByQuery !== 'function') return null;
  const query = (value) => {
    try {
      return module.findByQuery(value) || null;
    } catch {
      return null;
    }
  };
  const ownId = (record) => record.id ?? record.icao24 ?? record.noradId;
  const byId = query(match.id);
  if (byId) {
    const key = ownId(byId);
    // A layer that finds its records by id alone says no more than that.
    if (key == null || same(key, match.id)) return match.id;
  }
  if (!match.mmsi) return null;
  const byMmsi = query(match.mmsi);
  if (!byMmsi || !same(byMmsi.mmsi, match.mmsi)) return null;
  return String(ownId(byMmsi) ?? match.mmsi);
}

/**
 * The id the layer holds a match under (see loadedId) once it has it: now,
 * or after one of its loads (or a recheck), within `timeoutMs`. Null when it never arrives,
 * the layer goes off, or `signal` aborts.
 */
export function waitForLoaded(
  dataManager,
  match,
  { signal = null, timeoutMs = LOOKUP_ARRIVAL_MS } = {},
) {
  const now = loadedId(dataManager, match);
  if (now || signal?.aborted) return Promise.resolve(now);
  return new Promise((resolve) => {
    let off = null;
    const timer = setTimeout(() => done(null), timeoutMs);
    // A layer may load outside the manager's refresh and say nothing, so the
    // layer is also asked again every LOOKUP_RECHECK_MS.
    const recheck = setInterval(check, LOOKUP_RECHECK_MS);
    const onAbort = () => done(null);
    function done(value) {
      clearTimeout(timer);
      clearInterval(recheck);
      signal?.removeEventListener?.('abort', onAbort);
      off?.();
      off = null;
      resolve(value);
    }
    function check() {
      if (!dataManager.isEnabled?.(match.layerId)) return done(null);
      const found = loadedId(dataManager, match);
      if (found) done(found);
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (typeof dataManager?.subscribeActivity === 'function')
      off = dataManager.subscribeActivity((change) => {
        if (change?.layerId && change.layerId !== match.layerId) return;
        check();
      });
  });
}

/**
 * Find a match in its layer. One placed at another time (`at`) moves the
 * world clock there first (`seek`), so its layer draws it where the lookup
 * placed it. One the host marks `placed: false` is not
 * looked for: the camera is centred where it was last seen, if the host
 * gave a position, and the answer is `{ok: false, reason: 'unplaced'}`.
 * Otherwise its layer is switched on if it is off
 * (`setLayer`, as a click would). One the layer holds is answered at once
 * with `picked: false`, for the caller to pick as a Context row picks it;
 * one it does not hold yet is centred on once (`centre`, at the position the
 * lookup gave), then picked with the layer's `pickById` (`center: false`)
 * when its next load has it, and answered with `picked: true`.
 * @param {object} options
 * @param {{kind: string, id: string, name: ?string, detail?: ?string, lat: ?number, lon: ?number, layerId: string, mmsi?: ?string, placed?: boolean}} options.match
 * @param {object} options.dataManager The layers.
 * @param {(id: string, enabled: boolean) => Promise<boolean>|boolean} options.setLayer
 * @param {(lat: number, lon: number) => unknown} options.centre
 * @param {(ms: number) => unknown} [options.seek] Moves the world clock.
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ok: boolean, identity?: object, picked?: boolean, reason?: string}>}
 */
export async function findMatch({
  match,
  dataManager,
  setLayer,
  centre,
  seek = null,
  signal = null,
  timeoutMs = LOOKUP_ARRIVAL_MS,
}) {
  const { layerId } = match;
  if (!dataManager?.layers?.has?.(layerId))
    return { ok: false, reason: 'no-layer' };
  if (signal?.aborted) return { ok: false, reason: 'cancelled' };
  // One its layer will not draw at this time is not waited for: the camera
  // goes where it was last seen, if anywhere, and the search box says why.
  if (match.placed === false) {
    if (Number.isFinite(match.lat) && Number.isFinite(match.lon))
      centre(match.lat, match.lon);
    return { ok: false, reason: 'unplaced' };
  }
  // Its position is from another time: the world clock goes there, so the
  // layer's next load has it where the lookup placed it.
  const moved = isWorldTime(match.at) && typeof seek === 'function';
  if (moved) seek(match.at);
  if (!dataManager.isEnabled?.(layerId)) {
    const switched = await setLayer(layerId, true);
    if (signal?.aborted) return { ok: false, reason: 'cancelled' };
    if (switched === false || !dataManager.isEnabled?.(layerId))
      return { ok: false, reason: 'layer-off' };
  }
  const identity = (id) => ({
    layerId,
    id,
    label: match.name || id,
    lat: match.lat,
    lon: match.lon,
  });
  // A record the layer holds is where it is now; once the clock has moved,
  // the camera goes where the lookup placed it and the record is picked by id.
  const now = moved ? null : loadedId(dataManager, match);
  if (now) return { ok: true, identity: identity(now), picked: false };
  // Once, at the position the lookup gave: the layer loads around the view.
  centre(match.lat, match.lon);
  const id = await waitForLoaded(dataManager, match, { signal, timeoutMs });
  if (signal?.aborted) return { ok: false, reason: 'cancelled' };
  if (!id) return { ok: false, reason: 'not-loaded' };
  let picked = false;
  try {
    picked = Boolean(
      dataManager.layers
        .get(layerId)
        ?.module?.pickById?.(id, { origin: 'user', center: false }),
    );
  } catch {
    picked = false;
  }
  return picked
    ? { ok: true, identity: identity(id), picked: true }
    : { ok: false, reason: 'not-picked' };
}
