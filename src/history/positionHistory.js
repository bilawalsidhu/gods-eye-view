/**
 * In-memory position history for the live contact layers.
 *
 * One snapshot per layer poll is recorded from `module.getAnalystRecords()`
 * into compact per-entity ring buffers (typed arrays, 36 bytes per fix). The
 * store is bounded by a retention window (15 minutes by default) and a total
 * byte budget; when the budget is exceeded the entities that reported least
 * recently are dropped first. Positions only — nothing is persisted.
 */
export const DEFAULT_HISTORY_LAYERS = Object.freeze([
  'flights',
  'military',
  'ais-live-vessels',
]);
export const DEFAULT_RETENTION_MS = 15 * 60_000;
export const DEFAULT_HISTORY_BYTES = 32 * 1024 * 1024;
/** Fixes further than this from the display time do not place an entity. */
export const MATCH_TOLERANCE_MS = 90_000;
/** Bytes per stored fix: t, lat, lon (f64) + height, heading, speed (f32). */
export const FIX_BYTES = 36;
const MIN_CAPACITY = 8;
const MAX_CAPACITY = 256;
/** A feed that re-publishes faster than this is thinned per entity. */
const MIN_FIX_SPACING_MS = 4_000;
/** An unmoved entity still gets a fresh fix this often so it stays placeable. */
const STATIONARY_REFRESH_MS = 60_000;
const KNOTS_TO_MPS = 0.514444;

const finite = (value) => (Number.isFinite(value) ? value : NaN);
const text = (value) => {
  const trimmed = String(value ?? '').trim();
  return trimmed || null;
};

/** Reduce one analyst record to the fix fields the history stores. */
export function fixFromRecord(layerId, record) {
  if (!record) return null;
  const lat = Number(record.lat);
  const lon = Number(record.lon);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  )
    return null;
  if (layerId === 'ais-live-vessels') {
    const id = text(record.mmsi) || text(record.id);
    if (!id) return null;
    const speedKts = finite(Number(record.speedKts));
    return {
      id,
      label: text(record.name) || id,
      lat,
      lon,
      heightM: 0,
      headingDeg: finite(Number(record.courseDeg)),
      speed: Number.isFinite(speedKts) ? speedKts * KNOTS_TO_MPS : NaN,
    };
  }
  const id = text(record.icao24) || text(record.id);
  if (!id) return null;
  return {
    id,
    label: text(record.callsign) || text(record.id) || id,
    lat,
    lon,
    heightM: record.onGround === true ? 0 : finite(Number(record.altitudeM)),
    headingDeg: finite(Number(record.heading)),
    speed: finite(Number(record.speedMps)),
    // Source-reported fix time when the layer knows it (null otherwise).
    t: finite(Number(record.positionTimeMs)),
  };
}

/**
 * Time to store for a fix: the source's own timestamp when it is plausible
 * (not in the future, not older than 15 min), else the arrival time. Stale
 * repeats of an old fix therefore never look like fresh motion.
 */
export function fixTime(fix, arrivalT) {
  const t = fix?.t;
  if (!Number.isFinite(t)) return arrivalT;
  if (t > arrivalT + 60_000 || t < arrivalT - 15 * 60_000) return arrivalT;
  return t;
}

function createTrack(layerId, id, label) {
  return {
    layerId,
    id,
    label,
    capacity: 0,
    count: 0,
    head: 0,
    t: null,
    lat: null,
    lon: null,
    h: null,
    hdg: null,
    spd: null,
  };
}
const slot = (track, index) => (track.head + index) % track.capacity;
const timeAt = (track, index) => track.t[slot(track, index)];

function grow(track, capacity) {
  const next = {
    t: new Float64Array(capacity),
    lat: new Float64Array(capacity),
    lon: new Float64Array(capacity),
    h: new Float32Array(capacity),
    hdg: new Float32Array(capacity),
    spd: new Float32Array(capacity),
  };
  for (let i = 0; i < track.count; i++) {
    const from = slot(track, i);
    next.t[i] = track.t[from];
    next.lat[i] = track.lat[from];
    next.lon[i] = track.lon[from];
    next.h[i] = track.h[from];
    next.hdg[i] = track.hdg[from];
    next.spd[i] = track.spd[from];
  }
  Object.assign(track, next, { head: 0 });
  const delta = (capacity - track.capacity) * FIX_BYTES;
  track.capacity = capacity;
  return delta;
}

