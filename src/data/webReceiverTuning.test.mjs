import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BAND_FILTERS,
  buildSpectrumUrl,
  buildTuneUrl,
  defaultModeForHz,
  formatFrequencyRange,
  receiverCoversRangeHz,
  describeReceiverBands,
  formatFrequencyHz,
  normalizeReceiverMode,
  parseBandsFromText,
  parseFrequencyHz,
  rankWebReceivers,
  receiverCoversHz,
  receiverMatchesFilter,
} from './webReceiverTuning.js';

const kiwi = {
  id: 'aaaaaaaaaaaa', type: 'kiwisdr', name: 'Kiwi Arvika', url: 'http://sa4bna.hopto.org:8073/',
  lat: 59.546, lon: 12.526, bands: [{ lowHz: 0, highHz: 30_000_000, label: '0–30 MHz' }], users: 3, usersMax: 8, online: true,
};
const websdr = {
  id: 'bbbbbbbbbbbb', type: 'websdr', name: 'WebSDR Twente', url: 'http://websdr.ewi.utwente.nl:8901',
  lat: 52.2292, lon: 6.875, bands: [{ lowHz: 0, highHz: 29_160_000, label: '0–29 MHz' }], users: null, usersMax: null, online: null,
};
const owrx = {
  id: 'cccccccccccc', type: 'openwebrx', name: 'OWRX Berlin 2m/70cm', url: 'http://thomas0177.ddns.net:8073/',
  lat: 52.41876, lon: 13.30633, bands: [{ lowHz: 144e6, highHz: 148e6, label: '2 m' }, { lowHz: 430e6, highHz: 440e6, label: '70 cm' }],
  users: null, usersMax: null, online: null,
};
const unknown = { id: 'dddddddddddd', type: 'openwebrx', name: 'Mystery SDR', url: 'https://sdr.example.org/', lat: 52.5, lon: 13.4, bands: [], users: null, usersMax: null, online: null };

test('parseFrequencyHz reads radio shorthand and explicit units', () => {
  assert.equal(parseFrequencyHz('14233'), 14_233_000);
  assert.equal(parseFrequencyHz(14233), 14_233_000);
  assert.equal(parseFrequencyHz('14.233 MHz'), 14_233_000);
  assert.equal(parseFrequencyHz('14.233'), 14_233_000);
  assert.equal(parseFrequencyHz('7,055 kHz'), 7_055_000);
  assert.equal(parseFrequencyHz('145.500'), 145_500_000);
  assert.equal(parseFrequencyHz('198'), 198_000);
  assert.equal(parseFrequencyHz('14233000'), 14_233_000);
  assert.equal(parseFrequencyHz(7055.5, 'khz'), 7_055_500);
  assert.equal(parseFrequencyHz('abc'), null);
  assert.equal(parseFrequencyHz(''), null);
  assert.equal(parseFrequencyHz(-5), null);
});

test('formatFrequencyHz switches units at 30 MHz', () => {
  assert.equal(formatFrequencyHz(14_233_000), '14,233 kHz');
  assert.equal(formatFrequencyHz(7_055_500), '7,055.5 kHz');
  assert.equal(formatFrequencyHz(145_500_000), '145.500 MHz');
});

test('modes normalize onto the canonical set and default by band', () => {
  assert.equal(normalizeReceiverMode('USB'), 'usb');
  assert.equal(normalizeReceiverMode('fm'), 'nfm');
  assert.equal(normalizeReceiverMode('wide fm'), 'wfm');
  assert.equal(normalizeReceiverMode('nbfm'), 'nfm');
  assert.equal(normalizeReceiverMode('unknown'), null);
  assert.equal(defaultModeForHz(14_233_000), 'usb');
  assert.equal(defaultModeForHz(7_055_000), 'lsb');
  assert.equal(defaultModeForHz(9_400_000), 'am');
  assert.equal(defaultModeForHz(100_000_000), 'wfm');
  assert.equal(defaultModeForHz(145_500_000), 'nfm');
});

