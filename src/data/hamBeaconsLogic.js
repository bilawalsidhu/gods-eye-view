/**
 * Beacons layer — pure helpers (browser-safe, Cesium-free, no DOM).
 *
 * Two families of beacon live in the `ham-beacons` layer:
 *
 *   • NCDXF/IARU International Beacon Project (IBP): 18 HF CW beacons sharing
 *     five frequencies in a 3-minute cycle — the static table and the slot
 *     maths come from `./ncdxfBeacons.js`; this file turns a slot into marker
 *     styles, the transmitting label (`14.100 ▶ OH2B · 10W`), the pulsing
 *     ring size and the "which beacon / which band / when" answer a tune
 *     request needs.
 *   • VHF/UHF beacons from HamRig (`/api/hamrig/beacons/vhf`, login-gated:
 *     a 403 from the proxy means "not configured" and is NOT an error).
 *
 * The layer module (`hamBeacons.js`) owns Cesium and the web-receiver hand-off;
 * the unit tests import only this file. Every clock-dependent helper takes
 * `nowMs`.
 */

import { IBP_BANDS, IBP_BEACONS, ibpBeacon, ibpScheduleFor, ibpSlot, isIbpOffAir } from './ncdxfBeacons.js';
import { bandForHz, distanceKm, formatAge, formatHz } from './hamRadioShared.js';
import { rankWebReceivers } from './webReceiverTuning.js';

export const IBP_COLOR = '#fbbf24';
export const IBP_OFF_AIR_COLOR = '#6b7280';
export const VHF_COLOR = '#22c55e';
/** A VHF beacon heard within this window is drawn brighter. */
export const VHF_HEARD_WINDOW_MS = 2 * 60 * 60 * 1000;
/** Ticker cadence while the layer is enabled. */
export const TICK_MS = 1000;
export const LIST_LIMIT = 200;
/** Beacons are CW; a web receiver is always tuned in CW mode. */
export const TUNE_MODE = 'cw';
export const VHF_ENDPOINT = '/api/hamrig/beacons/vhf';
/** KiwiSDRs that publish no bands cover the whole HF range. */
export const KIWI_DEFAULT_BANDS = Object.freeze([
  Object.freeze({ lowHz: 10_000, highHz: 30_000_000, label: '10 kHz–30 MHz' }),
]);

export const BEACON_KIND_FILTERS = Object.freeze([
  { id: 'all', label: 'All beacons' },
  { id: 'ibp', label: 'NCDXF/IBP' },
  { id: 'vhf', label: 'VHF/UHF' },
].map((row) => Object.freeze(row)));

const IBP_BAND_NAMES = Object.freeze(IBP_BANDS.map((row) => row.band));

export const BEACON_BAND_FILTERS = Object.freeze([
  { id: 'all', label: 'All bands' },
  ...IBP_BANDS.map((row) => ({ id: row.band, label: `${row.band.replace('m', ' m')} · ${formatIbpKhz(row.khz)}` })),
  { id: '6m', label: '6 m' },
  { id: '4m', label: '4 m' },
  { id: '2m', label: '2 m' },
  { id: '70cm', label: '70 cm' },
  { id: '23cm', label: '23 cm' },
].map((row) => Object.freeze(row)));

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(String(value).trim().replace(',', '.'));
  return Number.isFinite(number) ? number : null;
}

function cleanText(value, maxLength = 120) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function textOrNull(value, maxLength = 120) {
  const text = cleanText(value, maxLength);
  return text ? text : null;
}

function upperCall(value) {
  return cleanText(value, 20).toUpperCase().replace(/\s+/g, '');
}

/** Item id for an IBP beacon (`ibp:OH2B`). */
export function ibpId(call) {
  return `ibp:${upperCall(call)}`;
}

/** Item id for a VHF beacon (`vhf:DB0XX:144412000`). */
export function vhfId(beacon) {
  return `vhf:${upperCall(beacon?.call)}:${Math.round(finiteOrNull(beacon?.freqHz) ?? 0)}`;
}

/** `14100` → `'14.100'` (MHz with three decimals, as printed on the IBP schedule). */
export function formatIbpKhz(khz) {
  const value = finiteOrNull(khz);
  return value === null ? '' : (value / 1000).toFixed(3);
}

/** Power-step suffix: the four dashes are 100 W … 100 mW, the first 6 s send the callsign. */
export function powerStepLabel(powerStep) {
  const step = String(powerStep ?? '').trim();
  if (!step || step === 'call') return 'ID';
  return step;
}

