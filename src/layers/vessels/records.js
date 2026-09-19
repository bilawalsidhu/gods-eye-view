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
    callSign: String(row.call_sign || ''),
    draught: finiteNumber(row.draught),
    loadState: String(row.load_state || ''),
    eta: String(row.eta || ''),
    length: finiteNumber(row.length),
    beam: finiteNumber(row.beam),
    navStatus: finiteNumber(row.nav_status),
    navStatusText: String(row.nav_status_text || ''),
    flag: String(row.flag || ''),
    flagCode: String(row.flag_code || ''),
    imoValid:
      row.imo_valid === null || row.imo_valid === undefined
        ? null
        : Boolean(row.imo_valid),
    sanctioned: Boolean(row.sanctioned),
    sanctionConfidence: String(row.sanction_confidence || ''),
    sanctionPrograms: String(row.sanction_programs || ''),
    estimated: Boolean(row.estimated),
    estMoved: Boolean(row.est_moved),
    estAgeSec: finiteNumber(row.est_age_sec),
    estConfidence: finiteNumber(row.est_confidence),
    estFromLat: finiteNumber(row.est_from_lat),
    estFromLon: finiteNumber(row.est_from_lon),
    gapKind: String(row.gap_kind || ''),
    missedRefreshes: 0,
  };
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
    for (const record of this.unkeyed) effects.remove(record, false);
    this.unkeyed = [];
    const seen = new Set();
    for (const row of rows) {
      const next = normalizeVessel(row);
      if (!next) continue;
      next.receivedAtMs = receivedAtMs;
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
        record.callSign = next.callSign;
        record.draught = next.draught;
        record.loadState = next.loadState;
        record.eta = next.eta;
        record.length = next.length;
        record.beam = next.beam;
        record.navStatus = next.navStatus;
        record.navStatusText = next.navStatusText;
        record.flag = next.flag;
        record.flagCode = next.flagCode;
        record.imoValid = next.imoValid;
        record.sanctioned = next.sanctioned;
        record.sanctionConfidence = next.sanctionConfidence;
        record.sanctionPrograms = next.sanctionPrograms;
        record.estimated = next.estimated;
        record.estMoved = next.estMoved;
        record.estAgeSec = next.estAgeSec;
        record.estConfidence = next.estConfidence;
        record.estFromLat = next.estFromLat;
        record.estFromLon = next.estFromLon;
        record.gapKind = next.gapKind;
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
