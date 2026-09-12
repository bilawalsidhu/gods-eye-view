/**
 * Pick a web receiver to listen to a DX-cluster spot — pure and browser-safe.
 *
 * The DX station is by definition far away and rare; what the listener wants
 * is a receiver that can actually HEAR it. Two kinds of evidence say where
 * that is, in order of trust:
 *
 *   1. Reception reports (PSKReporter) on the spot's band from the last
 *      45 minutes: the DX was decoded by a station at a known grid, so a
 *      receiver near that station is very likely to hear it too. Only
 *      digital/CW spots qualify — PSKReporter never sees SSB, AM or FM.
 *   2. The spotter: whoever posted the spot heard the DX, so a receiver near
 *      the spotter is the next best bet. The spotter's position may be exact,
 *      a grid, a call-area centroid or an entity centroid — the coarser it is
 *      the more clearly `reason` says so.
 *
 * The DX location itself is NEVER used: a receiver next to a rare DX station
 * is usually the one place you cannot hear it via skip, and the layer would
 * only be guessing at its position anyway.
 */

import { rankWebReceivers } from './webReceiverTuning.js';
import { bandForHz, distanceKm, formatAge, receiverModeForSpot } from './hamRadioShared.js';

export const RECEPTION_MAX_AGE_MIN = 45;
export const RECEPTION_MAX_DISTANCE_KM = 500;
export const KIWI_DEFAULT_BANDS = Object.freeze([
  Object.freeze({ lowHz: 10_000, highHz: 30_000_000, label: '10 kHz–30 MHz' }),
]);

/** Spot modes PSKReporter can corroborate (digital and CW). */
const EVIDENCE_SPOT_MODES = new Set([
  'CW', 'FT8', 'FT4', 'RTTY', 'PSK', 'PSK31', 'PSK63', 'JS8', 'WSPR', 'MSK144', 'Q65', 'JT65', 'JT9', 'DIGI', 'BEACON',
]);
/** Report modes that never count as evidence (PSKReporter should not emit these, but be safe). */
const NON_EVIDENCE_REPORT_MODES = new Set(['SSB', 'USB', 'LSB', 'AM', 'FM', 'NFM', 'WFM']);

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(String(value).trim().replace(',', '.'));
  return Number.isFinite(number) ? number : null;
}

function upper(value) {
  return String(value ?? '').trim().toUpperCase();
}

function bandLabel(band) {
  const text = String(band ?? '').trim().toLowerCase();
  const match = text.match(/^(\d+(?:\.\d+)?)(m|cm)$/);
  return match ? `${match[1]} ${match[2]}` : (text || 'unknown band');
}

function spotBandOf(spot) {
  const explicit = String(spot?.band ?? '').trim().toLowerCase();
  if (explicit) return explicit;
  return bandForHz(spot?.freqHz) || null;
}

/** Receivers a tune can succeed on: known-offline ones are dropped; Kiwis with no published bands cover HF. */
function prepareReceivers(receivers) {
  const originals = new Map();
  const rows = [];
  for (const receiver of Array.isArray(receivers) ? receivers : []) {
    if (!receiver || typeof receiver !== 'object') continue;
    if (receiver.online === false) continue;
    if (finiteOrNull(receiver.lat) === null || finiteOrNull(receiver.lon) === null) continue;
    let row = receiver;
    if (receiver.type === 'kiwisdr' && !(Array.isArray(receiver.bands) && receiver.bands.length)) {
      row = { ...receiver, bands: KIWI_DEFAULT_BANDS };
    }
    originals.set(row, receiver);
    rows.push(row);
  }
  return { rows, originals };
}

/** Receivers that positively cover `hz`, ranked by rankWebReceivers around an anchor. */
function coveringReceiversNear(prepared, anchor, hz, limit = 25) {
  return rankWebReceivers(prepared.rows, { lat: anchor.lat, lon: anchor.lon, hz, requireCoverage: true, limit })
    .filter((row) => row.covers === true && row.online)
    .map((row) => ({ receiver: prepared.originals.get(row.receiver) || row.receiver, distanceKm: row.distanceKm, full: row.full }));
}

