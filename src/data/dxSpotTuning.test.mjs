import assert from 'node:assert/strict';
import test from 'node:test';
import {
  KIWI_DEFAULT_BANDS,
  RECEPTION_MAX_AGE_MIN,
  RECEPTION_MAX_DISTANCE_KM,
  chooseReceiverForSpot,
  receptionEvidenceForSpot,
} from './dxSpotTuning.js';
import { distanceKm } from './hamRadioShared.js';

const NOW = Date.parse('2026-09-12T12:00:00Z');
const HF = Object.freeze([Object.freeze({ lowHz: 0, highHz: 30_000_000, label: '0–30 MHz' })]);
const VHF = Object.freeze([
  Object.freeze({ lowHz: 144e6, highHz: 148e6, label: '2 m' }),
  Object.freeze({ lowHz: 430e6, highHz: 440e6, label: '70 cm' }),
]);

/** Receiver rows in the frozen shape produced by src/data/webReceivers.js freezeWebReceiver(). */
function receiver(id, name, type, lat, lon, extra = {}) {
  return Object.freeze({
    id, type, typeLabel: type, name, site: '', url: `http://${id}.example.org:8073/`, lat, lon,
    bands: HF, users: null, usersMax: null, online: null, antenna: '', sources: Object.freeze(['receiverbook']),
    ...extra,
  });
}

// Geography: DX in Sydney; spotter DL8AAM at JO42 (Göttingen); PSKReporter rx G4XYZ at IO91 (Reading, UK).
const SYDNEY = { lat: -33.87, lon: 151.21 };
const SPOTTER_LOC = { lat: 51.55, lon: 9.95, precision: 'exact', entity: 'Germany', continent: 'EU', adif: 230, cq: 14 };
const RX_UK = { lat: 51.45, lon: -0.95 };

const rxNextToDx = receiver('aaaaaaaaaaaa', 'Kiwi Sydney', 'kiwisdr', -33.9, 151.2, { online: true });
const rxHannover = receiver('bbbbbbbbbbbb', 'Kiwi Hannover', 'kiwisdr', 52.37, 9.73, { online: true }); // ~93 km from spotter
const rxTwente = receiver('cccccccccccc', 'WebSDR Twente', 'websdr', 52.2292, 6.875, { bands: Object.freeze([Object.freeze({ lowHz: 0, highHz: 29_160_000, label: '0–29 MHz' })]) }); // ~215 km
const rxGoettingenVhf = receiver('dddddddddddd', 'OWRX Göttingen 2m/70cm', 'openwebrx', 51.53, 9.93, { bands: VHF }); // 2 km, VHF only
const rxLondon = receiver('eeeeeeeeeeee', 'Kiwi London', 'kiwisdr', 51.5, -0.1, { online: true }); // ~60 km from G4XYZ
const rxBristol = receiver('ffffffffffff', 'WebSDR Bristol', 'websdr', 51.45, -2.58); // ~113 km from G4XYZ
const rxOfflineKassel = receiver('012345678901', 'Kiwi Kassel (offline)', 'kiwisdr', 51.31, 9.49, { online: false }); // 40 km from spotter, offline
const rxUnknownOwrx = receiver('123456789012', 'Mystery OWRX', 'openwebrx', 51.6, 9.9, { bands: Object.freeze([]) }); // 6 km, coverage unknown
const rxKiwiNoBands = receiver('234567890123', 'Kiwi no bands', 'kiwisdr', 51.7, 10.1, { bands: Object.freeze([]), online: true }); // ~20 km

const RECEIVERS = [rxNextToDx, rxHannover, rxTwente, rxGoettingenVhf, rxLondon, rxBristol, rxOfflineKassel, rxUnknownOwrx];

function spot(overrides = {}) {
  return {
    id: 'ws|DL8AAM|VK9XYZ|70740|2026-09-12T11:50',
    dx: 'VK9XYZ',
    spotter: 'DL8AAM',
    spotterCall: 'DL8AAM',
    freqHz: 7_074_000,
    band: '40m',
    mode: 'FT8',
    comment: 'FT8 -12 dB',
    timeIso: '2026-09-12T11:50:00Z',
    dxLoc: { ...SYDNEY, precision: 'exact', entity: 'Australia', continent: 'OC', adif: 150, cq: 30 },
    spotterLoc: SPOTTER_LOC,
    source: 'ws',
    ...overrides,
  };
}

