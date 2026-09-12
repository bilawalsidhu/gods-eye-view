import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BEACON_BAND_FILTERS,
  BEACON_KIND_FILTERS,
  IBP_COLOR,
  IBP_OFF_AIR_COLOR,
  KIWI_DEFAULT_BANDS,
  TUNE_MODE,
  VHF_COLOR,
  VHF_HEARD_WINDOW_MS,
  beaconMatchesFilter,
  beaconTuneTarget,
  chooseBeaconReceiver,
  formatIbpKhz,
  freezeVhfBeacon,
  ibpBandForQuery,
  ibpId,
  ibpItems,
  ibpMarkerStyle,
  ibpTxLabel,
  isValidVhfBeacon,
  normalizeBeaconFilter,
  parseVhfResponse,
  powerStepLabel,
  pulseRingPixels,
  resolveBeaconQuery,
  slotSummary,
  transmittingByCall,
  trimList,
  vhfHeardRecently,
  vhfId,
  vhfItems,
  vhfMarkerStyle,
} from './hamBeaconsLogic.js';
import { ibpSlot, setIbpOffAir } from './ncdxfBeacons.js';

const CYCLE_START = Date.parse('2026-09-12T12:03:00.000Z'); // minute % 3 === 0 → slot 0
const NOW = Date.parse('2026-09-12T15:00:00.000Z');

const VHF_ROWS = [
  { call: 'DB0FAI', freq_khz: 144_412, freqHz: 144_412_000, band: '2m', locator: 'JN58RD', lat: 48.15, lon: 11.45, location: 'Munich', lastHeard: { atIso: '2026-09-12T14:10:00.000Z', spotter: 'DL1ABC', snr: 12 } },
  { call: 'DB0FAI', freqHz: 432_412_000, band: '70cm', locator: 'JN58RD', lat: 48.15, lon: 11.45, location: 'Munich', lastHeard: { atIso: '2026-09-12T02:00:00.000Z', spotter: 'DL2XYZ', snr: -3 } },
  { call: 'OZ7IGY', freqHz: 50_470_000, band: '6m', locator: 'JO55WM', lat: 55.52, lon: 11.86, location: 'Jystrup', lastHeard: null },
  { call: 'BAD', freqHz: 144_000_000, lat: 0, lon: 0 },
  { call: 'NOFREQ', lat: 50, lon: 8 },
  { call: 'HF', freqHz: 14_100_000, lat: 50, lon: 8 },
  null,
];

function vhfFixture() {
  return parseVhfResponse({ status: 200, body: { beacons: VHF_ROWS, generatedAt: '2026-09-12T14:59:00.000Z' } }).beacons;
}

const kiwi = { id: 'aaaaaaaaaaaa', type: 'kiwisdr', name: 'Kiwi Arvika', url: 'http://kiwi.example/', lat: 59.546, lon: 12.526, bands: [], users: 1, usersMax: 8, online: true };
const websdr = { id: 'bbbbbbbbbbbb', type: 'websdr', name: 'WebSDR Twente', url: 'http://twente.example/', lat: 52.2292, lon: 6.875, bands: [{ lowHz: 0, highHz: 29_160_000, label: '0–29 MHz' }], users: null, usersMax: null, online: null };
const owrx = { id: 'cccccccccccc', type: 'openwebrx', name: 'OWRX Munich 2m/70cm', url: 'http://owrx.example/', lat: 48.14, lon: 11.58, bands: [{ lowHz: 144e6, highHz: 148e6, label: '2 m' }, { lowHz: 430e6, highHz: 440e6, label: '70 cm' }], users: null, usersMax: null, online: null };
const offline = { id: 'dddddddddddd', type: 'kiwisdr', name: 'Kiwi Munich (down)', url: 'http://down.example/', lat: 48.13, lon: 11.57, bands: [], users: 0, usersMax: 4, online: false };

test('constants and filters are frozen and carry the contract colours', () => {
  assert.equal(IBP_COLOR, '#fbbf24');
  assert.equal(IBP_OFF_AIR_COLOR, '#6b7280');
  assert.equal(VHF_COLOR, '#22c55e');
  assert.equal(VHF_HEARD_WINDOW_MS, 2 * 60 * 60 * 1000);
  assert.equal(TUNE_MODE, 'cw');
  assert.ok(Object.isFrozen(BEACON_KIND_FILTERS));
  assert.deepEqual(BEACON_KIND_FILTERS.map((row) => row.id), ['all', 'ibp', 'vhf']);
  assert.ok(Object.isFrozen(BEACON_BAND_FILTERS));
  assert.deepEqual(BEACON_BAND_FILTERS.slice(0, 6).map((row) => row.id), ['all', '20m', '17m', '15m', '12m', '10m']);
  assert.equal(BEACON_BAND_FILTERS[1].label, '20 m · 14.100');
  assert.ok(Object.isFrozen(KIWI_DEFAULT_BANDS));
});