/** The transmitting label: `14.100 ▶ OH2B · 10W` (`· ID` while the callsign is sent, `· off air`). */
export function ibpTxLabel({ khz, call, powerStep = 'call', offAir = false } = {}) {
  const suffix = offAir ? 'off air' : powerStepLabel(powerStep);
  return `${formatIbpKhz(khz)} ▶ ${upperCall(call)} · ${suffix}`;
}

/** Map callsign → the `byBand` row it is transmitting on in this slot (one band per beacon). */
export function transmittingByCall(slotInfo) {
  const map = new Map();
  for (const row of Array.isArray(slotInfo?.byBand) ? slotInfo.byBand : []) {
    if (row?.call) map.set(upperCall(row.call), row);
  }
  return map;
}

/** Marker style for an IBP beacon: amber, grey when off-air, larger while transmitting. */
export function ibpMarkerStyle({ offAir = false, transmitting = false, selected = false, dimmed = false } = {}) {
  const color = offAir ? IBP_OFF_AIR_COLOR : IBP_COLOR;
  let alpha = offAir ? 0.55 : 0.85;
  if (transmitting && !offAir) alpha = 1;
  if (dimmed) alpha = Math.min(alpha, 0.4);
  let pixelSize = transmitting && !offAir ? 13 : 10;
  if (selected) pixelSize += 2;
  return { color, alpha, pixelSize };
}

/**
 * Pulsing ring size in pixels: a raised cosine over `periodMs` so the ring
 * breathes between `minPx` and `maxPx` once per second.
 */
export function pulseRingPixels(nowMs, { periodMs = 1000, minPx = 16, maxPx = 28 } = {}) {
  const now = finiteOrNull(nowMs) ?? 0;
  const period = Math.max(1, finiteOrNull(periodMs) ?? 1000);
  const phase = ((now % period) + period) % period / period;
  const low = finiteOrNull(minPx) ?? 16;
  const high = Math.max(low, finiteOrNull(maxPx) ?? 28);
  return low + (high - low) * (1 - Math.cos(2 * Math.PI * phase)) / 2;
}

/** Whether a VHF beacon was heard within the bright window. */
export function vhfHeardRecently(beacon, nowMs = Date.now()) {
  const at = Date.parse(String(beacon?.lastHeard?.atIso ?? ''));
  if (!Number.isFinite(at)) return false;
  const age = (finiteOrNull(nowMs) ?? 0) - at;
  return age >= 0 && age <= VHF_HEARD_WINDOW_MS;
}

/** Marker style for a VHF beacon: green, brighter and bigger when heard < 2 h ago. */
export function vhfMarkerStyle(beacon, nowMs = Date.now(), { selected = false, dimmed = false } = {}) {
  const heard = vhfHeardRecently(beacon, nowMs);
  let alpha = heard ? 1 : 0.55;
  if (dimmed) alpha = Math.min(alpha, 0.35);
  let pixelSize = heard ? 11 : 8;
  if (selected) pixelSize += 2;
  return { color: VHF_COLOR, alpha, pixelSize, heardRecently: heard };
}

/** Re-validate one proxy VHF row (`VhfBeacon` shape); the browser never trusts the wire blindly. */
export function isValidVhfBeacon(row) {
  if (!row || typeof row !== 'object') return false;
  if (!/^[A-Z0-9/-]{3,12}$/i.test(upperCall(row.call))) return false;
  const hz = finiteOrNull(row.freqHz);
  if (hz === null || hz < 28_000_000 || hz > 100_000_000_000) return false;
  const lat = finiteOrNull(row.lat);
  const lon = finiteOrNull(row.lon);
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
  if (lat === 0 && lon === 0) return false;
  return true;
}

/** Freeze a validated VHF row into the shape the layer and voice tools use. */
export function freezeVhfBeacon(row) {
  const freqHz = Math.round(Number(row.freqHz));
  const heard = row.lastHeard && typeof row.lastHeard === 'object' ? row.lastHeard : null;
  const atIso = heard && typeof heard.atIso === 'string' && Number.isFinite(Date.parse(heard.atIso)) ? heard.atIso : null;
  const call = upperCall(row.call);
  return Object.freeze({
    id: `vhf:${call}:${freqHz}`,
    kind: 'vhf',
    call,
    freqHz,
    band: textOrNull(row.band, 10) ?? bandForHz(freqHz),
    locator: textOrNull(row.locator, 10),
    lat: Number(row.lat),
    lon: Number(row.lon),
    location: textOrNull(row.location, 120),
    lastHeard: heard && (atIso || heard.spotter)
      ? Object.freeze({ atIso, spotter: textOrNull(heard.spotter, 20), snr: finiteOrNull(heard.snr) })
      : null,
    frequencyLabel: formatHz(freqHz),
  });
}