function report(overrides = {}) {
  return {
    rxCall: 'G4XYZ', rxGrid: 'IO91', lat: RX_UK.lat, lon: RX_UK.lon, band: '40m', mode: 'FT8', snr: -5,
    freqHz: 7_074_600, timeIso: new Date(NOW - 12 * 60_000).toISOString(), azimuth: 62,
    ...overrides,
  };
}

function reception(reports, extra = {}) {
  return { psk: { call: 'VK9XYZ', count: reports.length, warmingUp: false, bands: { '40m': reports.length }, reports, ...extra }, wspr: null };
}

test('band-matched reception evidence wins over spotter proximity', () => {
  const result = chooseReceiverForSpot({ spot: spot(), receivers: RECEIVERS, reception: reception([report()]), nowMs: NOW });
  assert.ok(result.best, 'a receiver is chosen');
  assert.equal(result.best.receiver, rxLondon, 'the Kiwi near the reporting station beats the Kiwi near the spotter');
  assert.equal(result.best.evidence, 'reception');
  assert.equal(result.evidence, 'reception');
  assert.equal(result.best.precision, 'grid');
  assert.match(result.best.reason, /^heard by G4XYZ \(IO91\) on 40 m 12 min ago/);
  assert.match(result.best.reason, /SNR -5 dB/);
  assert.equal(result.reason, result.best.reason);
  assert.equal(result.best.anchor.label, 'G4XYZ (IO91)');
  assert.equal(result.best.anchor.lat, RX_UK.lat);
  assert.ok(result.best.distanceKm < 100 && result.best.distanceKm > 50);
  assert.equal(result.best.report.rxCall, 'G4XYZ');
  assert.equal(result.mode, 'usb');
  assert.deepEqual(result.candidates.map((row) => row.receiver.name), ['Kiwi London', 'WebSDR Bristol'], 'only receivers within 500 km of a reporting station');
  assert.ok(result.candidates.every((row) => row.evidence === 'reception'));
});

test('reception candidates rank by report SNR before distance and dedupe per receiver', () => {
  const strongFar = report({ rxCall: 'G3ABC', rxGrid: 'IO81', lat: 51.4, lon: -2.9, snr: +3 }); // Bristol is ~22 km away, London ~200 km
  const weakNear = report({ snr: -15 }); // G4XYZ: London 60 km
  const result = chooseReceiverForSpot({ spot: spot(), receivers: RECEIVERS, reception: reception([weakNear, strongFar]), nowMs: NOW });
  assert.equal(result.best.receiver, rxBristol, 'the +3 dB report anchors the choice');
  assert.match(result.best.reason, /heard by G3ABC \(IO81\)/);
  assert.match(result.best.reason, /SNR \+3 dB/);
  const names = result.candidates.map((row) => row.receiver.name);
  assert.deepEqual(names, ['WebSDR Bristol', 'Kiwi London'], 'each receiver appears once, under its best report');
  assert.equal(result.candidates[1].report.rxCall, 'G3ABC', 'London is also within 500 km of the stronger report');
});

test('off-band reports are ignored and the spotter fallback takes over', () => {
  const result = chooseReceiverForSpot({ spot: spot(), receivers: RECEIVERS, reception: reception([report({ band: '20m' })]), nowMs: NOW });
  assert.equal(result.best.receiver, rxHannover);
  assert.equal(result.best.evidence, 'spotter');
  assert.equal(result.evidence, 'spotter');
  assert.equal(receptionEvidenceForSpot(spot(), reception([report({ band: '20m' })]), NOW).length, 0);
});

test('stale reports (older than 45 min) and reports without a position are ignored', () => {
  const stale = report({ timeIso: new Date(NOW - (RECEPTION_MAX_AGE_MIN + 1) * 60_000).toISOString() });
  const noPosition = report({ lat: null, lon: null });
  const result = chooseReceiverForSpot({ spot: spot(), receivers: RECEIVERS, reception: reception([stale, noPosition]), nowMs: NOW });
  assert.equal(result.best.evidence, 'spotter');
  const fresh = report({ timeIso: new Date(NOW - RECEPTION_MAX_AGE_MIN * 60_000).toISOString() });
  assert.equal(chooseReceiverForSpot({ spot: spot(), receivers: RECEIVERS, reception: reception([fresh]), nowMs: NOW }).best.evidence, 'reception', 'exactly 45 min still counts');
  const undated = report({ timeIso: null });
  assert.equal(chooseReceiverForSpot({ spot: spot(), receivers: RECEIVERS, reception: reception([undated]), nowMs: NOW }).best.evidence, 'reception', 'undated reports from a 30-minute window still count');
  assert.match(chooseReceiverForSpot({ spot: spot(), receivers: RECEIVERS, reception: reception([undated]), nowMs: NOW }).best.reason, /on 40 m recently/);
});