test('parseBandsFromText finds ranges and named bands in receiver labels', () => {
  const bands = parseBandsFromText('OpenWebRxPlus 0-32 MHz/ 2m/ 70cm/ PMR/DAB+/ FM Broadcast');
  const labels = bands.map((band) => band.label);
  assert.ok(bands.some((band) => band.lowHz === 0 && band.highHz === 32_000_000), 'explicit range');
  assert.ok(labels.includes('2 m'));
  assert.ok(labels.includes('70 cm'));
  assert.ok(labels.includes('PMR446'));
  assert.ok(labels.includes('DAB'));
  assert.ok(labels.includes('FM broadcast'));
  assert.deepEqual(parseBandsFromText('SDRPT3 - WebSDR Airband').map((band) => band.label), ['Airband']);
  assert.deepEqual(parseBandsFromText('1.8–30MHz Kurzwelle').map((band) => band.lowHz), [1_800_000, 1_600_000]);
  assert.deepEqual(parseBandsFromText('Plain label without bands'), []);
  // "20m" must not match inside "120m" or "20mhz"
  assert.deepEqual(parseBandsFromText('cable 120m long'), []);
});

test('coverage answers true, false, or null when unpublished', () => {
  assert.equal(receiverCoversHz(kiwi, 14_233_000), true);
  assert.equal(receiverCoversHz(owrx, 14_233_000), false);
  assert.equal(receiverCoversHz(owrx, 145_500_000), true);
  assert.equal(receiverCoversHz(unknown, 14_233_000), null);
  assert.equal(describeReceiverBands(owrx), '2 m · 70 cm');
  assert.equal(describeReceiverBands(unknown), 'coverage not published');
});

test('buildTuneUrl speaks each receiver family dialect', () => {
  assert.equal(buildTuneUrl(kiwi, { hz: 14_233_000, mode: 'usb' }), 'http://sa4bna.hopto.org:8073/?f=14233usbz10');
  assert.equal(buildTuneUrl(kiwi, { hz: 9_400_000, mode: 'am' }), 'http://sa4bna.hopto.org:8073/?f=9400amz8');
  assert.equal(buildTuneUrl(kiwi, { hz: 7_055_500, mode: 'fm' }), 'http://sa4bna.hopto.org:8073/?f=7055.5nbfmz10');
  assert.equal(buildTuneUrl(websdr, { hz: 198_000, mode: 'am' }), 'http://websdr.ewi.utwente.nl:8901/?tune=198am');
  assert.equal(buildTuneUrl(websdr, { hz: 7_055_000 }), 'http://websdr.ewi.utwente.nl:8901/?tune=7055lsb');
  assert.equal(buildTuneUrl(owrx, { hz: 145_500_000, mode: 'nfm' }), 'http://thomas0177.ddns.net:8073/#freq=145500000,mod=nfm');
  assert.equal(buildTuneUrl(owrx, { hz: 100_000_000 }), 'http://thomas0177.ddns.net:8073/#freq=100000000,mod=wfm');
  assert.equal(buildTuneUrl({ ...kiwi, url: 'ftp://x.example/' }, { hz: 1_000_000 }), null);
  assert.equal(buildTuneUrl(kiwi, { hz: 0 }), null);
});

test('filters honour receiver family and band families', () => {
  assert.equal(receiverMatchesFilter(kiwi, { type: 'kiwisdr', band: 'hf' }), true);
  assert.equal(receiverMatchesFilter(kiwi, { type: 'websdr' }), false);
  assert.equal(receiverMatchesFilter(owrx, { band: 'hf' }), false);
  assert.equal(receiverMatchesFilter(owrx, { band: 'vhf' }), true);
  assert.equal(receiverMatchesFilter(unknown, { band: 'hf' }), false, 'unpublished coverage never passes a band filter');
  assert.equal(receiverMatchesFilter(unknown, { band: 'all' }), true);
  assert.deepEqual(BAND_FILTERS.map((entry) => entry.id), ['all', 'lf-mw', 'hf', 'vhf', 'uhf']);
});

