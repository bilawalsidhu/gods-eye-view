// Things found anywhere by a host's entity lookup (the `entityLookup` option
// of createApplicationControls, src/app/controls.js): the answers the search
// box lists as rows, and finding one picked there in its layer. Its layer is
// switched on as a click would; one the layer already holds is picked as a
// Context row picks it, and one it does not hold yet is centred on once and
// picked when the layer's next load has it. It is never followed.

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

const text = (value) => String(value ?? '').trim() || null;

/**
 * A lookup's answer as the search box lists it: aircraft, ships, cameras and
 * satellites with an id and a valid position, once each by layer and id, at
 * most MAX_LOOKUP_MATCHES, in the order given. `layerId` is the answer's,
 * else its kind's layer. A ship's MMSI is its `mmsi`, else an id of nine
 * digits.
 * @param {unknown} answer What `entityLookup` resolved with.
 * @returns {Array<{kind: string, id: string, name: ?string, detail: ?string, lat: number, lon: number, layerId: string, mmsi: ?string}>}
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
    const lat = Number(item.lat);
    const lon = Number(item.lon);
    if (
      !id ||
      seen.has(`${layerId}:${id}`) ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180
    )
      continue;
    seen.add(`${layerId}:${id}`);
    matches.push({
      kind,
      id,
      name: text(item.name),
      detail: text(item.detail),
      lat,
      lon,
      layerId,
      mmsi:
        kind === 'vessel'
          ? text(item.mmsi) || (/^\d{9}$/.test(id) ? id : null)
          : null,
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
 * or after one of its loads, within `timeoutMs`. Null when it never arrives,
 * the layer goes off, or `signal` aborts.
 */
export function waitForLoaded(
  dataManager,
  match,
  { signal = null, timeoutMs = LOOKUP_ARRIVAL_MS } = {},
) {
  const now = loadedId(dataManager, match);
  if (now || signal?.aborted) return Promise.resolve(now);
  if (typeof dataManager?.subscribeActivity !== 'function')
    return Promise.resolve(null);
  return new Promise((resolve) => {
    let off = null;
    const timer = setTimeout(() => done(null), timeoutMs);
    const onAbort = () => done(null);
    function done(value) {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      off?.();
      off = null;
      resolve(value);
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    off = dataManager.subscribeActivity((change) => {
      if (!dataManager.isEnabled?.(match.layerId)) return done(null);
      if (change?.layerId && change.layerId !== match.layerId) return;
      const found = loadedId(dataManager, match);
      if (found) done(found);
    });
  });
}

/**
 * Find a match in its layer. Its layer is switched on if it is off
 * (`setLayer`, as a click would). One the layer holds is answered at once
 * with `picked: false`, for the caller to pick as a Context row picks it;
 * one it does not hold yet is centred on once (`centre`, at the position the
 * lookup gave), then picked with the layer's `pickById` (`center: false`)
 * when its next load has it, and answered with `picked: true`.
 * @param {object} options
 * @param {{kind: string, id: string, name: ?string, lat: number, lon: number, layerId: string, mmsi?: ?string}} options.match
 * @param {object} options.dataManager The layers.
 * @param {(id: string, enabled: boolean) => Promise<boolean>|boolean} options.setLayer
 * @param {(lat: number, lon: number) => unknown} options.centre
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ok: boolean, identity?: object, picked?: boolean, reason?: string}>}
 */
export async function findMatch({
  match,
  dataManager,
  setLayer,
  centre,
  signal = null,
  timeoutMs = LOOKUP_ARRIVAL_MS,
}) {
  const { layerId } = match;
  if (!dataManager?.layers?.has?.(layerId))
    return { ok: false, reason: 'no-layer' };
  if (signal?.aborted) return { ok: false, reason: 'cancelled' };
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
  const now = loadedId(dataManager, match);
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