test('ids and labels follow the contract formats', () => {
  assert.equal(ibpId('oh2b'), 'ibp:OH2B');
  assert.equal(vhfId({ call: 'db0fai', freqHz: 144_412_000 }), 'vhf:DB0FAI:144412000');
  assert.equal(formatIbpKhz(14100), '14.100');
  assert.equal(formatIbpKhz(28200), '28.200');
  assert.equal(formatIbpKhz('nope'), '');
  assert.equal(powerStepLabel('call'), 'ID');
  assert.equal(powerStepLabel('100mW'), '100mW');
  assert.equal(ibpTxLabel({ khz: 14100, call: 'OH2B', powerStep: '10W' }), '14.100 ▶ OH2B · 10W');
  assert.equal(ibpTxLabel({ khz: 18110, call: 'oh2b', powerStep: 'call' }), '18.110 ▶ OH2B · ID');
  assert.equal(ibpTxLabel({ khz: 18110, call: 'YV5B', powerStep: '1W', offAir: true }), '18.110 ▶ YV5B · off air');
});

test('transmittingByCall pins the slot-0 and slot-1 assignments', () => {
  const slot0 = transmittingByCall(ibpSlot(CYCLE_START));
  assert.equal(slot0.size, 5);
  assert.equal(slot0.get('4U1UN').khz, 14100);
  assert.equal(slot0.get('YV5B').khz, 18110);
  assert.equal(slot0.get('OA4B').khz, 21150);
  assert.equal(slot0.get('LU4AA').khz, 24930);
  assert.equal(slot0.get('CS3B').khz, 28200);
  assert.equal(slot0.has('OH2B'), false);
  const slot1 = transmittingByCall(ibpSlot(CYCLE_START + 10_000));
  assert.equal(slot1.get('VE8AT').khz, 14100);
  assert.equal(slot1.get('4U1UN').khz, 18110);
  assert.equal(slot1.get('YV5B').khz, 21150);
  assert.equal(transmittingByCall(null).size, 0);
});

test('ibpItems reports 18 beacons with transmit state and time to the next slot', () => {
  const items = ibpItems(CYCLE_START, { selectedId: 'ibp:OH2B' });
  assert.equal(items.length, 18);
  assert.ok(items.every((item) => Object.isFrozen(item) && item.kind === 'ibp'));
  const un = items.find((item) => item.call === '4U1UN');
  assert.deepEqual(un.transmitting, { khz: 14100, band: '20m', powerStep: 'call', label: '14.100 ▶ 4U1UN · ID' });
  assert.equal(un.secondsUntilNext, 0);
  assert.equal(un.selected, false);
  const oh2b = items.find((item) => item.call === 'OH2B');
  assert.equal(oh2b.transmitting, null);
  assert.equal(oh2b.nextKhz, 14100);
  assert.equal(oh2b.secondsUntilNext, 130);
  assert.equal(oh2b.selected, true);
  assert.equal(oh2b.id, 'ibp:OH2B');
  const yv5b = items.find((item) => item.call === 'YV5B');
  assert.equal(yv5b.offAir, true);
  assert.equal(yv5b.transmitting.label, '18.110 ▶ YV5B · off air');
  // 6.5 s into slot 0 → the 100 W dash.
  const dash = ibpItems(CYCLE_START + 6_500).find((item) => item.call === '4U1UN');
  assert.equal(dash.transmitting.powerStep, '100W');
  assert.equal(dash.transmitting.label, '14.100 ▶ 4U1UN · 100W');
});

test('slotSummary carries a label per band', () => {
  const summary = slotSummary(CYCLE_START + 8_200);
  assert.equal(summary.slot, 0);
  assert.equal(summary.secondsIntoSlot, 8.2);
  assert.equal(summary.secondsUntilNextSlot, 1.8);
  assert.equal(summary.byBand.length, 5);
  assert.equal(summary.byBand[0].label, '14.100 ▶ 4U1UN · 1W');
  assert.equal(summary.byBand[1].label, '18.110 ▶ YV5B · off air');
  assert.ok(Object.isFrozen(summary) && Object.isFrozen(summary.byBand));
});