test('rankWebReceivers orders by online, coverage, free slots, then distance', () => {
  const full = { ...kiwi, id: 'eeeeeeeeeeee', name: 'Full Kiwi', users: 8, usersMax: 8, lat: 52.5, lon: 13.5 };
  const offline = { ...kiwi, id: 'ffffffffffff', name: 'Offline Kiwi', online: false, lat: 52.5, lon: 13.5 };
  const rows = rankWebReceivers([owrx, unknown, full, offline, kiwi, websdr], { lat: 52.52, lon: 13.4, hz: 14_233_000 });
  const names = rows.map((row) => row.receiver.name);
  // Covering + free slots first (nearest of those first), then coverage-unknown, then non-covering, offline last.
  assert.equal(names[0], 'WebSDR Twente');
  assert.equal(names[1], 'Kiwi Arvika');
  assert.equal(names[2], 'Full Kiwi', 'full receivers rank after free ones even when nearer');
  assert.equal(names[3], 'Mystery SDR');
  assert.equal(names[4], 'OWRX Berlin 2m/70cm');
  assert.equal(names[5], 'Offline Kiwi');
  assert.equal(typeof rows[0].distanceKm, 'number');
  assert.equal(rows[2].full, true);
  const strict = rankWebReceivers([owrx, unknown, kiwi], { hz: 14_233_000, requireCoverage: true });
  assert.deepEqual(strict.map((row) => row.receiver.id), ['aaaaaaaaaaaa', 'dddddddddddd'], 'requireCoverage drops receivers that publish non-coverage but keeps unknown');
  assert.equal(rankWebReceivers([kiwi, websdr, owrx], { limit: 2 }).length, 2);
});

test('range coverage needs one band that contains the whole span', () => {
  assert.equal(receiverCoversRangeHz(kiwi, 10_000_000, 15_000_000), true);
  assert.equal(receiverCoversRangeHz(websdr, 10_000_000, 30_000_000), false);
  assert.equal(receiverCoversRangeHz(owrx, 144_000_000, 146_000_000), true);
  assert.equal(receiverCoversRangeHz(owrx, 140_000_000, 146_000_000), false);
  assert.equal(receiverCoversRangeHz(unknown, 10_000_000, 15_000_000), null);
  assert.equal(receiverCoversRangeHz(kiwi, 15_000_000, 10_000_000), false);
  assert.equal(formatFrequencyRange(10_000_000, 15_000_000), '10,000–15,000 kHz');
  assert.equal(formatFrequencyRange(144_000_000, 146_000_000), '144.000–146.000 MHz');
});

test('buildSpectrumUrl mutes and zooms a KiwiSDR and is honest about the others', () => {
  const view = buildSpectrumUrl(kiwi, { lowHz: 10_000_000, highHz: 15_000_000 });
  // 30 MHz full span, 5 MHz wanted → zoom 2 shows 7.5 MHz around 12.5 MHz.
  assert.equal(view.url, 'http://sa4bna.hopto.org:8073/?f=12500amz2&sp=1&mute=1');
  assert.equal(view.muted, true);
  assert.equal(view.zoom, 2);
  assert.equal(view.shownSpanHz, 7_500_000);
  assert.equal(view.rangeLabel, '10,000–15,000 kHz');
  const narrow = buildSpectrumUrl(kiwi, { lowHz: 7_000_000, highHz: 7_200_000 });
  assert.equal(narrow.zoom, 7, '200 kHz wanted → 30 MHz / 2^7 = 234 kHz shown');
  const wide = buildSpectrumUrl(kiwi, { lowHz: 0, highHz: 30_000_000 });
  assert.equal(wide.zoom, 0);
  const web = buildSpectrumUrl(websdr, { lowHz: 10_000_000, highHz: 15_000_000 });
  assert.equal(web.url, 'http://websdr.ewi.utwente.nl:8901/?tune=12500am');
  assert.equal(web.muted, false);
  const rx = buildSpectrumUrl(owrx, { lowHz: 144_000_000, highHz: 146_000_000 });
  assert.equal(rx.url, 'http://thomas0177.ddns.net:8073/#freq=145000000,mod=am');
  assert.equal(rx.muted, false);
  assert.equal(buildSpectrumUrl(kiwi, { lowHz: 15_000_000, highHz: 10_000_000 }), null);
});

test('rankWebReceivers can rank by range coverage and prefer receiver families', () => {
  const rows = rankWebReceivers([owrx, websdr, kiwi, unknown], {
    lat: 52.52, lon: 13.4, rangeHz: [10_000_000, 15_000_000], requireCoverage: true, preferTypes: ['kiwisdr'],
  });
  assert.deepEqual(rows.map((row) => row.receiver.name), ['Kiwi Arvika', 'WebSDR Twente', 'Mystery SDR'],
    'covering receivers first with KiwiSDR preferred, unknown coverage kept last, non-covering dropped');
  assert.equal(rows[0].covers, true);
  assert.equal(rows[2].covers, null);
});