/** Usable PSKReporter reports for this spot: same band, fresh, compatible mode, with a position. */
export function receptionEvidenceForSpot(spot, reception, nowMs = Date.now()) {
  const psk = reception?.psk;
  if (!psk || !Array.isArray(psk.reports) || !psk.reports.length) return [];
  const spotMode = upper(spot?.mode);
  if (spotMode && !EVIDENCE_SPOT_MODES.has(spotMode)) return [];
  const reportedCall = upper(psk.call);
  const dx = upper(spot?.dx);
  if (reportedCall && dx && reportedCall !== dx) return [];
  const band = spotBandOf(spot);
  if (!band) return [];
  const now = finiteOrNull(nowMs) ?? Date.now();
  const rows = [];
  for (const report of psk.reports) {
    if (!report || typeof report !== 'object') continue;
    const lat = finiteOrNull(report.lat);
    const lon = finiteOrNull(report.lon);
    if (lat === null || lon === null) continue;
    const reportBand = String(report.band ?? '').trim().toLowerCase() || bandForHz(report.freqHz) || '';
    if (reportBand !== band) continue;
    const reportMode = upper(report.mode);
    if (reportMode && NON_EVIDENCE_REPORT_MODES.has(reportMode)) continue;
    let ageMin = null;
    if (report.timeIso !== undefined && report.timeIso !== null && report.timeIso !== '') {
      const time = typeof report.timeIso === 'number' ? report.timeIso : Date.parse(String(report.timeIso));
      if (!Number.isFinite(time)) continue;
      ageMin = (now - time) / 60_000;
      if (ageMin > RECEPTION_MAX_AGE_MIN || ageMin < -5) continue;
    }
    rows.push({
      rxCall: upper(report.rxCall) || 'unknown station',
      rxGrid: String(report.rxGrid ?? '').trim() || null,
      lat,
      lon,
      band: reportBand,
      mode: reportMode || null,
      snr: finiteOrNull(report.snr),
      ageMin,
      timeIso: report.timeIso ?? null,
    });
  }
  rows.sort((a, b) => (b.snr ?? -999) - (a.snr ?? -999) || (a.ageMin ?? 0) - (b.ageMin ?? 0));
  return rows;
}

function spotterPrecisionNote(spot, loc) {
  const precision = String(loc?.precision ?? '').toLowerCase();
  const entity = loc?.entity ? String(loc.entity) : null;
  if (precision === 'area') {
    const call = upper(spot?.spotterCall || spot?.spotter);
    const digit = (call.match(/\d/) || [])[0] || null;
    const shortEntity = entity && /united states/i.test(entity) ? 'US' : entity;
    const where = shortEntity ? `${shortEntity} call area${digit ? ` ${digit}` : ''}` : (digit ? `call area ${digit}` : 'call area');
    return `spotter position is approximate (${where})`;
  }
  if (precision === 'entity') {
    return `spotter position is approximate (entity centroid${entity ? ` of ${entity}` : ''}, ±2000 km)`;
  }
  if (precision === 'grid') return 'spotter position from grid locator';
  return 'spotter position is exact';
}

function formatKm(km) {
  return Number.isFinite(km) ? `${Math.round(km)} km` : '? km';
}

function formatSnr(snr) {
  if (snr === null || snr === undefined) return '';
  return `, SNR ${snr > 0 ? '+' : ''}${Math.round(snr)} dB`;
}

/**
 * Choose the receiver to tune for a spot.
 *
 * @param {object} args
 * @param {object} args.spot        Spot (contract §1.3): dx, spotter, spotterCall, freqHz, band, mode, spotterLoc
 * @param {object[]} args.receivers Web receivers (frozen rows from src/data/webReceivers.js)
 * @param {object|null} args.reception  Reception (contract §1.3) fetched for `spot.dx`, or null
 * @param {number} args.nowMs
 * @param {number} args.limit       Candidates to return (default 5)
 * @returns {{ best: object|null, candidates: object[], mode: string, reason: string, evidence: 'reception'|'spotter'|null }}
 */