/** Append one fix; returns the change in allocated bytes. */
function append(track, t, fix) {
  let delta = 0;
  if (track.count === track.capacity) {
    if (track.capacity < MAX_CAPACITY)
      delta = grow(
        track,
        Math.min(MAX_CAPACITY, Math.max(MIN_CAPACITY, track.capacity * 2)),
      );
    else {
      track.head = (track.head + 1) % track.capacity;
      track.count--;
    }
  }
  const index = slot(track, track.count);
  track.t[index] = t;
  track.lat[index] = fix.lat;
  track.lon[index] = fix.lon;
  track.h[index] = fix.heightM;
  track.hdg[index] = fix.headingDeg;
  track.spd[index] = fix.speed;
  track.count++;
  return delta;
}

/** Drop fixes older than the cutoff; returns the remaining count. */
function trim(track, cutoff) {
  while (track.count > 0 && timeAt(track, 0) < cutoff) {
    track.head = (track.head + 1) % track.capacity;
    track.count--;
  }
  return track.count;
}

/** Index of the last fix at or before the time, or -1 when none. */
function bracket(track, t) {
  let lo = 0;
  let hi = track.count - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (timeAt(track, mid) <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

function lerpLon(a, b, f) {
  let lon = a + (((b - a + 540) % 360) - 180) * f;
  if (lon > 180) lon -= 360;
  if (lon < -180) lon += 360;
  return lon;
}
function lerpHeading(a, b, f) {
  if (!Number.isFinite(a)) return b;
  if (!Number.isFinite(b)) return a;
  const delta = ((b - a + 540) % 360) - 180;
  return (((a + delta * f) % 360) + 360) % 360;
}
function lerpFinite(a, b, f) {
  if (!Number.isFinite(a)) return b;
  if (!Number.isFinite(b)) return a;
  return a + (b - a) * f;
}

/**
 * Create a bounded position history fed by data-manager poll events.
 * @param {object} options
 * @param {object} [options.dataManager] Lifecycle manager exposing
 *   `subscribeActivity`, `isEnabled` and `layers`.
 * @param {string[]} [options.layers] Layer ids to record.
 * @param {number} [options.retentionMs] Oldest fix kept, relative to now.
 * @param {number} [options.maxBytes] Total typed-array budget.
 * @param {number} [options.maxRecords] Records requested per poll.
 * @param {() => number} [options.now] Wall clock in ms.
 */

/** Great-circle destination from a point along a bearing (degrees, meters). */
export function destinationPoint(lat, lon, bearingDeg, distanceM) {
  const R = 6371000;
  const d = distanceM / R;
  const brng = (bearingDeg * Math.PI) / 180;
  const phi1 = (lat * Math.PI) / 180;
  const lam1 = (lon * Math.PI) / 180;
  const sinPhi2 =
    Math.sin(phi1) * Math.cos(d) +
    Math.cos(phi1) * Math.sin(d) * Math.cos(brng);
  const phi2 = Math.asin(Math.min(1, Math.max(-1, sinPhi2)));
  const y = Math.sin(brng) * Math.sin(d) * Math.cos(phi1);
  const x = Math.cos(d) - Math.sin(phi1) * sinPhi2;
  const lam2 = lam1 + Math.atan2(y, x);
  let outLon = (lam2 * 180) / Math.PI;
  outLon = ((outLon + 540) % 360) - 180;
  return { lat: (phi2 * 180) / Math.PI, lon: outLon };
}

export function createPositionHistory({
  dataManager = null,
  layers = DEFAULT_HISTORY_LAYERS,
  retentionMs = DEFAULT_RETENTION_MS,
  maxBytes = DEFAULT_HISTORY_BYTES,
  maxRecords = 4000,
  now = Date.now,
} = {}) {
  const watched = new Set(layers);
  /** @type {Map<string, Map<string, object>>} layerId → id → track */
  const byLayer = new Map();
  let allocatedBytes = 0;
  let newestT = NaN;
  let revision = 0;
  let manager = null;
  let unsubscribe = null;
  let destroyed = false;

  const layerTracks = (layerId) => {
    let tracks = byLayer.get(layerId);
    if (!tracks) {
      tracks = new Map();
      byLayer.set(layerId, tracks);
    }
    return tracks;
  };
  function dropTrack(tracks, track) {
    allocatedBytes -= track.capacity * FIX_BYTES;
    tracks.delete(track.id);
  }
  function trimAll(t) {
    const cutoff = t - retentionMs;
    for (const tracks of byLayer.values())
      for (const track of [...tracks.values()])
        if (trim(track, cutoff) === 0) dropTrack(tracks, track);
  }
  function enforceBudget() {
    if (allocatedBytes <= maxBytes) return;
    const all = [];
    for (const tracks of byLayer.values())
      for (const track of tracks.values())
        all.push({
          tracks,
          track,
          lastT: track.count ? timeAt(track, track.count - 1) : -Infinity,
        });
    all.sort((a, b) => a.lastT - b.lastT);
    for (const entry of all) {
      if (allocatedBytes <= maxBytes) break;
      dropTrack(entry.tracks, entry.track);
    }
  }

  /** Record one snapshot of analyst records for a layer at time t. */
  function recordSnapshot(layerId, records, t = now()) {
    if (destroyed || !watched.has(layerId) || !Array.isArray(records)) return 0;
    const tracks = layerTracks(layerId);
    let accepted = 0;
    for (const record of records) {
      const fix = fixFromRecord(layerId, record);
      if (!fix) continue;
      let track = tracks.get(fix.id);
      if (!track) {
        track = createTrack(layerId, fix.id, fix.label);
        tracks.set(fix.id, track);
      } else if (fix.label && fix.label !== fix.id) track.label = fix.label;
      const ft = fixTime(fix, t);
      if (track.count) {
        const last = slot(track, track.count - 1);
        const since = ft - track.t[last];
        if (since < MIN_FIX_SPACING_MS) continue;
        if (
          since < STATIONARY_REFRESH_MS &&
          track.lat[last] === fix.lat &&
          track.lon[last] === fix.lon
        )
          continue;
      }
      allocatedBytes += append(track, ft, fix);
      accepted++;
    }
    if (!Number.isFinite(newestT) || t > newestT) newestT = t;
    revision++;
    trimAll(t);
    enforceBudget();
    return accepted;
  }

  function snapshotLayer(layerId) {
    if (!manager || !watched.has(layerId)) return 0;
    if (typeof manager.isEnabled === 'function' && !manager.isEnabled(layerId))
      return 0;
    const module = manager.layers?.get?.(layerId)?.module;
    if (typeof module?.getAnalystRecords !== 'function') return 0;
    let records;
    try {
      records = module.getAnalystRecords(maxRecords);
    } catch (error) {
      console.warn('[History] snapshot failed:', layerId, error);
      return 0;
    }
    return recordSnapshot(layerId, records);
  }

  function attach(nextManager) {
    if (destroyed) return;
    detach();
    manager = nextManager || null;
    if (typeof manager?.subscribeActivity !== 'function') return;
    unsubscribe = manager.subscribeActivity((change) => {
      if (change?.type === 'data-updated') snapshotLayer(change.layerId);
    });
  }
  function detach() {
    unsubscribe?.();
    unsubscribe = null;
    manager = null;
  }

  function range() {
    let oldestT = NaN;
    let count = 0;
    for (const tracks of byLayer.values())
      for (const track of tracks.values()) {
        if (!track.count) continue;
        count++;
        const first = timeAt(track, 0);
        if (!(first >= oldestT)) oldestT = first;
      }
    return { oldestT, newestT: count ? newestT : NaN, count };
  }

  function entitiesAt(displayTimeMs, out = []) {
    out.length = 0;
    if (!Number.isFinite(displayTimeMs)) return out;
    const t = displayTimeMs;
    for (const tracks of byLayer.values())
      for (const track of tracks.values()) {
        const n = track.count;
        if (!n) continue;
        const first = timeAt(track, 0);
        const last = timeAt(track, n - 1);
        if (t < first - MATCH_TOLERANCE_MS || t > last + MATCH_TOLERANCE_MS)
          continue;
        let i = bracket(track, t);
        let lat, lon, heightM, headingDeg, speed, ageMs;
        if (i < 0) {
          const a = slot(track, 0);
          lat = track.lat[a];
          lon = track.lon[a];
          heightM = track.h[a];
          headingDeg = track.hdg[a];
          speed = track.spd[a];
          ageMs = 0;
        } else if (i >= n - 1) {
          const a = slot(track, n - 1);
          lat = track.lat[a];
          lon = track.lon[a];
          heightM = track.h[a];
          headingDeg = track.hdg[a];
          speed = track.spd[a];
          ageMs = t - track.t[a];
        } else {
          const a = slot(track, i);
          const b = slot(track, i + 1);
          const span = track.t[b] - track.t[a];
          const f = span > 0 ? (t - track.t[a]) / span : 1;
          lat = track.lat[a] + (track.lat[b] - track.lat[a]) * f;
          lon = lerpLon(track.lon[a], track.lon[b], f);
          heightM = lerpFinite(track.h[a], track.h[b], f);
          headingDeg = lerpHeading(track.hdg[a], track.hdg[b], f);
          speed = lerpFinite(track.spd[a], track.spd[b], f);
          ageMs = t - track.t[a];
        }
        out.push({
          layerId: track.layerId,
          id: track.id,
          label: track.label,
          lat,
          lon,
          heightM: Number.isFinite(heightM) ? heightM : 0,
          headingDeg: Number.isFinite(headingDeg) ? headingDeg : NaN,
          speed: Number.isFinite(speed) ? speed : NaN,
          ageMs,
        });
      }
    return out;
  }

  /**
   * Dead-reckoned positions for a time after the newest fix. Each recently
   * active track (last fix within maxStaleMs of newestT) is advanced along its
   * last heading at its last speed; confidence decays with lead time and with
   * how stale the last fix already was.
   */
  function forecastAt(
    displayTimeMs,
    out = [],
    { maxStaleMs = 10 * 60_000, maxAheadMs = 15 * 60_000 } = {},
  ) {
    out.length = 0;
    if (!Number.isFinite(displayTimeMs)) return out;
    const t = displayTimeMs;
    const { newestT } = range();
    if (!Number.isFinite(newestT)) return out;
    for (const tracks of byLayer.values())
      for (const track of tracks.values()) {
        const n = track.count;
        if (!n) continue;
        const a = slot(track, n - 1);
        const lastT = track.t[a];
        if (newestT - lastT > maxStaleMs) continue;
        const aheadMs = t - lastT;
        if (aheadMs <= 0 || aheadMs > maxAheadMs + maxStaleMs) continue;
        const speed = track.spd[a];
        const heading = track.hdg[a];
        let lat = track.lat[a];
        let lon = track.lon[a];
        if (Number.isFinite(speed) && speed > 0.2 && Number.isFinite(heading)) {
          const distanceM = speed * (aheadMs / 1000);
          const moved = destinationPoint(lat, lon, heading, distanceM);
          lat = moved.lat;
          lon = moved.lon;
        }
        const confidence = Math.max(
          0.05,
          Math.exp(-aheadMs / (8 * 60_000)) *
            (Number.isFinite(speed) ? 1 : 0.6),
        );
        out.push({
          layerId: track.layerId,
          id: track.id,
          label: track.label,
          lat,
          lon,
          heightM: track.h[a],
          headingDeg: heading,
          speed,
          ageMs: aheadMs,
          predicted: true,
          confidence,
        });
      }
    return out;
  }

  function trackOf(layerId, id) {
    const track = byLayer.get(layerId)?.get(String(id));
    if (!track) return [];
    const fixes = [];
    for (let i = 0; i < track.count; i++) {
      const s = slot(track, i);
      fixes.push({
        t: track.t[s],
        lat: track.lat[s],
        lon: track.lon[s],
        heightM: track.h[s],
        headingDeg: track.hdg[s],
        speed: track.spd[s],
      });
    }
    return fixes;
  }

  /** Flat [lon, lat, height, ...] of fixes inside [fromT, toT], oldest first. */
  function trailPositions(layerId, id, fromT, toT, out = []) {
    out.length = 0;
    const track = byLayer.get(layerId)?.get(String(id));
    if (!track) return out;
    for (let i = 0; i < track.count; i++) {
      const s = slot(track, i);
      const t = track.t[s];
      if (t < fromT) continue;
      if (t > toT) break;
      out.push(
        track.lon[s],
        track.lat[s],
        Number.isFinite(track.h[s]) ? track.h[s] : 0,
      );
    }
    return out;
  }

  function stats() {
    let fixes = 0;
    let tracks = 0;
    for (const layer of byLayer.values())
      for (const track of layer.values()) {
        tracks++;
        fixes += track.count;
      }
    return { tracks, fixes, bytes: allocatedBytes, maxBytes, revision };
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    detach();
    byLayer.clear();
    allocatedBytes = 0;
    newestT = NaN;
  }

  attach(dataManager);
  return {
    layers: [...watched],
    retentionMs,
    attach,
    detach,
    recordSnapshot,
    snapshotLayer,
    entitiesAt,
    forecastAt,
    range,
    trackOf,
    trailPositions,
    stats,
    get revision() {
      return revision;
    },
    destroy,
  };
}