/**
 * Interpret the proxy response for `/api/hamrig/beacons/vhf`.
 * 403 → `forbidden` (HamRig login not configured): no beacons, NO error.
 * Any other non-2xx → `error`. Invalid rows are dropped, duplicates collapsed.
 */
export function parseVhfResponse({ status, body } = {}) {
  const code = finiteOrNull(status) ?? 0;
  const updatedAt = typeof body?.generatedAt === 'string' ? body.generatedAt : null;
  if (code === 403) return { beacons: Object.freeze([]), forbidden: true, error: null, updatedAt };
  if (code < 200 || code >= 300) {
    return {
      beacons: Object.freeze([]),
      forbidden: false,
      error: cleanText(body?.error, 200) || `VHF beacon feed returned ${code || 'no status'}`,
      updatedAt,
    };
  }
  const rows = Array.isArray(body?.beacons) ? body.beacons : (Array.isArray(body) ? body : []);
  const seen = new Set();
  const beacons = [];
  for (const row of rows) {
    if (!isValidVhfBeacon(row)) continue;
    const frozen = freezeVhfBeacon(row);
    if (seen.has(frozen.id)) continue;
    seen.add(frozen.id);
    beacons.push(frozen);
  }
  return { beacons: Object.freeze(beacons), forbidden: false, error: null, updatedAt };
}

/** Panel filter, validated (bad values keep the current one). */
export function normalizeBeaconFilter(next = {}, current = { kind: 'all', band: 'all' }) {
  const kindInput = String(next?.kind ?? '').trim().toLowerCase();
  const kind = ['all', 'ibp', 'vhf'].includes(kindInput) ? kindInput : (current?.kind || 'all');
  const bandInput = String(next?.band ?? '').trim().toLowerCase();
  const band = BEACON_BAND_FILTERS.some((row) => row.id === bandInput) ? bandInput : (current?.band || 'all');
  return Object.freeze({ kind, band });
}

/**
 * Whether an item passes `{ kind, band }`. IBP beacons rotate through all five
 * HF bands, so any IBP band selects every IBP beacon.
 */
export function beaconMatchesFilter(item, filter = {}) {
  if (!item) return false;
  const kind = filter.kind || 'all';
  const band = filter.band || 'all';
  if (kind !== 'all' && item.kind !== kind) return false;
  if (band === 'all') return true;
  if (item.kind === 'ibp') return IBP_BAND_NAMES.includes(band);
  return item.band === band;
}

/** IBP band row for a query: '20m', '20', 14100, '14.1', '14.100', 14100000 → `{ khz, band, color }` or null. */
export function ibpBandForQuery(query) {
  if (query === null || query === undefined || query === '') return null;
  const text = String(query).trim().toLowerCase();
  const byName = IBP_BANDS.find((row) => row.band === text || row.band === `${text}m`);
  if (byName) return byName;
  const number = finiteOrNull(text.replace(/\s*(khz|mhz|hz)$/i, ''));
  if (number === null) return null;
  let khz = number;
  if (number > 1_000_000) khz = number / 1000; // Hz
  else if (number < 100) khz = number * 1000; // MHz
  return IBP_BANDS.find((row) => Math.abs(row.khz - khz) <= 5) || null;
}

/** The 18 IBP beacons as UI items with their state at `nowMs`. */
export function ibpItems(nowMs = Date.now(), { selectedId = null } = {}) {
  const slot = ibpSlot(nowMs);
  const tx = transmittingByCall(slot);
  return IBP_BEACONS.map((beacon) => {
    const row = tx.get(beacon.call) || null;
    const schedule = ibpScheduleFor(beacon.call, nowMs);
    const next = schedule.length
      ? schedule.reduce((best, entry) => (entry.secondsUntil < best.secondsUntil ? entry : best), schedule[0])
      : null;
    const offAir = isIbpOffAir(beacon.call);
    const id = ibpId(beacon.call);
    return Object.freeze({
      id,
      kind: 'ibp',
      call: beacon.call,
      location: beacon.location,
      grid: beacon.grid,
      lat: beacon.lat,
      lon: beacon.lon,
      offAir,
      transmitting: row
        ? Object.freeze({ khz: row.khz, band: row.band, powerStep: row.powerStep, label: ibpTxLabel({ khz: row.khz, call: beacon.call, powerStep: row.powerStep, offAir }) })
        : null,
      nextKhz: next ? next.khz : null,
      nextBand: next ? next.band : null,
      secondsUntilNext: next ? Math.round(next.secondsUntil) : null,
      selected: selectedId === id,
    });
  });
}