test('SSB, AM and FM spots ignore PSKReporter entirely', () => {
  for (const mode of ['SSB', 'AM', 'FM']) {
    const result = chooseReceiverForSpot({ spot: spot({ mode, freqHz: 7_100_000 }), receivers: RECEIVERS, reception: reception([report()]), nowMs: NOW });
    assert.equal(result.best.evidence, 'spotter', `${mode} spot falls back to the spotter`);
    assert.equal(result.best.receiver, rxHannover);
  }
  assert.equal(chooseReceiverForSpot({ spot: spot({ mode: 'SSB', freqHz: 7_100_000 }), receivers: RECEIVERS, reception: reception([report()]), nowMs: NOW }).mode, 'lsb');
  assert.equal(chooseReceiverForSpot({ spot: spot({ mode: 'CW', freqHz: 7_025_000 }), receivers: RECEIVERS, reception: reception([report({ mode: 'CW' })]), nowMs: NOW }).best.evidence, 'reception', 'CW spots do use evidence');
  assert.equal(chooseReceiverForSpot({ spot: spot({ mode: 'CW', freqHz: 7_025_000 }), receivers: RECEIVERS, reception: reception([report({ mode: 'FT8' })]), nowMs: NOW }).best.evidence, 'reception', 'any digital report corroborates a CW spot');
  assert.equal(chooseReceiverForSpot({ spot: spot({ mode: 'CW', freqHz: 7_025_000 }), receivers: RECEIVERS, reception: reception([report({ mode: 'SSB' })]), nowMs: NOW }).best.evidence, 'spotter', 'an SSB "report" never counts');
});

test('reception for a different callsign than the spot DX is not evidence', () => {
  const result = chooseReceiverForSpot({ spot: spot(), receivers: RECEIVERS, reception: reception([report()], { call: 'DL2SBY' }), nowMs: NOW });
  assert.equal(result.best.evidence, 'spotter');
  const warming = { psk: { call: 'VK9XYZ', count: 0, warmingUp: true, bands: {}, reports: [] }, wspr: null };
  assert.equal(chooseReceiverForSpot({ spot: spot(), receivers: RECEIVERS, reception: warming, nowMs: NOW }).best.evidence, 'spotter', 'warming-up reception has no reports');
  assert.equal(chooseReceiverForSpot({ spot: spot(), receivers: RECEIVERS, reception: null, nowMs: NOW }).best.evidence, 'spotter');
});

test('spotter fallback picks the nearest covering, online receiver', () => {
  const result = chooseReceiverForSpot({ spot: spot(), receivers: RECEIVERS, reception: null, nowMs: NOW });
  assert.equal(result.best.receiver, rxHannover);
  assert.equal(result.best.evidence, 'spotter');
  assert.equal(result.best.precision, 'exact');
  assert.ok(Math.abs(result.best.distanceKm - distanceKm(SPOTTER_LOC, rxHannover)) < 1e-9);
  assert.equal(result.best.anchor.label, 'spotter DL8AAM');
  assert.equal(result.best.anchor.lat, SPOTTER_LOC.lat);
  assert.match(result.best.reason, /Kiwi Hannover is 9\d km from spotter DL8AAM; spotter position is exact/);
  const names = result.candidates.map((row) => row.receiver.name);
  assert.ok(!names.includes('OWRX Göttingen 2m/70cm'), 'a VHF-only receiver 2 km away is not a candidate for a 40 m spot');
  assert.ok(!names.includes('Kiwi Kassel (offline)'), 'offline receivers are never candidates');
  assert.ok(!names.includes('Mystery OWRX'), 'unknown coverage is not coverage');
  assert.deepEqual(names, ['Kiwi Hannover', 'WebSDR Twente', 'Kiwi London', 'WebSDR Bristol', 'Kiwi Sydney'], 'ranked by distance from the spotter');
  assert.equal(chooseReceiverForSpot({ spot: spot(), receivers: RECEIVERS, nowMs: NOW, limit: 2 }).candidates.length, 2);
});