test('marker styles: amber, grey off-air, larger when transmitting, dimmed when filtered out', () => {
  assert.deepEqual(ibpMarkerStyle({}), { color: IBP_COLOR, alpha: 0.85, pixelSize: 10 });
  assert.deepEqual(ibpMarkerStyle({ transmitting: true }), { color: IBP_COLOR, alpha: 1, pixelSize: 13 });
  assert.deepEqual(ibpMarkerStyle({ offAir: true, transmitting: true }), { color: IBP_OFF_AIR_COLOR, alpha: 0.55, pixelSize: 10 });
  assert.equal(ibpMarkerStyle({ transmitting: true, selected: true }).pixelSize, 15);
  assert.equal(ibpMarkerStyle({ dimmed: true }).alpha, 0.4);
});

test('pulseRingPixels breathes between min and max once per period', () => {
  assert.equal(pulseRingPixels(0), 16);
  assert.ok(Math.abs(pulseRingPixels(500) - 28) < 1e-9);
  assert.equal(Math.round(pulseRingPixels(1000)), 16);
  const custom = pulseRingPixels(250, { periodMs: 1000, minPx: 10, maxPx: 20 });
  assert.ok(Math.abs(custom - 15) < 1e-9);
  assert.equal(pulseRingPixels(NaN), 16);
  for (let t = 0; t < 2000; t += 37) {
    const px = pulseRingPixels(t);
    assert.ok(px >= 16 - 1e-9 && px <= 28 + 1e-9);
  }
});

test('VHF rows are validated, frozen and styled by how recently they were heard', () => {
  const rows = vhfFixture();
  assert.equal(rows.length, 3);
  assert.ok(Object.isFrozen(rows));
  assert.ok(rows.every((row) => Object.isFrozen(row) && row.kind === 'vhf'));
  const fai2m = rows[0];
  assert.equal(fai2m.id, 'vhf:DB0FAI:144412000');
  assert.equal(fai2m.band, '2m');
  assert.equal(fai2m.frequencyLabel, '144.412 MHz');
  assert.deepEqual(fai2m.lastHeard, { atIso: '2026-09-12T14:10:00.000Z', spotter: 'DL1ABC', snr: 12 });
  assert.equal(vhfHeardRecently(fai2m, NOW), true);
  assert.equal(vhfHeardRecently(rows[1], NOW), false);
  assert.equal(vhfHeardRecently(rows[2], NOW), false);
  assert.deepEqual(vhfMarkerStyle(fai2m, NOW), { color: VHF_COLOR, alpha: 1, pixelSize: 11, heardRecently: true });
  assert.deepEqual(vhfMarkerStyle(rows[2], NOW), { color: VHF_COLOR, alpha: 0.55, pixelSize: 8, heardRecently: false });
  assert.equal(vhfMarkerStyle(fai2m, NOW, { selected: true }).pixelSize, 13);
  assert.equal(vhfMarkerStyle(fai2m, NOW, { dimmed: true }).alpha, 0.35);
  assert.equal(isValidVhfBeacon(VHF_ROWS[3]), false); // 0/0
  assert.equal(isValidVhfBeacon(VHF_ROWS[4]), false); // no frequency
  assert.equal(isValidVhfBeacon(VHF_ROWS[5]), false); // HF is not a VHF beacon
  assert.equal(isValidVhfBeacon(null), false);
  const items = vhfItems(rows, NOW, { selectedId: rows[2].id });
  assert.equal(items[0].heardRecently, true);
  assert.equal(items[0].heardAge, '50 min');
  assert.equal(items[2].selected, true);
  assert.equal(items[2].heardAge, '');
  // band falls back to the frequency table when the proxy omits it
  assert.equal(freezeVhfBeacon({ call: 'X1Y', freqHz: 1_296_900_000, lat: 1, lon: 1 }).band, '23cm');
});