/** VHF beacons as UI items (heard state and age evaluated at `nowMs`). */
export function vhfItems(vhf, nowMs = Date.now(), { selectedId = null } = {}) {
  return (Array.isArray(vhf) ? vhf : []).map((beacon) => Object.freeze({
    ...beacon,
    heardRecently: vhfHeardRecently(beacon, nowMs),
    heardAge: beacon.lastHeard?.atIso ? formatAge(beacon.lastHeard.atIso, nowMs) : '',
    selected: selectedId === beacon.id,
  }));
}

/** Slot summary for the panel: per band who is on, the power step and the label. */
export function slotSummary(nowMs = Date.now()) {
  const slot = ibpSlot(nowMs);
  return Object.freeze({
    slot: slot.slot,
    secondsIntoSlot: Math.round(slot.secondsIntoSlot * 10) / 10,
    secondsUntilNextSlot: Math.round(slot.secondsUntilNextSlot * 10) / 10,
    byBand: Object.freeze(slot.byBand.map((row) => Object.freeze({
      khz: row.khz,
      band: row.band,
      color: row.color,
      call: row.call,
      location: row.location,
      offAir: row.offAir,
      powerStep: row.powerStep,
      label: ibpTxLabel({ khz: row.khz, call: row.call, powerStep: row.powerStep, offAir: row.offAir }),
    }))),
  });
}

/**
 * Resolve an item id (`ibp:oh2b`, `vhf:DB0XX:144412000`) or a callsign
 * (case-insensitive) to an IBP row `{ kind:'ibp', ...beacon }` or a VHF row.
 */
export function resolveBeaconQuery(query, { vhf = [] } = {}) {
  const text = cleanText(query, 40);
  if (!text) return null;
  const lower = text.toLowerCase();
  const rows = Array.isArray(vhf) ? vhf : [];
  if (lower.startsWith('ibp:')) {
    const beacon = ibpBeacon(text.slice(4));
    return beacon ? { kind: 'ibp', id: ibpId(beacon.call), ...beacon } : null;
  }
  if (lower.startsWith('vhf:')) {
    return rows.find((row) => row.id.toLowerCase() === lower) || null;
  }
  const call = upperCall(text);
  const ibp = ibpBeacon(call);
  if (ibp) return { kind: 'ibp', id: ibpId(ibp.call), ...ibp };
  const exact = rows.find((row) => row.call === call);
  if (exact) return exact;
  return rows.find((row) => row.call.includes(call)) || null;
}

/**
 * What to tune for `call`/`band`:
 *   • IBP call + band → that beacon on that band, `secondsUntil` its next slot there;
 *   • IBP call, no band → the band it is on now, else the soonest one;
 *   • no call + band → the beacon transmitting on that IBP band right now;
 *   • VHF call → its fixed frequency.
 * Returns null when nothing matches.
 */