test('KiwiSDRs without published bands are treated as covering 10 kHz–30 MHz', () => {
  assert.equal(KIWI_DEFAULT_BANDS[0].lowHz, 10_000);
  assert.equal(KIWI_DEFAULT_BANDS[0].highHz, 30_000_000);
  const result = chooseReceiverForSpot({ spot: spot(), receivers: [...RECEIVERS, rxKiwiNoBands], reception: null, nowMs: NOW });
  assert.equal(result.best.receiver, rxKiwiNoBands, 'the closer band-less Kiwi is chosen');
  assert.equal(result.best.receiver.bands.length, 0, 'the original (frozen) receiver object is returned, not the augmented copy');
  const vhfSpot = spot({ freqHz: 144_174_000, band: '2m', mode: 'FT8' });
  const vhf = chooseReceiverForSpot({ spot: vhfSpot, receivers: [...RECEIVERS, rxKiwiNoBands], reception: null, nowMs: NOW });
  assert.equal(vhf.best.receiver, rxGoettingenVhf, 'on 2 m only the VHF OpenWebRX covers the frequency');
  assert.ok(!vhf.candidates.some((row) => row.receiver === rxKiwiNoBands), 'the assumed Kiwi coverage stops at 30 MHz');
});

test('area and entity precision of the spotter are stated in the reason', () => {
  const area = chooseReceiverForSpot({
    spot: spot({ spotter: 'W6ABC', spotterCall: 'W6ABC', spotterLoc: { lat: 37.2, lon: -119.5, precision: 'area', entity: 'United States', continent: 'NA', adif: 291, cq: 3 } }),
    receivers: [...RECEIVERS, receiver('345678901234', 'Kiwi Fresno', 'kiwisdr', 36.7, -119.8, { online: true })],
    nowMs: NOW,
  });
  assert.equal(area.best.receiver.name, 'Kiwi Fresno');
  assert.equal(area.best.precision, 'area');
  assert.equal(area.best.anchor.precision, 'area');
  assert.match(area.best.reason, /spotter position is approximate \(US call area 6\)/);
  const entity = chooseReceiverForSpot({
    spot: spot({ spotter: 'VE3XYZ-#', spotterCall: 'VE3XYZ', spotterLoc: { lat: 60, lon: -95, precision: 'entity', entity: 'Canada', continent: 'NA', adif: 1, cq: 4 } }),
    receivers: [...RECEIVERS, receiver('456789012345', 'Kiwi Winnipeg', 'kiwisdr', 49.9, -97.1, { online: true })],
    nowMs: NOW,
  });
  assert.equal(entity.best.receiver.name, 'Kiwi Winnipeg');
  assert.equal(entity.best.precision, 'entity');
  assert.match(entity.best.reason, /spotter position is approximate \(entity centroid of Canada, ±2000 km\)/);
  const grid = chooseReceiverForSpot({ spot: spot({ spotterLoc: { ...SPOTTER_LOC, precision: 'grid' } }), receivers: RECEIVERS, nowMs: NOW });
  assert.match(grid.best.reason, /spotter position from grid locator/);
  assert.equal(grid.best.precision, 'grid');
});

test('missing spotter location and no evidence → best null with reason "spotter location unknown"', () => {
  const result = chooseReceiverForSpot({ spot: spot({ spotterLoc: null }), receivers: RECEIVERS, reception: null, nowMs: NOW });
  assert.deepEqual(result, { best: null, candidates: [], mode: 'usb', reason: 'spotter location unknown', evidence: null });
  const partial = chooseReceiverForSpot({ spot: spot({ spotterLoc: { lat: null, lon: null, precision: 'entity', entity: null } }), receivers: RECEIVERS, nowMs: NOW });
  assert.equal(partial.best, null);
  assert.equal(partial.reason, 'spotter location unknown');
  const noRx = chooseReceiverForSpot({ spot: spot(), receivers: [rxGoettingenVhf, rxOfflineKassel], nowMs: NOW });
  assert.equal(noRx.best, null);
  assert.match(noRx.reason, /no online receiver covering 40 m near spotter DL8AAM/);
  assert.equal(chooseReceiverForSpot({ spot: spot({ freqHz: null }), receivers: RECEIVERS, nowMs: NOW }).reason, 'spot has no frequency');
  assert.equal(chooseReceiverForSpot({}).best, null);
  assert.equal(chooseReceiverForSpot().best, null);
});

