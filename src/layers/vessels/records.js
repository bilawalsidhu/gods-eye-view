import {
  PARTIAL_RETENTION_MS,
  SELECTED_PIN_REFRESHES,
} from './recordPolicy.js';

/** Normalize AIS display fields without allocating scene resources. */
export function normalizeVessel(row) {
  const lat = Number(row.lat);
  const lon = Number(row.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    lat,
    lon,
    name: String(row.name || row.mmsi || 'VESSEL'),
    mmsi: String(row.mmsi || '').trim(),
    reference: row.reference ?? String(row.mmsi || '').trim(),
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

/** Own stable vessel records and bounded incomplete/selected retention. */
export class VesselRecords {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.byMmsi = new Map();
    this.unkeyed = [];
    this.all = [];
  }
  reconcile(
    rows,
    { complete = true, selectedRecord = null, cap = Infinity },
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
      if (!next.mmsi) {
        effects.add(next);
        this.unkeyed.push(next);
        continue;
      }
      if (seen.has(next.mmsi)) continue;
      seen.add(next.mmsi);
      const record = this.byMmsi.get(next.mmsi);
      if (record) {
        const before = effects.beforeUpdate(record);
        // A feed re-serving a cached row repeats its fix: the fix keeps the
        // time it was first received, so it goes on ageing.
        if (next.lastPositionEpoch !== record.lastPositionEpoch) {
          record.fixReceivedAtMs = next.fixReceivedAtMs;
          record.fixFeedEpoch = next.fixFeedEpoch;
        }
        record.reference = next.reference;
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
        this.byMmsi.set(next.mmsi, next);
      }
    }
    for (const [mmsi, record] of this.byMmsi) {
      if (seen.has(mmsi)) continue;
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
      this.byMmsi.delete(mmsi);
      effects.removed(mmsi);
    }
    if (this.byMmsi.size + this.unkeyed.length > cap) {
      for (const [mmsi, record] of this.byMmsi) {
        if (this.byMmsi.size + this.unkeyed.length <= cap) break;
        if (seen.has(mmsi) || record === selectedRecord) continue;
        effects.remove(record, false);
        this.byMmsi.delete(mmsi);
        effects.removed(mmsi);
      }
    }
    this.all = [...this.byMmsi.values(), ...this.unkeyed];
  }
}