export function beaconTuneTarget({ call = null, band = null, nowMs = Date.now(), vhf = [] } = {}) {
  const wantedBand = ibpBandForQuery(band);
  const callText = upperCall(call);
  if (!callText) {
    if (!wantedBand) return null;
    const slot = ibpSlot(nowMs);
    const row = slot.byBand.find((entry) => entry.khz === wantedBand.khz);
    if (!row) return null;
    const beacon = ibpBeacon(row.call);
    return Object.freeze({
      kind: 'ibp',
      id: ibpId(beacon.call),
      call: beacon.call,
      location: beacon.location,
      lat: beacon.lat,
      lon: beacon.lon,
      khz: row.khz,
      band: row.band,
      hz: row.khz * 1000,
      secondsUntil: 0,
      active: !row.offAir,
      offAir: row.offAir,
      powerStep: row.powerStep,
    });
  }
  const ibp = ibpBeacon(callText);
  if (ibp) {
    const schedule = ibpScheduleFor(ibp.call, nowMs);
    let entry = wantedBand ? schedule.find((row) => row.khz === wantedBand.khz) : schedule.find((row) => row.active);
    if (!entry) entry = schedule.reduce((best, row) => (row.secondsUntil < best.secondsUntil ? row : best), schedule[0]);
    if (!entry) return null;
    const offAir = isIbpOffAir(ibp.call);
    return Object.freeze({
      kind: 'ibp',
      id: ibpId(ibp.call),
      call: ibp.call,
      location: ibp.location,
      lat: ibp.lat,
      lon: ibp.lon,
      khz: entry.khz,
      band: entry.band,
      hz: entry.khz * 1000,
      // ibpScheduleFor counts to the NEXT slot start even mid-slot; an active beacon is "now".
      secondsUntil: entry.active ? 0 : Math.round(entry.secondsUntil),
      active: entry.active && !offAir,
      offAir,
      powerStep: entry.active ? ibpSlot(nowMs).byBand.find((row) => row.khz === entry.khz)?.powerStep ?? null : null,
    });
  }
  const rows = Array.isArray(vhf) ? vhf : [];
  const bandText = String(band ?? '').trim().toLowerCase();
  const candidates = rows.filter((row) => row.call === callText && (!bandText || bandText === 'all' || row.band === bandText));
  const beacon = candidates[0] || rows.find((row) => row.call.includes(callText) && (!bandText || bandText === 'all' || row.band === bandText)) || null;
  if (!beacon) return null;
  return Object.freeze({
    kind: 'vhf',
    id: beacon.id,
    call: beacon.call,
    location: beacon.location,
    lat: beacon.lat,
    lon: beacon.lon,
    khz: beacon.freqHz / 1000,
    band: beacon.band,
    hz: beacon.freqHz,
    secondsUntil: 0,
    active: true,
    offAir: false,
    powerStep: null,
    lastHeard: beacon.lastHeard,
  });
}

/**
 * Web receiver for a beacon: the closest ONLINE receiver to `centre` (the view
 * centre) that positively covers `hz`. KiwiSDRs with no published bands are
 * treated as full-HF. `best` is null when nothing covers the frequency.
 */
export function chooseBeaconReceiver({ receivers, hz, centre = null, limit = 5 } = {}) {
  const frequency = finiteOrNull(hz);
  if (frequency === null || frequency <= 0) return { best: null, candidates: [], reason: 'frequency unknown' };
  const rows = [];
  const originals = new Map();
  for (const receiver of Array.isArray(receivers) ? receivers : []) {
    if (!receiver || typeof receiver !== 'object' || receiver.online === false) continue;
    if (finiteOrNull(receiver.lat) === null || finiteOrNull(receiver.lon) === null) continue;
    let row = receiver;
    if (receiver.type === 'kiwisdr' && !(Array.isArray(receiver.bands) && receiver.bands.length)) {
      row = { ...receiver, bands: KIWI_DEFAULT_BANDS };
    }
    originals.set(row, receiver);
    rows.push(row);
  }
  const lat = finiteOrNull(centre?.lat);
  const lon = finiteOrNull(centre?.lon);
  const hasCentre = lat !== null && lon !== null;
  // rankWebReceivers coerces a missing origin to 0/0 — its distances only mean something when we passed a centre.
  const request = { hz: frequency, requireCoverage: true, limit: Math.max(1, Math.min(25, finiteOrNull(limit) ?? 5)) };
  if (hasCentre) Object.assign(request, { lat, lon });
  const ranked = rankWebReceivers(rows, request).filter((entry) => entry.covers === true);
  if (!hasCentre) ranked.sort((a, b) => String(a.receiver.name).localeCompare(String(b.receiver.name)));
  const candidates = ranked.map((entry) => ({
    receiver: originals.get(entry.receiver) || entry.receiver,
    distanceKm: hasCentre && entry.distanceKm !== null ? Math.round(entry.distanceKm) : null,
    covers: entry.covers,
    full: entry.full,
  }));
  if (!candidates.length) return { best: null, candidates, reason: `no online web receiver covers ${formatHz(frequency)}` };
  const best = candidates[0];
  const where = best.distanceKm === null ? '' : ` ${best.distanceKm} km from the view centre`;
  return { best, candidates, reason: `${best.receiver.name}${where}` };
}

/** Distance (km) from a point to an item with lat/lon, rounded, or null. */
export function itemDistanceKm(item, origin) {
  const km = distanceKm(origin, item);
  return Number.isFinite(km) ? Math.round(km) : null;
}

/** Cap a list for the UI snapshot (never mutates). */
export function trimList(list, max = LIST_LIMIT) {
  const rows = Array.isArray(list) ? list : [];
  const limit = Math.max(0, Math.floor(finiteOrNull(max) ?? LIST_LIMIT));
  return rows.length > limit ? rows.slice(0, limit) : rows.slice();
}