test('the DX location is never used, even when a receiver sits right next to the DX', () => {
  // No spotter location, no evidence, a perfect HF receiver next to the DX: still nothing.
  const nothing = chooseReceiverForSpot({ spot: spot({ spotterLoc: null }), receivers: [rxNextToDx], reception: null, nowMs: NOW });
  assert.equal(nothing.best, null);
  assert.equal(nothing.reason, 'spotter location unknown');
  // With a spotter in Germany the Sydney receiver ranks last even though it is on top of the DX.
  const withSpotter = chooseReceiverForSpot({ spot: spot(), receivers: [rxNextToDx, rxHannover], reception: null, nowMs: NOW });
  assert.equal(withSpotter.best.receiver, rxHannover);
  assert.ok(withSpotter.best.distanceKm < 100);
  assert.ok(withSpotter.candidates[1].distanceKm > 15_000, 'Sydney is measured from the spotter, not the DX');
  // Reception from the UK never anchors on the DX either: Sydney is > 500 km from every reporting station.
  const withEvidence = chooseReceiverForSpot({ spot: spot({ spotterLoc: null }), receivers: [rxNextToDx, rxLondon], reception: reception([report()]), nowMs: NOW });
  assert.equal(withEvidence.best.receiver, rxLondon);
  assert.equal(withEvidence.candidates.length, 1);
  // Evidence exists but no receiver near it, and no spotter: the reason says both.
  const evidenceOnly = chooseReceiverForSpot({ spot: spot({ spotterLoc: null }), receivers: [rxNextToDx], reception: reception([report()]), nowMs: NOW });
  assert.equal(evidenceOnly.best, null);
  assert.match(evidenceOnly.reason, /spotter location unknown/);
});

test('a 60 m spot gets receiver mode usb; other modes follow receiverModeForSpot', () => {
  const sixty = chooseReceiverForSpot({ spot: spot({ freqHz: 5_357_000, band: '60m', mode: 'FT8' }), receivers: RECEIVERS, nowMs: NOW });
  assert.equal(sixty.mode, 'usb');
  const sixtySsb = chooseReceiverForSpot({ spot: spot({ freqHz: 5_360_000, band: '60m', mode: 'SSB' }), receivers: RECEIVERS, nowMs: NOW });
  assert.equal(sixtySsb.mode, 'usb', '60 m SSB is USB even though it is below 10 MHz');
  assert.equal(chooseReceiverForSpot({ spot: spot({ freqHz: 7_025_000, mode: 'CW' }), receivers: RECEIVERS, nowMs: NOW }).mode, 'cw');
  assert.equal(chooseReceiverForSpot({ spot: spot({ freqHz: 14_200_000, band: '20m', mode: 'SSB' }), receivers: RECEIVERS, nowMs: NOW }).mode, 'usb');
  assert.equal(chooseReceiverForSpot({ spot: spot({ freqHz: 145_500_000, band: '2m', mode: 'FM' }), receivers: RECEIVERS, nowMs: NOW }).mode, 'nfm');
  assert.equal(chooseReceiverForSpot({ spot: spot({ spotterLoc: null, freqHz: 5_357_000, band: '60m', mode: 'FT8' }), receivers: RECEIVERS, nowMs: NOW }).mode, 'usb', 'mode is reported even when no receiver is chosen');
});

test('band is derived from the frequency when the spot carries none', () => {
  const result = chooseReceiverForSpot({ spot: spot({ band: null }), receivers: RECEIVERS, reception: reception([report()]), nowMs: NOW });
  assert.equal(result.best.evidence, 'reception', '7.074 MHz is 40 m, matching the report band');
  const offBand = chooseReceiverForSpot({ spot: spot({ band: null, freqHz: 14_074_000 }), receivers: RECEIVERS, reception: reception([report()]), nowMs: NOW });
  assert.equal(offBand.best.evidence, 'spotter');
});

test('reception evidence respects the 500 km receiver radius', () => {
  assert.equal(RECEPTION_MAX_DISTANCE_KM, 500);
  const farReport = report({ rxCall: 'ZS1ABC', rxGrid: 'JF96', lat: -33.9, lon: 18.4 }); // Cape Town: no receiver within 500 km
  const result = chooseReceiverForSpot({ spot: spot(), receivers: RECEIVERS, reception: reception([farReport]), nowMs: NOW });
  assert.equal(result.best.evidence, 'spotter', 'evidence without a nearby receiver falls back to the spotter');
});