test('parseVhfResponse tolerates 403 as "not configured" and reports other failures', () => {
  const forbidden = parseVhfResponse({ status: 403, body: { error: 'HamRig login not configured', beacons: [] } });
  assert.deepEqual(forbidden, { beacons: [], forbidden: true, error: null, updatedAt: null });
  assert.ok(Object.isFrozen(forbidden.beacons));
  const bad = parseVhfResponse({ status: 502, body: { error: 'upstream down' } });
  assert.equal(bad.forbidden, false);
  assert.equal(bad.error, 'upstream down');
  assert.equal(bad.beacons.length, 0);
  assert.equal(parseVhfResponse({ status: 500, body: null }).error, 'VHF beacon feed returned 500');
  assert.equal(parseVhfResponse({}).error, 'VHF beacon feed returned no status');
  const ok = parseVhfResponse({ status: 200, body: { beacons: VHF_ROWS, generatedAt: '2026-09-12T14:59:00.000Z' } });
  assert.equal(ok.error, null);
  assert.equal(ok.forbidden, false);
  assert.equal(ok.updatedAt, '2026-09-12T14:59:00.000Z');
  assert.equal(ok.beacons.length, 3);
  // duplicates collapse on id
  assert.equal(parseVhfResponse({ status: 200, body: { beacons: [VHF_ROWS[0], VHF_ROWS[0]] } }).beacons.length, 1);
});

test('filters validate input and IBP beacons match every IBP band', () => {
  assert.deepEqual(normalizeBeaconFilter({ kind: 'VHF', band: '2M' }, { kind: 'all', band: 'all' }), { kind: 'vhf', band: '2m' });
  assert.deepEqual(normalizeBeaconFilter({ kind: 'nonsense', band: '160m' }, { kind: 'ibp', band: '20m' }), { kind: 'ibp', band: '20m' });
  assert.ok(Object.isFrozen(normalizeBeaconFilter()));
  const ibp = ibpItems(CYCLE_START)[0];
  const vhf = vhfFixture()[0];
  assert.equal(beaconMatchesFilter(ibp, { kind: 'all', band: 'all' }), true);
  assert.equal(beaconMatchesFilter(ibp, { kind: 'ibp', band: '15m' }), true);
  assert.equal(beaconMatchesFilter(ibp, { kind: 'ibp', band: '2m' }), false);
  assert.equal(beaconMatchesFilter(ibp, { kind: 'vhf', band: 'all' }), false);
  assert.equal(beaconMatchesFilter(vhf, { kind: 'vhf', band: '2m' }), true);
  assert.equal(beaconMatchesFilter(vhf, { kind: 'all', band: '70cm' }), false);
  assert.equal(beaconMatchesFilter(null, {}), false);
});

test('ibpBandForQuery accepts band names, kHz, MHz and Hz', () => {
  assert.equal(ibpBandForQuery('20m').khz, 14100);
  assert.equal(ibpBandForQuery('20').khz, 14100);
  assert.equal(ibpBandForQuery(14100).khz, 14100);
  assert.equal(ibpBandForQuery('14.100').khz, 14100);
  assert.equal(ibpBandForQuery('14.1 MHz').khz, 14100);
  assert.equal(ibpBandForQuery(28_200_000).khz, 28200);
  assert.equal(ibpBandForQuery('15').khz, 21150);
  assert.equal(ibpBandForQuery('70cm'), null);
  assert.equal(ibpBandForQuery(''), null);
  assert.equal(ibpBandForQuery(null), null);
});

test('resolveBeaconQuery accepts ids and callsigns for both families', () => {
  const vhf = vhfFixture();
  assert.equal(resolveBeaconQuery('oh2b').id, 'ibp:OH2B');
  assert.equal(resolveBeaconQuery('ibp:cs3b').call, 'CS3B');
  assert.equal(resolveBeaconQuery('ibp:nope'), null);
  assert.equal(resolveBeaconQuery('vhf:db0fai:432412000', { vhf }).band, '70cm');
  assert.equal(resolveBeaconQuery('db0fai', { vhf }).id, 'vhf:DB0FAI:144412000');
  assert.equal(resolveBeaconQuery('OZ7IG', { vhf }).call, 'OZ7IGY');
  assert.equal(resolveBeaconQuery('nothing', { vhf }), null);
  assert.equal(resolveBeaconQuery(''), null);
});