export function chooseReceiverForSpot({ spot, receivers, reception = null, nowMs = Date.now(), limit = 5 } = {}) {
  const mode = receiverModeForSpot(spot);
  const max = Math.max(1, Math.min(50, Math.round(finiteOrNull(limit) ?? 5)));
  const hz = finiteOrNull(spot?.freqHz);
  const empty = (reason) => ({ best: null, candidates: [], mode, reason, evidence: null });
  if (!spot || typeof spot !== 'object' || hz === null || hz <= 0) return empty('spot has no frequency');
  const prepared = prepareReceivers(receivers);
  const now = finiteOrNull(nowMs) ?? Date.now();
  const band = spotBandOf(spot);

  // (1) Reception evidence on the spot's band.
  const reports = receptionEvidenceForSpot(spot, reception, now);
  if (reports.length && prepared.rows.length) {
    const byReceiver = new Map();
    for (const report of reports) {
      const near = coveringReceiversNear(prepared, report, hz, 25)
        .filter((row) => row.distanceKm !== null && row.distanceKm <= RECEPTION_MAX_DISTANCE_KM);
      for (const row of near) {
        const key = row.receiver.id ?? row.receiver.url ?? row.receiver;
        const existing = byReceiver.get(key);
        const score = report.snr ?? -999;
        if (existing && (existing.score > score || (existing.score === score && existing.distanceKm <= row.distanceKm))) continue;
        const age = report.ageMin === null ? 'recently' : `${formatAge(now - report.ageMin * 60_000, now)} ago`;
        const grid = report.rxGrid ? ` (${report.rxGrid})` : '';
        byReceiver.set(key, {
          receiver: row.receiver,
          distanceKm: row.distanceKm,
          evidence: 'reception',
          precision: 'grid',
          anchor: { lat: report.lat, lon: report.lon, label: `${report.rxCall}${grid}`, precision: 'grid' },
          report: { rxCall: report.rxCall, rxGrid: report.rxGrid, snr: report.snr, band: report.band, mode: report.mode, ageMin: report.ageMin, timeIso: report.timeIso },
          score,
          full: row.full,
          reason: `heard by ${report.rxCall}${grid} on ${bandLabel(report.band)} ${age}${formatSnr(report.snr)}; ${row.receiver.name} is ${formatKm(row.distanceKm)} from ${report.rxCall}`,
        });
      }
    }
    if (byReceiver.size) {
      const candidates = [...byReceiver.values()]
        .sort((a, b) => b.score - a.score || a.distanceKm - b.distanceKm)
        .slice(0, max)
        .map(({ score, full, ...row }) => row);
      return { best: candidates[0], candidates, mode, reason: candidates[0].reason, evidence: 'reception' };
    }
  }

  // (2) The spotter's position — never the DX.
  const loc = spot.spotterLoc;
  const spotterLat = finiteOrNull(loc?.lat);
  const spotterLon = finiteOrNull(loc?.lon);
  if (spotterLat === null || spotterLon === null) {
    return empty(reports.length ? 'no covering receiver near any reporting station and spotter location unknown' : 'spotter location unknown');
  }
  const spotterCall = upper(spot.spotterCall || spot.spotter) || 'spotter';
  const precision = String(loc.precision ?? 'exact').toLowerCase();
  const note = spotterPrecisionNote(spot, loc);
  const anchor = { lat: spotterLat, lon: spotterLon, label: `spotter ${spotterCall}`, precision };
  const near = coveringReceiversNear(prepared, anchor, hz, 25);
  if (!near.length) {
    return { best: null, candidates: [], mode, reason: `no online receiver covering ${bandLabel(band)} near spotter ${spotterCall}; ${note}`, evidence: null };
  }
  const candidates = near.slice(0, max).map((row) => ({
    receiver: row.receiver,
    distanceKm: row.distanceKm,
    evidence: 'spotter',
    precision,
    anchor,
    report: null,
    reason: `${row.receiver.name} is ${formatKm(row.distanceKm)} from spotter ${spotterCall}; ${note}`,
  }));
  return { best: candidates[0], candidates, mode, reason: candidates[0].reason, evidence: 'spotter' };
}
