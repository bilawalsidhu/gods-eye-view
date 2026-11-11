import {
  PARTIAL_RETENTION_MS,
  SELECTED_PIN_REFRESHES,
} from './recordPolicy.js';

/**
 * Normalize AIS display fields without allocating scene resources. `id` is the
 * vessel's key, the stable id its source gives; a row that names none (an
 * AIS feed's own rows) is keyed by its MMSI. `mmsi` is only an attribute,
 * shown when known: vessels can share one. A row with neither is unkeyed.
 */
export function normalizeVessel(row) {
  const lat = Number(row.lat);
  const lon = Number(row.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const mmsi = String(row.mmsi || '').trim();
  const id = String(row.id ?? mmsi).trim();
  return {
    lat,
    lon,
    name: String(row.name || mmsi || 'VESSEL'),
    id,
    mmsi,
    reference: row.reference ?? id,
    imo: String(row.imo || ''),
    type: String(row.type || ''),
    destination: String(row.destination || ''),
    speed: finiteNumber(row.speed),
    course: finiteNumber(row.course),
    heading: finiteNumber(row.heading),
    lastPositionUtc: String(row.last_position_UTC || ''),
    lastPositionEpoch: finiteNumber(row.last_position_epoch),
    missedRefreshes: 0,
  };
}

/**
 * Note when a fix was first received (`fixReceivedAtMs`, this client's
 * clock) and the newest fix in that refresh (`fixFeedEpoch`, the feed's
 * clock): its age is then read on each clock separately, so neither a
 * skewed client clock nor a re-served cached row hides how old it is.
 * `receivedAtMs` stays the time the row was last seen, for retention.
 */
function stampFix(record, receivedAtMs, feedLatestEpoch) {
  record.fixReceivedAtMs = receivedAtMs;
  record.fixFeedEpoch = feedLatestEpoch;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * The move from a record's fix to the next row's, when the fix moves on in
 * time; otherwise the move it was making, if the row repeats its fix.
 */
function motionBetween(record, next) {
  const fromEpoch = record.lastPositionEpoch;
  const toEpoch = next.lastPositionEpoch;
  if (fromEpoch === toEpoch) return record.motion ?? null;
  if (!Number.isFinite(fromEpoch) || !Number.isFinite(toEpoch)) return null;
  if (!(toEpoch > fromEpoch)) return null;
  return {
    fromLat: record.lat,
    fromLon: record.lon,
    fromMs: fromEpoch * 1000,
    toLat: next.lat,
    toLon: next.lon,
    toMs: toEpoch * 1000,
  };
}

/** Own stable vessel records and bounded incomplete/selected retention. */
export class VesselRecords {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.byId = new Map();
    this.unkeyed = [];
    this.all = [];
  }
  /**
   * Fold a refresh into the records. Following the world clock (`follow`),
   * a vessel whose fix moves on keeps where it moved from, so it can be drawn
   * between the two (see motion.js). `replace`: the rows are the world at
   * another time (the clock jumped), so they stand in for every vessel: one
   * they lack is gone at once, selected or not, and none moves from where it
   * was at the time the clock left.
   */
  reconcile(
    rows,
    {
      complete = true,
      selectedRecord = null,
      cap = Infinity,
      replace = false,
      follow = false,
    },
    effects,
  ) {
    const receivedAtMs = this.now();
    // The newest fix in the batch: the feed's own "now", so a fix's age can
    // be read on the feed's clock rather than against this client's (see
    // stampFix).
    let feedLatestEpoch = null;
    for (const row of rows) {
      const epoch = finiteNumber(row?.last_position_epoch);
      if (
        epoch !== null &&
        (feedLatestEpoch === null || epoch > feedLatestEpoch)
      )
        feedLatestEpoch = epoch;
    }
    for (const record of this.unkeyed) effects.remove(record, false);
    this.unkeyed = [];
    const seen = new Set();
    for (const row of rows) {
      const next = normalizeVessel(row);
      if (!next) continue;
      next.receivedAtMs = receivedAtMs;
      stampFix(next, receivedAtMs, feedLatestEpoch);
      if (!next.id) {
        effects.add(next);
        this.unkeyed.push(next);
        continue;
      }
      if (seen.has(next.id)) continue;
      seen.add(next.id);
      const record = this.byId.get(next.id);
      if (record) {
        const before = effects.beforeUpdate(record);
        // A feed re-serving a cached row repeats its fix: the fix keeps the
        // time it was first received, so it goes on ageing.
        if (next.lastPositionEpoch !== record.lastPositionEpoch) {
          record.fixReceivedAtMs = next.fixReceivedAtMs;
          record.fixFeedEpoch = next.fixFeedEpoch;
        }
        if (replace) record.motion = null;
        else if (follow) record.motion = motionBetween(record, next);
        record.reference = next.reference;
        record.mmsi = next.mmsi;
        record.receivedAtMs = next.receivedAtMs;
        record.lat = next.lat;
        record.lon = next.lon;
        record.name = next.name;
        record.imo = next.imo;
        record.type = next.type;
        record.destination = next.destination;
        record.speed = next.speed;
        record.course = next.course;
        record.heading = next.heading;
        record.lastPositionUtc = next.lastPositionUtc;
        record.lastPositionEpoch = next.lastPositionEpoch;
        record.missedRefreshes = 0;

        effects.updated(record, before);
      } else {
        effects.add(next);
        this.byId.set(next.id, next);
      }
    }
    for (const [id, record] of this.byId) {
      if (seen.has(id)) continue;
      if (replace) {
        effects.remove(record, record === selectedRecord);
        this.byId.delete(id);
        effects.removed(id);
        continue;
      }
      if (
        !complete &&
        Number.isFinite(record.receivedAtMs) &&
        receivedAtMs - record.receivedAtMs < PARTIAL_RETENTION_MS
      ) {
        if (record === selectedRecord) {
          record.missedRefreshes = Math.max(1, record.missedRefreshes || 0);
          effects.staleSelected(record);
        }
        continue;
      }
      if (record === selectedRecord) {
        record.missedRefreshes = (record.missedRefreshes || 0) + 1;
        if (complete && record.missedRefreshes <= SELECTED_PIN_REFRESHES) {
          effects.staleSelected(record);
          continue;
        }
      }
      // Selection teardown still sees the record before its store entry is removed.
      effects.remove(record, record === selectedRecord);
      this.byId.delete(id);
      effects.removed(id);
    }
    if (this.byId.size + this.unkeyed.length > cap) {
      for (const [id, record] of this.byId) {
        if (this.byId.size + this.unkeyed.length <= cap) break;
        if (seen.has(id) || record === selectedRecord) continue;
        effects.remove(record, false);
        this.byId.delete(id);
        effects.removed(id);
      }
    }
    this.all = [...this.byId.values(), ...this.unkeyed];
  }
}