test('beaconTuneTarget picks the beacon, band and seconds-until for every request shape', () => {
  const vhf = vhfFixture();
  const explicit = beaconTuneTarget({ call: 'OH2B', band: '20m', nowMs: CYCLE_START });
  assert.equal(explicit.kind, 'ibp');
  assert.equal(explicit.hz, 14_100_000);
  assert.equal(explicit.khz, 14100);
  assert.equal(explicit.band, '20m');
  assert.equal(explicit.secondsUntil, 130);
  assert.equal(explicit.active, false);
  assert.equal(explicit.offAir, false);
  assert.ok(Object.isFrozen(explicit));

  const active = beaconTuneTarget({ call: '4u1un', nowMs: CYCLE_START + 7_500 });
  assert.equal(active.khz, 14100);
  assert.equal(active.active, true);
  assert.equal(active.secondsUntil, 0);
  assert.equal(active.powerStep, '10W');

  const soonest = beaconTuneTarget({ call: 'OH2B', nowMs: CYCLE_START });
  assert.equal(soonest.khz, 14100);
  assert.equal(soonest.secondsUntil, 130);

  const onBand = beaconTuneTarget({ band: '15m', nowMs: CYCLE_START + 10_000 });
  assert.equal(onBand.call, 'YV5B');
  assert.equal(onBand.offAir, true);
  assert.equal(onBand.active, false);
  const onBand20 = beaconTuneTarget({ band: 14100, nowMs: CYCLE_START + 10_000 });
  assert.equal(onBand20.call, 'VE8AT');
  assert.equal(onBand20.active, true);

  const vhfTarget = beaconTuneTarget({ call: 'DB0FAI', band: '70cm', nowMs: NOW, vhf });
  assert.equal(vhfTarget.kind, 'vhf');
  assert.equal(vhfTarget.hz, 432_412_000);
  assert.equal(vhfTarget.active, true);
  assert.equal(beaconTuneTarget({ call: 'DB0FAI', nowMs: NOW, vhf }).hz, 144_412_000);

  assert.equal(beaconTuneTarget({ nowMs: NOW }), null);
  assert.equal(beaconTuneTarget({ band: '2m', nowMs: NOW }), null);
  assert.equal(beaconTuneTarget({ call: 'ZZ9ZZZ', nowMs: NOW, vhf }), null);
});

test('beaconTuneTarget honours a changed off-air list', () => {
  setIbpOffAir(['YV5B', 'OH2B']);
  try {
    assert.equal(beaconTuneTarget({ call: 'OH2B', band: '20m', nowMs: CYCLE_START + 130_000 }).active, false);
    assert.equal(ibpItems(CYCLE_START).find((item) => item.call === 'OH2B').offAir, true);
  } finally {
    setIbpOffAir(['YV5B']);
  }
  assert.equal(beaconTuneTarget({ call: 'OH2B', band: '20m', nowMs: CYCLE_START + 130_000 }).active, true);
});

test('chooseBeaconReceiver takes the nearest covering online receiver to the view centre', () => {
  const receivers = [kiwi, websdr, owrx, offline];
  const munich = { lat: 48.14, lon: 11.58 };
  const hf = chooseBeaconReceiver({ receivers, hz: 14_100_000, centre: munich });
  assert.equal(hf.best.receiver.id, websdr.id); // Twente is nearer to Munich than Arvika; the offline Kiwi is skipped
  assert.equal(hf.best.covers, true);
  assert.ok(hf.best.distanceKm > 400 && hf.best.distanceKm < 600);
  assert.deepEqual(hf.candidates.map((row) => row.receiver.id), [websdr.id, kiwi.id]);
  assert.ok(hf.reason.includes('WebSDR Twente'));
  assert.ok(hf.reason.includes('km from the view centre'));
  // the Kiwi with no published bands still counts as HF, and comes back as the ORIGINAL object
  assert.equal(hf.candidates[1].receiver, kiwi);

  const vhf = chooseBeaconReceiver({ receivers, hz: 144_412_000, centre: { lat: 59.5, lon: 12.5 } });
  assert.equal(vhf.best.receiver.id, owrx.id);
  assert.equal(vhf.candidates.length, 1);

  const none = chooseBeaconReceiver({ receivers, hz: 1_296_900_000, centre: munich });
  assert.equal(none.best, null);
  assert.equal(none.reason, 'no online web receiver covers 1296.900 MHz');

  const noCentre = chooseBeaconReceiver({ receivers, hz: 14_100_000 });
  assert.equal(noCentre.best.distanceKm, null);
  assert.equal(noCentre.candidates.length, 2);

  assert.equal(chooseBeaconReceiver({ receivers, hz: 0 }).best, null);
  assert.equal(chooseBeaconReceiver({ receivers: null, hz: 14_100_000 }).best, null);
});

test('trimList caps without mutating', () => {
  const list = Array.from({ length: 250 }, (_, index) => index);
  const trimmed = trimList(list);
  assert.equal(trimmed.length, 200);
  assert.equal(list.length, 250);
  assert.notEqual(trimList(list, 300), list);
  assert.deepEqual(trimList(null), []);
  assert.deepEqual(trimList([1, 2, 3], 2), [1, 2]);
});
