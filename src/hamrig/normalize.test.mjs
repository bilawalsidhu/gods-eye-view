import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BANDS,
  PII_KEYS,
  bandForHz,
  cleanSpotter,
  inferMode,
  normalizeAurora,
  normalizeBotaSpot,
  normalizeDxccStatus,
  normalizeDxpedition,
  normalizeIonosondes,
  normalizePotaSpot,
  normalizePropagation,
  normalizeReception,
  normalizeRepeaters,
  normalizeRestSpot,
  normalizeRotators,
  normalizeSotaSpot,
  normalizeStation,
  normalizeVhfBeacons,
  normalizeVoacap,
  normalizeWorkedGrids,
  normalizeWsSpot,
  normalizeWwffSpot,
  parseSpotFrequency,
  spotKey,
  spotTimeToIso,
} from './normalize.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

// All fixtures were captured 2026-09-12 ~15:52Z.
const NOW = Date.parse('2026-09-12T15:55:00Z');

const spotsFixture = fixture('hamrig-spots.json');
const wsFixture = fixture('hamrig-ws-messages.json');
const potaFixture = fixture('pota-spot-activator.json');
const sotaFixture = fixture('sota-spots.json');
const sotaSummit = fixture('sota-summit.json');
const wwffFixture = fixture('hamrig-wwff.json');
const botaFixture = fixture('hamrig-bota.json');
const dxOpsFixture = fixture('hamrig-dx-operations.json');
const mostWantedFixture = fixture('hamrig-mostwanted.json');
const auroraFixture = fixture('hamrig-overlay-aurora.json');
const voacapFixture = fixture('hamrig-overlay-voacap.json');
const kc2gFixture = fixture('kc2g-stations.json');
const fmFixture = fixture('hamrig-fm-repeaters-nearby.json');
const dstarFixture = fixture('hamrig-dstar-repeaters-nearby.json');
const pskrFixture = fixture('hamrig-pskreporter.json');
const wsprFixture = fixture('hamrig-wspr.json');
const callsignDbFixture = fixture('hamrig-callsign-db-dh5dax.json');
const conditionsFixture = fixture('hamrig-propagation-conditions.json');
const solarExtendedFixture = fixture('hamrig-solar-extended.json');
const ionoFixture = fixture('hamrig-iono.json');
const mufFixture = fixture('hamrig-muf.json');
const rotatorsFixture = fixture('hamrig-rotators.json');

const SPOT_KEYS = ['id', 'dx', 'spotter', 'spotterCall', 'freqHz', 'band', 'mode', 'comment', 'timeIso', 'dxLoc', 'spotterLoc', 'source'];
const ACTIVATION_KEYS = ['id', 'program', 'callsign', 'reference', 'name', 'freqHz', 'band', 'mode', 'timeIso', 'spotter', 'comments', 'lat', 'lon', 'precision', 'locator', 'country', 'altitudeM', 'points', 'url'];
const DXPED_KEYS = ['id', 'callsign', 'entity', 'adif', 'continent', 'lat', 'lon', 'precision', 'startIso', 'endIso', 'status', 'daysUntil', 'qslVia', 'info', 'url', 'iota', 'mostWantedRank', 'bands', 'modes'];
const STATION_KEYS = ['callsign', 'name', 'country', 'dxcc', 'lat', 'lon', 'precision', 'grid', 'city', 'state', 'imageUrl', 'licenseClass', 'qslManager', 'lotw', 'eqsl', 'hamrigUser', 'sources'];
const REPEATER_KEYS = ['id', 'kind', 'callsign', 'outputHz', 'inputHz', 'ctcss', 'city', 'region', 'country', 'lat', 'lon', 'distanceKm', 'status', 'echolink', 'allstar', 'module'];
const IONO_KEYS = ['code', 'name', 'lat', 'lon', 'mufd', 'fof2', 'hmf2', 'tec', 'timeIso', 'ageMin', 'stale', 'highestBand'];
const ROTATOR_KEYS = ['id', 'name', 'model', 'lat', 'lon', 'grid', 'azimuth', 'elevation', 'targetAzimuth', 'isMoving', 'status', 'online', 'lastSeenIso', 'bands'];

const assertShape = (obj, keys) => assert.deepEqual(Object.keys(obj).sort(), [...keys].sort());

// ---------------------------------------------------------------------------
// Bands + frequencies
// ---------------------------------------------------------------------------

test('BANDS covers 2200m…23cm in ascending order with sane edges', () => {
  assert.deepEqual(BANDS.map((b) => b.band), [
    '2200m', '630m', '160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m', '4m', '2m', '1.25m', '70cm', '33cm', '23cm',
  ]);
  let previousHigh = 0;
  for (const row of BANDS) {
    assert.ok(row.lowHz < row.highHz, row.band);
    assert.ok(row.lowHz > previousHigh, `${row.band} does not overlap the band below`);
    previousHigh = row.highHz;
  }
  assert.ok(Object.isFrozen(BANDS));
});

test('bandForHz maps edges and rejects gaps/garbage', () => {
  assert.equal(bandForHz(14_074_000), '20m');
  assert.equal(bandForHz(1_800_000), '160m');
  assert.equal(bandForHz(2_000_000), '160m');
  assert.equal(bandForHz(5_357_000), '60m');
  assert.equal(bandForHz(135_700), '2200m');
  assert.equal(bandForHz(1_296_000_000), '23cm');
  assert.equal(bandForHz(2_500_000), null);
  assert.equal(bandForHz(0), null);
  assert.equal(bandForHz('nope'), null);
  assert.equal(bandForHz(null), null);
});

test('parseSpotFrequency honours unit hints', () => {
  assert.equal(parseSpotFrequency('18.103', 'mhz'), 18_103_000);
  assert.equal(parseSpotFrequency(7.0287, 'mhz'), 7_028_700);
  assert.equal(parseSpotFrequency(24915.0, 'khz'), 24_915_000);
  assert.equal(parseSpotFrequency('7024.0', 'khz'), 7_024_000);
  assert.equal(parseSpotFrequency('14053', 'khz'), 14_053_000);
  assert.equal(parseSpotFrequency(14_074_000, 'hz'), 14_074_000);
  assert.equal(parseSpotFrequency('14,074.5', 'khz'), 14_074_500, 'thousands commas stripped');
});

test('parseSpotFrequency: khz guard treats values ≥ 1e6 as Hz', () => {
  assert.equal(parseSpotFrequency(14_074_000, 'khz'), 14_074_000);
  assert.equal(parseSpotFrequency('7074000', 'khz'), 7_074_000);
  assert.equal(parseSpotFrequency(144_174_000, 'khz'), 144_174_000);
});

test('parseSpotFrequency: POTA sanity rule repairs a dropped decimal point', () => {
  assert.equal(parseSpotFrequency('1403650', 'khz'), 14_036_500);
  assert.equal(parseSpotFrequency('1403650', 'auto'), 14_036_500);
  // with a point present the value is taken at face value (Hz)
  assert.equal(parseSpotFrequency('1403650.0', 'khz'), 1_403_650);
});

test('parseSpotFrequency auto picks the interpretation that lands in a band', () => {
  assert.equal(parseSpotFrequency('7024.0', 'auto'), 7_024_000);
  assert.equal(parseSpotFrequency('14.074', 'auto'), 14_074_000);
  assert.equal(parseSpotFrequency(14_074_000, 'auto'), 14_074_000);
  assert.equal(parseSpotFrequency(145.575, 'auto'), 145_575_000);
  assert.equal(parseSpotFrequency(1296.2, 'auto'), 1_296_200_000);
});

test('parseSpotFrequency rejects garbage', () => {
  for (const bad of [null, undefined, '', 'abc', -7, 0, NaN, {}, '1e99']) {
    assert.equal(parseSpotFrequency(bad, 'khz'), null, String(bad));
  }
});

// ---------------------------------------------------------------------------
// Mode inference
// ---------------------------------------------------------------------------

test('inferMode: explicit real mode words win', () => {
  assert.equal(inferMode('FT8 -12 dB', 14_074_000, 'CW'), 'CW');
  assert.equal(inferMode('', 7_074_000, 'usb'), 'SSB');
  assert.equal(inferMode('', 7_074_000, 'LSB'), 'SSB');
  assert.equal(inferMode('', 14_070_500, 'PSK31'), 'PSK');
  assert.equal(inferMode('', 14_070_500, 'DATA'), 'DIGI');
  assert.equal(inferMode('', 14_074_000, 'FT2'), 'FT8', 'unknown explicit word falls through');
  assert.equal(inferMode('', 14_074_000, 'CW ' + ''), 'CW');
});

test('inferMode: comment keywords are word-bounded and case-insensitive', () => {
  assert.equal(inferMode('FT8 +9 dB', 24_915_000), 'FT8');
  assert.equal(inferMode('Italian Navy Ship FT8', 21_074_000), 'FT8');
  assert.equal(inferMode('ft4 tnx', 21_140_000), 'FT4');
  assert.equal(inferMode('JS8Call', 7_078_000), 'JS8');
  assert.equal(inferMode('wspr 200mW', 7_038_600), 'WSPR');
  assert.equal(inferMode('MSK144 ms', 50_280_000), 'MSK144');
  assert.equal(inferMode('Q65-60A', 50_275_000), 'DIGI');
  assert.equal(inferMode('JT65 eme', 144_120_000), 'DIGI');
  assert.equal(inferMode('BPSK31 cq', 14_070_500), 'PSK');
  assert.equal(inferMode('PSK63', 14_071_000), 'PSK');
  assert.equal(inferMode('CQ RTTY test', 14_085_000), 'RTTY');
  assert.equal(inferMode('cw qrs pse', 14_255_000), 'CW');
  assert.equal(inferMode('USB 59+', 7_030_000), 'SSB');
  assert.equal(inferMode('LSB net', 7_030_000), 'SSB');
  assert.equal(inferMode('SSTV', 14_230_000), 'SSTV');
  assert.equal(inferMode('AM net', 3_885_000), 'AM');
  assert.equal(inferMode('FM simplex', 145_500_000), 'FM');
  assert.equal(inferMode('heard on PSKReporter', 14_255_000), 'SSB', 'PSKReporter is not the PSK keyword');
  assert.equal(inferMode('tnx fm JA', 7_213_000), 'SSB', 'lower-case "fm" (= from) is not FM');
});

test('inferMode: RBN skimmer patterns', () => {
  assert.equal(inferMode('RBN 15 dB 20 WPM via DL8TG-#', 7_024_000), 'CW');
  assert.equal(inferMode('[RBNHole] at DO4DXA 22 WPM 16 dB SNR', 7_028_700), 'CW');
  assert.equal(inferMode('12 dB 45 BPS CQ', 14_085_000), 'RTTY');
  assert.equal(inferMode('RBN -13 dB via WA7LNW-#', 21_074_000), 'FT8', 'no WPM → dial table decides');
});

test('inferMode: dial-frequency table (dial..dial+3 kHz)', () => {
  for (const khz of [1840, 3573, 5357, 7074, 10136, 14074, 18100, 21074, 24915, 28074, 50313, 50323, 70154, 144174]) {
    assert.equal(inferMode('', khz * 1000), 'FT8', `FT8 ${khz}`);
    assert.equal(inferMode('', (khz + 0.5) * 1000), 'FT8', `FT8 ${khz}+0.5`);
  }
  assert.equal(inferMode('', 14_076_900), 'FT8', 'top of the dial..dial+3 kHz window');
  assert.equal(inferMode('', 14_077_100), 'DIGI', 'just past the window → band-plan segment');
  for (const khz of [3575, 7047.5, 10140, 14080, 18104, 21140, 24919, 28180, 50318]) {
    assert.equal(inferMode('', khz * 1000), 'FT4', `FT4 ${khz}`);
  }
  for (const khz of [1836.6, 3568.6, 7038.6, 10138.7, 14095.6, 21094.6, 24924.6, 28124.6, 50293]) {
    assert.equal(inferMode('', khz * 1000), 'WSPR', `WSPR ${khz}`);
  }
  for (const khz of [1842, 3578, 7078, 10130, 14078, 21078, 24922, 28078]) {
    assert.equal(inferMode('', khz * 1000), 'JS8', `JS8 ${khz}`);
  }
  assert.equal(inferMode('', 18_104_000), 'FT4', 'FT4 precedes JS8 on the shared 18104 dial (tie → table order)');
  assert.equal(inferMode('', 18_104_600), 'WSPR', 'nearest dial at or below the signal wins');
  assert.equal(inferMode('', 3_574_000), 'FT8');
  assert.equal(inferMode('', 3_576_000), 'FT4');
  assert.equal(inferMode('', 14_079_000), 'JS8');
  assert.equal(inferMode('', 14_081_000), 'FT4');
  for (const khz of [14100, 18110, 21150, 24930, 28200]) {
    assert.equal(inferMode('', khz * 1000), 'BEACON', `IBP ${khz}`);
    assert.equal(inferMode('', (khz + 0.5) * 1000), 'BEACON', `IBP ${khz}+0.5`);
    assert.equal(inferMode('', (khz - 0.4) * 1000), 'BEACON', `IBP ${khz}-0.4`);
  }
});

test('inferMode: band-plan segments and VHF/UHF null', () => {
  assert.equal(inferMode('', 14_023_000), 'CW');
  assert.equal(inferMode('', 3_507_000), 'CW');
  assert.equal(inferMode('', 7_028_700), 'CW');
  assert.equal(inferMode('', 10_115_000), 'CW');
  assert.equal(inferMode('', 18_085_000), 'CW');
  assert.equal(inferMode('', 21_012_000), 'CW');
  assert.equal(inferMode('', 24_900_000), 'CW');
  assert.equal(inferMode('', 28_020_000), 'CW');
  assert.equal(inferMode('', 1_820_000), 'CW');
  assert.equal(inferMode('', 3_590_000), 'DIGI');
  assert.equal(inferMode('', 7_044_000), 'DIGI');
  assert.equal(inferMode('', 14_085_000), 'DIGI');
  assert.equal(inferMode('', 21_100_000), 'DIGI');
  assert.equal(inferMode('', 28_110_000), 'DIGI');
  assert.equal(inferMode('', 3_707_000), 'SSB');
  assert.equal(inferMode('', 7_213_000), 'SSB');
  assert.equal(inferMode('', 14_255_000), 'SSB');
  assert.equal(inferMode('', 18_140_000), 'SSB');
  assert.equal(inferMode('', 21_248_000), 'SSB');
  assert.equal(inferMode('', 24_950_000), 'SSB');
  assert.equal(inferMode('', 28_440_000), 'SSB');
  assert.equal(inferMode('', 14_100_800), null, 'between the IBP slot and the SSB segment');
  assert.equal(inferMode('', 145_575_000), null, 'no guessing on VHF outside the dial table');
  assert.equal(inferMode('', 50_125_000), null);
  assert.equal(inferMode('', 430_000_000), null);
  assert.equal(inferMode(null, null), null);
});

// ---------------------------------------------------------------------------
// Spot helpers
// ---------------------------------------------------------------------------

test('spotTimeToIso uses today UTC and rolls back when > 5 min in the future', () => {
  assert.equal(spotTimeToIso('1217Z', NOW), '2026-09-12T12:17:00.000Z');
  assert.equal(spotTimeToIso('1217', NOW), '2026-09-12T12:17:00.000Z');
  assert.equal(spotTimeToIso('12:17Z', NOW), '2026-09-12T12:17:00.000Z');
  assert.equal(spotTimeToIso('1600Z', NOW), '2026-09-12T16:00:00.000Z', 'exactly 5 min ahead stays today');
  assert.equal(spotTimeToIso('1601Z', NOW), '2026-09-11T16:01:00.000Z', '6 min ahead → yesterday');
  assert.equal(spotTimeToIso('2359Z', NOW), '2026-09-11T23:59:00.000Z');
  assert.equal(spotTimeToIso('garbage', NOW), null);
  assert.equal(spotTimeToIso('2560Z', NOW), null);
  assert.equal(spotTimeToIso(null, NOW), null);
});

test('cleanSpotter strips skimmer suffixes for lookup but keeps the display string', () => {
  assert.deepEqual(cleanSpotter('DL8LAS-#'), { spotter: 'DL8LAS-#', spotterCall: 'DL8LAS' });
  assert.deepEqual(cleanSpotter('W3LPL-2'), { spotter: 'W3LPL-2', spotterCall: 'W3LPL' });
  assert.deepEqual(cleanSpotter('W1NT-6-#'), { spotter: 'W1NT-6-#', spotterCall: 'W1NT' });
  assert.deepEqual(cleanSpotter(' ct7aut '), { spotter: 'ct7aut', spotterCall: 'CT7AUT' });
  assert.deepEqual(cleanSpotter('CT7AUT:'), { spotter: 'CT7AUT:', spotterCall: 'CT7AUT' });
  assert.deepEqual(cleanSpotter(null), { spotter: '', spotterCall: '' });
});

test('normalizeRestSpot: every fixture row normalizes, raw.mode is ignored', () => {
  const spots = spotsFixture.spots.map((row) => normalizeRestSpot(row, { nowMs: NOW }));
  assert.equal(spots.length, 8);
  for (const spot of spots) {
    assert.ok(spot, 'row normalized');
    assertShape(spot, SPOT_KEYS);
    assert.equal(spot.source, 'rest');
    assert.equal(spot.dxLoc, null);
    assert.equal(spot.spotterLoc, null);
    assert.equal(spot.id, spotKey(spot));
  }
  const byDx = Object.fromEntries(spots.map((s) => [s.dx, s]));
  assert.equal(byDx.SP9SIR.freqHz, 3_707_000);
  assert.equal(byDx.SP9SIR.band, '80m');
  assert.equal(byDx.SP9SIR.mode, 'SSB', 'server default CW ignored; 3707 is phone');
  assert.equal(byDx.SP9SIR.timeIso, '2026-09-12T12:41:00.000Z');
  assert.equal(byDx.SP9SIR.comment, 'WWFF SPFF-2718');
  assert.equal(byDx.UA9XO.mode, 'CW');
  assert.equal(byDx.AC1RH.mode, 'SSB');
  assert.equal(byDx.JA8JNU.mode, 'FT4');
  assert.equal(byDx.II4IANT.mode, 'FT8');
  assert.equal(byDx.CX2RA.mode, 'SSB');
  assert.equal(byDx.YB1GAL.comment, '');
  assert.equal(byDx.UP4L.spotterCall, 'P3CR');
  // the mode in the fixture is 'CW' on every row; only three are really CW-ish
  assert.notEqual(spots.filter((s) => s.mode === 'CW').length, spots.length);
});

test('normalizeRestSpot rejects rows without a callsign or frequency', () => {
  assert.equal(normalizeRestSpot(null, { nowMs: NOW }), null);
  assert.equal(normalizeRestSpot({ dx_callsign: '', frequency: '14.074' }, { nowMs: NOW }), null);
  assert.equal(normalizeRestSpot({ dx_callsign: 'DL1ABC', frequency: 'x' }, { nowMs: NOW }), null);
  const fallback = normalizeRestSpot({ dx_callsign: 'dl1abc', frequency: '14.074', time: 'bogus' }, { nowMs: NOW });
  assert.equal(fallback.dx, 'DL1ABC');
  assert.equal(fallback.timeIso, new Date(NOW).toISOString(), 'unparseable time falls back to now');
});

test('normalizeWsSpot: bare spots, historical_spot wrappers, other typed messages', () => {
  const results = wsFixture.map((message) => normalizeWsSpot(message, { nowMs: NOW }));
  const spots = results.filter(Boolean);
  assert.equal(spots.length, 4, 'three bare spots + one historical_spot');
  assert.equal(results[0], null, 'welcome');
  assert.equal(results[1], null, 'spot_history_push');
  assert.equal(results[5], null, 'spot_history_push_complete');
  assert.equal(results[6], null, 'spot_request_response');
  assert.equal(results[8], null, 'spot_request_complete');
  assert.equal(results[9], null, 'spot_request_error');

  const [s79, f5mqu, up4l, ua9xo] = spots;
  for (const spot of spots) {
    assertShape(spot, SPOT_KEYS);
    assert.equal(spot.source, 'ws');
  }
  assert.equal(s79.dx, 'S79/DL2SBY');
  assert.equal(s79.freqHz, 24_915_000);
  assert.equal(s79.band, '12m');
  assert.equal(s79.mode, 'FT8');
  assert.equal(s79.timeIso, '2026-09-12T15:34:54.475Z', 'ISO timestamp preferred over HHMMZ');
  assert.equal(f5mqu.spotterCall, 'DL8LAS');
  assert.equal(f5mqu.spotter, 'DL8LAS-#');
  assert.equal(f5mqu.mode, 'CW');
  assert.equal(up4l.timeIso, '2026-09-12T12:25:00.000Z', 'no timestamp → HHMMZ today');
  assert.equal(up4l.spotterCall, 'W3LPL');
  assert.equal(up4l.mode, 'SSB');
  assert.equal(ua9xo.dx, 'UA9XO');
  assert.equal(ua9xo.timeIso, '2026-09-12T12:40:12.000Z');
  assert.equal(ua9xo.mode, 'CW');
});

test('normalizeWsSpot: kHz float rule and malformed inputs', () => {
  const hz = normalizeWsSpot({ spotter: 'A1A', spotted: 'B2B', frequency: 14_074_000, time: '1200Z' }, { nowMs: NOW });
  assert.equal(hz.freqHz, 14_074_000, 'values ≥ 1e6 are Hz');
  assert.equal(normalizeWsSpot({ type: 'historical_spot' }, { nowMs: NOW }), null);
  assert.equal(normalizeWsSpot({ type: 'historical_spot', spot: 'nope' }, { nowMs: NOW }), null);
  assert.equal(normalizeWsSpot('DX de X', { nowMs: NOW }), null);
  assert.equal(normalizeWsSpot({ spotter: 'A1A', frequency: 14074 }, { nowMs: NOW }), null, 'no dx');
});

test('spotKey dedupes REST and WS views of the same spot', () => {
  const rest = normalizeRestSpot({ dx_callsign: 'UA9XO', spotter: 'IK6MNB', frequency: '14.023', mode: 'CW', band: '20m', time: '1240Z', comment: 'CQ TEST' }, { nowMs: NOW });
  const ws = normalizeWsSpot(wsFixture[7], { nowMs: NOW });
  assert.equal(spotKey(rest), spotKey(ws));
  assert.equal(spotKey(ws), 'IK6MNB|UA9XO|140230|2026-09-12T12:40');
  const skimmer = normalizeWsSpot({ spotter: 'IK6MNB-#', spotted: 'UA9XO', frequency: 14023.04, timestamp: '2026-09-12T12:40:59Z' }, { nowMs: NOW });
  assert.equal(spotKey(skimmer), spotKey(ws), '100 Hz bin + minute + cleaned spotter');
  assert.equal(spotKey(null), '||0|');
});

// ---------------------------------------------------------------------------
// Activations
// ---------------------------------------------------------------------------

test('normalizePotaSpot: every fixture row, kHz frequency, exact coords, park name fallback', () => {
  const rows = potaFixture.map((row) => normalizePotaSpot(row, { nowMs: NOW }));
  assert.equal(rows.length, 8);
  for (const act of rows) {
    assert.ok(act);
    assertShape(act, ACTIVATION_KEYS);
    assert.equal(act.program, 'POTA');
    assert.equal(act.precision, 'exact');
    assert.ok(Number.isFinite(act.lat) && Number.isFinite(act.lon));
  }
  const first = rows[0];
  assert.equal(first.id, 'pota:56621413');
  assert.equal(first.callsign, 'F5MQU/P');
  assert.equal(first.reference, 'FR-7356');
  assert.equal(first.name, 'Carrieres souterraines de Chichee Biological Reserve', 'parkName null → name');
  assert.equal(first.freqHz, 7_024_000);
  assert.equal(first.band, '40m');
  assert.equal(first.mode, 'CW');
  assert.equal(first.timeIso, '2026-09-12T15:49:57.000Z', 'tz-less spotTime is UTC');
  assert.equal(first.spotter, 'DL8TG-#');
  assert.equal(first.lat, 47.796);
  assert.equal(first.lon, 3.823);
  assert.equal(first.locator, 'JN17vt');
  assert.equal(first.country, 'FR');
  assert.equal(first.url, 'https://pota.app/#/park/FR-7356');
  assert.equal(rows[1].mode, 'FT8');
  assert.equal(rows[7].callsign, 'IA5/IK5AEQ');
});

test('normalizePotaSpot falls back to the grid and repairs a dropped decimal point', () => {
  const base = { ...potaFixture[2], latitude: null, longitude: null, frequency: '1403650' };
  const act = normalizePotaSpot(base, { nowMs: NOW });
  assert.equal(act.precision, 'grid');
  assert.equal(act.freqHz, 14_036_500);
  assert.equal(act.band, '20m');
  assert.ok(Math.abs(act.lat - 38.68) < 0.1 && Math.abs(act.lon - (-105.96)) < 0.1, 'DM78aq centre');
  const none = normalizePotaSpot({ ...base, grid6: null, grid4: null }, { nowMs: NOW });
  assert.equal(none, null, 'no coordinates → dropped');
  assert.equal(normalizePotaSpot(null, { nowMs: NOW }), null);
});

test('normalizeSotaSpot: row coordinates first, summit fallback, null when neither', () => {
  const rows = sotaFixture.map((row) => normalizeSotaSpot(row, null, { nowMs: NOW }));
  assert.equal(rows.length, 8);
  for (const act of rows) {
    assert.ok(act);
    assertShape(act, ACTIVATION_KEYS);
    assert.equal(act.program, 'SOTA');
    assert.equal(act.precision, 'exact');
  }
  const k2cpt = rows[0];
  assert.equal(k2cpt.id, 'sota:389141');
  assert.equal(k2cpt.callsign, 'K2CPT');
  assert.equal(k2cpt.reference, 'W2/GA-212');
  assert.equal(k2cpt.name, 'Azure Mountain');
  assert.equal(k2cpt.freqHz, 14_309_000);
  assert.equal(k2cpt.mode, 'SSB');
  assert.equal(k2cpt.timeIso, '2026-09-12T15:49:15.000Z');
  assert.equal(k2cpt.altitudeM, 765);
  assert.equal(k2cpt.points, 1);
  assert.equal(k2cpt.spotter, 'K2CPT');
  assert.equal(k2cpt.url, 'https://sotl.as/summits/W2/GA-212');
  assert.equal(k2cpt.country, 'W2');
  assert.equal(rows[1].callsign, 'OE3VBU/6');
  assert.equal(rows[1].mode, 'CW');
  assert.equal(rows[1].spotter, 'RBNHOLE');
  assert.equal(rows[6].mode, 'CW', 'explicit mode survives even at 144.1 MHz');
  assert.equal(rows[7].mode, 'FM');

  const noCoords = { ...sotaFixture[3], latitude: null, longitude: null };
  const viaSummit = normalizeSotaSpot(noCoords, sotaSummit, { nowMs: NOW });
  assert.equal(viaSummit.lat, 39.4033);
  assert.equal(viaSummit.lon, -105.9833);
  assert.equal(viaSummit.precision, 'exact');
  assert.equal(viaSummit.locator, 'DM79aj');
  assert.equal(viaSummit.country, 'USA - Colorado');
  assert.equal(normalizeSotaSpot(noCoords, null, { nowMs: NOW }), null);
  assert.equal(normalizeSotaSpot(noCoords, { latitude: null, longitude: null }, { nowMs: NOW }), null);
  const rowWins = normalizeSotaSpot(sotaFixture[3], { ...sotaSummit, latitude: 0, longitude: 0 }, { nowMs: NOW });
  assert.ok(Math.abs(rowWins.lat - 39.4033) < 1e-3);
});

test('normalizeWwffSpot: locator fallback (≥ 4 chars, JJ00AA/"-" rejected), frequencyKhz preferred', () => {
  const rows = wwffFixture.spots.map((row) => normalizeWwffSpot(row, { nowMs: NOW }));
  assert.equal(rows.length, 8);
  const kept = rows.filter(Boolean);
  assert.equal(kept.length, 6, 'JJ00AA and "-" locators are dropped');
  assert.equal(rows[1], null, 'JL1IOC/P with JJ00AA');
  assert.equal(rows[2], null, 'F5MQU/P with "-"');
  for (const act of kept) {
    assertShape(act, ACTIVATION_KEYS);
    assert.equal(act.program, 'WWFF');
    assert.equal(act.precision, 'grid');
  }
  const wg8x = rows[0];
  assert.equal(wg8x.id, 'wwff:145132');
  assert.equal(wg8x.callsign, 'WG8X');
  assert.equal(wg8x.reference, 'KFF-3516');
  assert.equal(wg8x.freqHz, 7_044_000);
  assert.equal(wg8x.band, '40m');
  assert.equal(wg8x.mode, 'CW');
  assert.equal(wg8x.locator, 'EN91HA');
  assert.equal(wg8x.country, 'US');
  assert.equal(wg8x.timeIso, '2026-09-12T15:48:03.000Z');
  assert.ok(Math.abs(wg8x.lat - 41.02) < 0.05 && Math.abs(wg8x.lon - (-81.375)) < 0.05);
  assert.equal(wg8x.url, 'https://wwff.co/directory/?showRef=KFF-3516');
  assert.equal(rows[6].freqHz, 10_114_500, 'frequencyKhz 10114.5');
  assert.equal(rows[7].mode, 'SSB', 'USB → SSB');

  const twoChar = normalizeWwffSpot({ ...wwffFixture.spots[0], locator: 'EN' }, { nowMs: NOW });
  assert.equal(twoChar, null, '2-char field is too coarse');
  const exact = normalizeWwffSpot({ ...wwffFixture.spots[0], latitude: 41.5, longitude: -81.2 }, { nowMs: NOW });
  assert.equal(exact.precision, 'exact');
  assert.equal(exact.lat, 41.5);
  const mhzOnly = normalizeWwffSpot({ ...wwffFixture.spots[0], frequencyKhz: undefined }, { nowMs: NOW });
  assert.equal(mhzOnly.freqHz, 7_044_000);
});

test('normalizeBotaSpot: lat/lon keys, MHz frequency, null id', () => {
  const [act] = botaFixture.spots.map((row) => normalizeBotaSpot(row, { nowMs: NOW }));
  assert.ok(act);
  assertShape(act, ACTIVATION_KEYS);
  assert.equal(act.program, 'BOTA');
  assert.equal(act.callsign, 'GB1MG');
  assert.equal(act.reference, 'B/G-1314');
  assert.equal(act.name, 'Airfield Battle HQ - Ramsbury');
  assert.equal(act.freqHz, 18_083_250);
  assert.equal(act.band, '17m');
  assert.equal(act.mode, 'CW');
  assert.equal(act.timeIso, '2026-09-12T15:21:18.791Z');
  assert.equal(act.lat, 51.44);
  assert.equal(act.lon, -1.6);
  assert.equal(act.precision, 'exact');
  assert.equal(act.locator, 'IO91');
  assert.equal(act.id, 'bota:GB1MG:B/G-1314:2026-09-12T15:21');
  const viaGrid = normalizeBotaSpot({ ...botaFixture.spots[0], lat: null, lon: null }, { nowMs: NOW });
  assert.equal(viaGrid.precision, 'grid');
  assert.ok(Math.abs(viaGrid.lat - 51.5) < 1e-9 && Math.abs(viaGrid.lon - (-1)) < 1e-9, 'IO91 centre');
  assert.equal(normalizeBotaSpot({ ...botaFixture.spots[0], lat: null, lon: null, locator: null }, { nowMs: NOW }), null);
});

// ---------------------------------------------------------------------------
// DXpeditions
// ---------------------------------------------------------------------------

const LOCS = {
  V51WH: { lat: -22, lon: 17, precision: 'entity', entity: 'Namibia', continent: 'AF', adif: 464, cq: 38 },
  TF: { lat: 64.8, lon: -18.1, precision: 'entity', entity: 'Iceland', continent: 'EU', adif: 242, cq: 40 },
  J3: { lat: 12.1, lon: -61.7, precision: 'entity', entity: 'Grenada', continent: 'NA', adif: 77, cq: 8 },
  VP5: { lat: 21.8, lon: -71.8, precision: 'entity', entity: 'Turks & Caicos Is.', continent: 'NA', adif: 89, cq: 8 },
  RI1FJZ: { lat: 80.6, lon: 55.0, precision: 'entity', entity: 'Franz Josef Land', continent: 'EU', adif: 61, cq: 40 },
};
const locate = (call) => LOCS[call] ?? null;
const mostWantedByCall = new Map(mostWantedFixture.operations.map((op) => [op.callsign.toUpperCase(), op]));

test('normalizeDxpedition: prefix-only callsigns resolve via locate, status/qsl/iota/rank carried', () => {
  const ops = dxOpsFixture.operations.map((op) => normalizeDxpedition(op, mostWantedByCall, locate));
  assert.equal(ops.length, 10);
  for (const op of ops) {
    assert.ok(op);
    assertShape(op, DXPED_KEYS);
    assert.equal(op.precision, 'entity');
    assert.equal(op.status, 'active');
  }
  const byCall = Object.fromEntries(ops.map((op) => [op.callsign, op]));
  assert.equal(byCall.TF.lat, 64.8, 'bare prefix TF located');
  assert.equal(byCall.TF.entity, 'Iceland');
  assert.equal(byCall.TF.continent, 'EU');
  assert.equal(byCall.TF.adif, 242);
  assert.equal(byCall.TF.qslVia, 'LoTW', 'dirty "LoTW)" cleaned');
  assert.equal(byCall.TF.mostWantedRank, null);
  assert.equal(byCall.TF.startIso, '2026-08-30T00:00:00.000Z');
  assert.equal(byCall.TF.endIso, '2026-09-13T00:00:00.000Z');
  assert.deepEqual(byCall.TF.bands, ['40m', '15m', '10m']);
  assert.deepEqual(byCall.TF.modes, ['SSB', 'FT8', 'FT4']);
  assert.equal(byCall.J3.iota, 'NA-024');
  assert.equal(byCall.V51WH.mostWantedRank, 224);
  assert.equal(byCall.V51WH.qslVia, 'DK2WH');
  assert.equal(byCall.RI1FJZ.mostWantedRank, 55);
  assert.equal(byCall.RI1FJZ.url, 'https://ri1fjz.ru/en/');
  assert.equal(byCall.RI1FJZ.iota, 'EU-019');
  assert.equal(byCall.VP5.mostWantedRank, 70);
  assert.equal(byCall.KH0N.qslVia, 'JA6CNL (B/d)', 'balanced parens untouched');
  assert.equal(byCall.KH0N.lat, null, 'unlocatable → null coords, row kept');
  assert.equal(byCall.KH0N.adif, 186, 'adif from the most-wanted row when locate misses');
  assert.equal(byCall.KH0N.continent, 'OC');
  assert.equal(byCall['9N'].daysUntil, null);
  assert.deepEqual(byCall['9N'].modes, []);
  assert.equal(byCall.CT9.mostWantedRank, null);
});

test('normalizeDxpedition: past → ended, upcoming days_until, plain-object most-wanted map, no locate', () => {
  const past = normalizeDxpedition({ ...dxOpsFixture.operations[0], status: 'past' }, null, null);
  assert.equal(past.status, 'ended');
  assert.equal(past.lat, null);
  assert.equal(past.mostWantedRank, null);
  const upcoming = normalizeDxpedition({ ...dxOpsFixture.operations[0], status: 'upcoming', days_until: 12 }, { V51WH: { rank: 3 } }, locate);
  assert.equal(upcoming.status, 'upcoming');
  assert.equal(upcoming.daysUntil, 12);
  assert.equal(upcoming.mostWantedRank, 3);
  assert.equal(upcoming.id, 'dxped:V51WH:1787616000');
  assert.equal(normalizeDxpedition({ callsign: '' }, null, locate), null);
  assert.equal(normalizeDxpedition(null, null, locate), null);
  const throwing = normalizeDxpedition(dxOpsFixture.operations[0], null, () => { throw new Error('boom'); });
  assert.equal(throwing.lat, null, 'a throwing locate is tolerated');
  const lower = normalizeDxpedition({ ...dxOpsFixture.operations[0], callsign: 'v51wh' }, mostWantedByCall, locate);
  assert.equal(lower.callsign, 'V51WH');
  assert.equal(lower.mostWantedRank, 224);
});

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

test('normalizeAurora', () => {
  const aurora = normalizeAurora(auroraFixture);
  assert.deepEqual(Object.keys(aurora).sort(), ['current', 'forecastIso', 'level', 'observationIso', 'points', 'unit']);
  assert.equal(aurora.points.length, auroraFixture.points.length);
  assert.deepEqual(aurora.points[3], { lat: 73, lon: 0, value: 8 });
  assert.equal(aurora.current, 19);
  assert.equal(aurora.level, 'low');
  assert.equal(aurora.unit, '%');
  assert.equal(aurora.observationIso, '2026-09-12T15:25:00.000Z');
  assert.equal(aurora.forecastIso, '2026-09-12T16:35:00.000Z');
  const dirty = normalizeAurora({ points: [{ lat: 'x', lon: 0, value: 5 }, { lat: 70, lon: 0 }, { lat: 91, lon: 0, value: 1 }, { lat: 70, lon: 5, value: 12 }] });
  assert.deepEqual(dirty.points, [{ lat: 70, lon: 5, value: 12 }]);
  assert.deepEqual(normalizeAurora(null).points, []);
});

test('normalizeVoacap', () => {
  const voacap = normalizeVoacap(voacapFixture);
  assert.deepEqual(Object.keys(voacap).sort(), ['frequencyMhz', 'points', 'ssn', 'txLat', 'txLon', 'utcHour']);
  assert.equal(voacap.txLat, 52.19);
  assert.equal(voacap.txLon, 7.04);
  assert.equal(voacap.frequencyMhz, 14.1);
  assert.equal(voacap.utcHour, 15);
  assert.equal(voacap.ssn, 88);
  assert.equal(voacap.points.length, 30);
  assert.deepEqual(voacap.points[0], { lat: -80, lon: -180, reliability: 58, snr: 15 });
  assert.deepEqual(normalizeVoacap({}).points, []);
  assert.equal(normalizeVoacap(undefined).txLat, null);
});

test('normalizeIonosondes: longitude wrap, 24 h drop, 60 min stale, highestBand', () => {
  const stations = normalizeIonosondes(kc2gFixture, { nowMs: NOW });
  const codes = stations.map((s) => s.code);
  assert.deepEqual(codes, ['EA036', 'EB040', 'AT138'], 'AU930 (March), BP440 (2021) and MHJ45 (> 24 h) dropped');
  for (const station of stations) assertShape(station, IONO_KEYS);
  const arenosillo = stations[0];
  assert.equal(arenosillo.name, 'El Arenosillo, Spain');
  assert.equal(arenosillo.lat, 37.1);
  assert.ok(Math.abs(arenosillo.lon - (-6.7)) < 1e-9, '353.3 → −6.7');
  assert.equal(arenosillo.mufd, 25.602);
  assert.equal(arenosillo.fof2, 7.8);
  assert.equal(arenosillo.hmf2, 253.161);
  assert.equal(arenosillo.tec, null);
  assert.equal(arenosillo.timeIso, '2026-09-12T15:45:01.000Z');
  assert.equal(arenosillo.ageMin, 10);
  assert.equal(arenosillo.stale, false);
  assert.equal(arenosillo.highestBand, '12m');
  assert.equal(stations[2].lon, 23.5);
  assert.equal(stations[2].code, 'AT138');
  assert.equal(stations[2].highestBand, '15m', 'mufd 22.555');
});

test('normalizeIonosondes: exact age boundaries', () => {
  const make = (code, iso, mufd = 15) => ({ station: { code, name: code, latitude: '10', longitude: '200' }, time: iso, mufd });
  const rows = [
    make('FRESH', '2026-09-12T15:00:00', 22.6),
    make('EDGE', '2026-09-12T14:55:00'),
    make('STALE', '2026-09-12T14:54:00'),
    make('OLD', '2026-09-11T15:54:00'),
    make('NULLMUF', '2026-09-12T15:50:00', null),
    make('BIGMUF', '2026-09-12T15:50:00', 55),
    { station: { code: 'NOTIME', latitude: '1', longitude: '1' } },
    { station: null, time: '2026-09-12T15:50:00' },
  ];
  const out = normalizeIonosondes(rows, { nowMs: NOW });
  assert.deepEqual(out.map((s) => [s.code, s.ageMin, s.stale, s.highestBand]), [
    ['FRESH', 55, false, '15m'],
    ['EDGE', 60, false, '20m'],
    ['STALE', 61, true, '20m'],
    ['NULLMUF', 5, false, null],
    ['BIGMUF', 5, false, '6m'],
  ]);
  assert.equal(out[0].lon, -160);
  assert.deepEqual(normalizeIonosondes(null, { nowMs: NOW }), []);
});

// ---------------------------------------------------------------------------
// Repeaters
// ---------------------------------------------------------------------------

test('normalizeRepeaters: FM rows plus one D-STAR row per module, nearest first', () => {
  const repeaters = normalizeRepeaters(fmFixture, dstarFixture);
  assert.equal(repeaters.length, 6 + 8, '6 FM + 8 D-STAR modules');
  for (const r of repeaters) assertShape(r, REPEATER_KEYS);
  const distances = repeaters.map((r) => r.distanceKm);
  assert.deepEqual(distances, [...distances].sort((a, b) => a - b));

  const pi2non = repeaters.find((r) => r.callsign === 'PI2NON');
  assert.equal(pi2non.kind, 'FM');
  assert.equal(pi2non.id, 'fm:1886');
  assert.equal(pi2non.outputHz, 430_275_000);
  assert.equal(pi2non.inputHz, 431_875_000);
  assert.equal(pi2non.ctcss, null);
  assert.equal(pi2non.city, 'Enschede');
  assert.equal(pi2non.country, 'Netherlands');
  assert.equal(pi2non.lat, 52.23009872);
  assert.equal(pi2non.lon, 6.91677999);
  assert.equal(pi2non.status, 'On-air');
  assert.equal(pi2non.module, null);
  const do0ll = repeaters.find((r) => r.callsign === 'DO0LL');
  assert.equal(do0ll.ctcss, 123);
  assert.equal(do0ll.echolink, '6053');
  assert.equal(do0ll.allstar, null);
  const db0eg = repeaters.find((r) => r.callsign === 'DB0EG');
  assert.equal(db0eg.outputHz, 1_242_500_000);

  const db0rtv = repeaters.find((r) => r.callsign === 'DB0RTV');
  assert.equal(db0rtv.kind, 'D-STAR');
  assert.equal(db0rtv.id, 'dstar:561:B');
  assert.equal(db0rtv.module, 'B');
  assert.equal(db0rtv.outputHz, 438_512_500);
  assert.equal(db0rtv.inputHz, 430_912_500, 'output + (−7.6 MHz)');
  assert.equal(db0rtv.country, 'Germany');
  assert.equal(db0rtv.region, 'North Rhine-Westphalia');
  assert.equal(db0rtv.city, 'Rheine');
  assert.equal(db0rtv.ctcss, null);
  const pi1mep = repeaters.filter((r) => r.callsign === 'PI1MEP');
  assert.deepEqual(pi1mep.map((r) => r.module), ['A', 'B', 'C']);
  assert.equal(pi1mep[0].outputHz, 1_297_225_000);
  assert.equal(pi1mep[0].inputHz, 1_267_225_000);
  assert.equal(pi1mep[1].inputHz, 431_000_000, 'zero offset');
  assert.equal(pi1mep[0].country, 'Netherlands');
  assert.equal(pi1mep[0].region, null);
  const db0ngr = repeaters.find((r) => r.callsign === 'DB0NGR');
  assert.equal(db0ngr.inputHz, 146_187_500, 'positive offset');
});

test('normalizeRepeaters tolerates missing payloads and bad rows', () => {
  assert.deepEqual(normalizeRepeaters(null, null), []);
  assert.deepEqual(normalizeRepeaters({ success: false }, { data: 'x' }), []);
  const only = normalizeRepeaters({ data: [{ id: 1, callsign: 'X', frequency: 'abc', latitude: '1', longitude: '1' }, { id: 2, callsign: 'DB0X', frequency: '145.6', latitude: null, longitude: null }] }, null);
  assert.deepEqual(only, []);
});

// ---------------------------------------------------------------------------
// Reception
// ---------------------------------------------------------------------------

test('normalizeReception: warming-up PSKReporter payload with bands [] → {}', () => {
  const reception = normalizeReception(pskrFixture, wsprFixture);
  assert.deepEqual(Object.keys(reception).sort(), ['psk', 'wspr']);
  assert.deepEqual(reception.psk, { call: 'DL2SBY', count: 0, warmingUp: true, bands: {}, reports: [] });
  assert.equal(reception.wspr.field, 'JO');
  assert.deepEqual(reception.wspr.bounds, { south: 50, west: 0, north: 60, east: 20 }, '20°×10° field, never a point');
  assert.equal(reception.wspr.bands.length, 13);
  const b40 = reception.wspr.bands.find((b) => b.band === '40m');
  assert.deepEqual(Object.keys(b40).sort(), ['avgSnr', 'band', 'dxAzimuth', 'dxGrid', 'dxLat', 'dxLon', 'maxKm', 'spots']);
  assert.equal(b40.spots, 16655);
  assert.equal(b40.maxKm, 18097);
  assert.equal(b40.avgSnr, -14.4);
  assert.equal(b40.dxGrid, 'RE78mu');
  assert.equal(b40.dxAzimuth, 65);
  assert.ok(b40.dxLat < -41 && b40.dxLat > -42 && b40.dxLon > 174 && b40.dxLon < 176, 'RE78mu is New Zealand');
  const b80 = reception.wspr.bands.find((b) => b.band === '80m');
  assert.ok(Math.abs(b80.dxLat - 24.5) < 1e-9 && Math.abs(b80.dxLon - (-145)) < 1e-9, 'BL74 4-char centre');
});

test('normalizeReception: reports gain lat/lon from rx_grid, unix seconds → ISO', () => {
  const pskr = {
    success: true, call: 'DH5DAX', minutes: 30, count: 2,
    bands: { '20m': 1, '40m': 1 },
    reports: [
      { rx_call: 'dl8aam', rx_grid: 'JO42', my_azimuth: 45, band: '40m', mode: 'FT8', snr: -7, freq: 7074123, t: 1789228000 },
      { rx_call: 'W1NT', rx_grid: 'FN42gx', band: '20m', mode: 'FT8', snr: 3, freq: 14074000, t: 1789228100 },
      { rx_call: 'BADGRID', rx_grid: 'ZZ99', band: '20m', mode: 'FT8', snr: 1, freq: 14074000, t: 1789228100 },
      { rx_grid: 'JO42' },
    ],
    warming_up: false,
  };
  const { psk, wspr } = normalizeReception(pskr, { success: false });
  assert.equal(wspr, null);
  assert.equal(psk.warmingUp, false);
  assert.deepEqual(psk.bands, { '20m': 1, '40m': 1 });
  assert.equal(psk.reports.length, 3, 'row without rx_call dropped');
  const [dl8aam, w1nt, bad] = psk.reports;
  assert.deepEqual(Object.keys(dl8aam).sort(), ['azimuth', 'band', 'freqHz', 'lat', 'lon', 'mode', 'rxCall', 'rxGrid', 'snr', 'timeIso']);
  assert.equal(dl8aam.rxCall, 'DL8AAM');
  assert.equal(dl8aam.rxGrid, 'JO42');
  assert.ok(Math.abs(dl8aam.lat - 52.5) < 1e-9 && Math.abs(dl8aam.lon - 9) < 1e-9);
  assert.equal(dl8aam.azimuth, 45);
  assert.equal(dl8aam.freqHz, 7_074_123);
  assert.equal(dl8aam.timeIso, '2026-09-12T15:46:40.000Z');
  assert.equal(w1nt.azimuth, null);
  assert.ok(w1nt.lat > 42 && w1nt.lat < 43);
  assert.equal(bad.lat, null);
  assert.deepEqual(normalizeReception(null, null), { psk: null, wspr: null });
  assert.equal(normalizeReception({ success: false }, null).psk, null);
});

// ---------------------------------------------------------------------------
// Stations
// ---------------------------------------------------------------------------

const CTY_DE = { entity: 'Fed. Rep. of Germany', primaryPrefix: 'DL', cq: 14, itu: 28, continent: 'EU', lat: 51.0, lon: 10.0, matchType: 'prefix', waeOnly: false, precision: 'entity' };

const containsPii = (value, trail = '') => {
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    if (PII_KEYS.includes(key)) return `${trail}${key}`;
    const nested = containsPii(child, `${trail}${key}.`);
    if (nested) return nested;
  }
  return null;
};

test('PII_KEYS is the contract list', () => {
  assert.deepEqual([...PII_KEYS], ['email', 'email_address', 'addr1', 'addr2', 'address', 'zip', 'zip_code', 'county', 'bio', 'data_sources', 'trustee']);
  assert.ok(Object.isFrozen(PII_KEYS));
});

test('normalizeStation: warm DH5DAX row → Station with no PII', () => {
  assert.ok(containsPii(callsignDbFixture), 'sanity: the fixture does contain PII');
  const station = normalizeStation(callsignDbFixture, CTY_DE, { baseUrl: 'https://test.hamrig.com' });
  assert.ok(station);
  assertShape(station, STATION_KEYS);
  assert.equal(containsPii(station), null, 'no PII key survives');
  const serialized = JSON.stringify(station);
  for (const key of PII_KEYS) assert.ok(!serialized.includes(`"${key}"`), key);
  assert.ok(!serialized.includes('Hoher Weg'), 'street never leaks');
  assert.ok(!serialized.includes('48599'), 'zip never leaks');

  assert.equal(station.callsign, 'DH5DAX');
  assert.equal(station.name, 'Michael Beck', 'surname-only `name` merged with first_name');
  assert.equal(station.country, 'Germany');
  assert.deepEqual(station.dxcc, { adif: 230, name: 'Germany', prefix: 'DL', continent: 'EU', cqZone: 14, ituZone: 28 });
  assert.equal(station.lat, 52.186667, 'string latitude parsed');
  assert.equal(station.lon, 7.04);
  assert.equal(station.precision, 'exact');
  assert.equal(station.grid, 'JO32me');
  assert.equal(station.city, null);
  assert.equal(station.state, null);
  assert.equal(station.imageUrl, 'https://cdn-xml.qrz.com/x/dh5dax/IMG_6130_jpeg.jpg');
  assert.equal(station.licenseClass, 'A');
  assert.equal(station.qslManager, 'direct or eqsl');
  assert.equal(station.lotw, null);
  assert.equal(station.eqsl, null);
  assert.deepEqual(station.hamrigUser, { username: 'DH5DAX', verified: true, avatarUrl: 'https://test.hamrig.com/uploads/avatars/avatar_1_1768165119.jpg' });
  assert.deepEqual(station.sources, ['callsign_database', 'cty.dat']);
});

test('normalizeStation: NOT_FOUND sentinels, stub rows, misses', () => {
  const hamdbMiss = {
    success: true,
    callsign: {
      callsign: 'NOT_FOUND', name: 'NOT_FOUND', first_name: 'NOT_FOUND', last_name: 'NOT_FOUND', country: 'NOT_FOUND', city: 'NOT_FOUND', state: 'NOT_FOUND',
      grid_square: 'NOT_FOUND', latitude: 'NOT_FOUND', longitude: 'NOT_FOUND', license_class: 'NOT_FOUND', addr1: 'NOT_FOUND', zip: 'NOT_FOUND', email: 'NOT_FOUND',
    },
    hamrig_user: { is_hamrig_user: false },
    source: 'hamdb',
  };
  assert.equal(normalizeStation(hamdbMiss, null, {}), null, 'no name, no position, no callsign → null');
  assert.equal(normalizeStation(hamdbMiss, null, { callsign: 'DL9ZZZ' }), null, 'requested callsign alone is not enough without a position');
  const requested = normalizeStation(hamdbMiss, CTY_DE, { callsign: 'dl9zzz' });
  assert.equal(requested.callsign, 'DL9ZZZ', 'options.callsign fills in when the row callsign is NOT_FOUND');
  assert.equal(requested.precision, 'entity');
  assert.equal(containsPii(requested), null);
  const hamdbMissWithCty = normalizeStation({ ...hamdbMiss, callsign: { ...hamdbMiss.callsign, callsign: 'DL9ZZZ' } }, CTY_DE, {});
  assert.ok(hamdbMissWithCty, 'cty centroid counts as a position');
  assert.equal(hamdbMissWithCty.name, null);
  assert.equal(hamdbMissWithCty.precision, 'entity');
  assert.equal(hamdbMissWithCty.lat, 51);
  assert.equal(hamdbMissWithCty.country, 'Fed. Rep. of Germany');
  assert.equal(hamdbMissWithCty.grid, null);
  assert.equal(hamdbMissWithCty.licenseClass, null);
  assert.equal(hamdbMissWithCty.hamrigUser, null);
  assert.deepEqual(hamdbMissWithCty.sources, ['hamdb', 'cty.dat']);
  assert.equal(containsPii(hamdbMissWithCty), null);

  const stub = { success: true, callsign: { callsign: 'DL9ZZZ', name: null, country: 'Germany', continent: 'EU', cq_zone: 14, itu_zone: 28, latitude: null, longitude: null, grid_square: null }, hamrig_user: { is_hamrig_user: false }, source: 'callsign_database' };
  assert.equal(normalizeStation(stub, null, {}), null, 'stub with nothing usable and no cty → null');
  const stubWithCty = normalizeStation(stub, { ...CTY_DE, precision: 'area', lat: 48.5, lon: 11.5 }, {});
  assert.equal(stubWithCty.precision, 'area');
  assert.equal(stubWithCty.lat, 48.5);

  const gridOnly = normalizeStation({ callsign: { callsign: 'dl1abc', first_name: 'Anna', last_name: 'Muster', grid_square: 'JO31', latitude: null, longitude: null, email: 'x@y.z' } }, null, {});
  assert.equal(gridOnly.callsign, 'DL1ABC');
  assert.equal(gridOnly.name, 'Anna Muster');
  assert.equal(gridOnly.precision, 'grid');
  assert.ok(Math.abs(gridOnly.lat - 51.5) < 1e-9 && Math.abs(gridOnly.lon - 7) < 1e-9);
  assert.equal(gridOnly.imageUrl, null);
  assert.equal(containsPii(gridOnly), null);
  assert.deepEqual(gridOnly.sources, []);

  const nameOnly = normalizeStation({ callsign: { callsign: 'W1AW', name: 'ARRL HQ', latitude: '999', longitude: '7' } }, null, {});
  assert.ok(nameOnly, 'a name alone keeps the row');
  assert.equal(nameOnly.lat, null, 'out-of-range latitude rejected');
  assert.equal(nameOnly.precision, null);

  const zeroIsland = normalizeStation({ callsign: { callsign: 'W1AW', name: 'x', latitude: '0', longitude: '0' } }, null, {});
  assert.equal(zeroIsland.lat, null, '0,0 is not a position');

  assert.equal(normalizeStation({ error: 'Callsign not found' }, null, {}), null);
  assert.equal(normalizeStation(null, CTY_DE, {}), null);
  assert.equal(normalizeStation({ callsign: { name: 'Nobody' } }, null, {}), null, 'no callsign → null');
});

test('normalizeStation: URLs are made absolute with the configured base', () => {
  const relative = normalizeStation({
    callsign: { callsign: 'DL1ABC', name: 'Anna', profile_image_url: '/uploads/x.jpg', latitude: '50', longitude: '8' },
    hamrig_user: { is_hamrig_user: true, username: 'anna', verified: 0, avatar_url: 'uploads/avatars/a.jpg' },
  }, null, { baseUrl: 'https://test.hamrig.com/' });
  assert.equal(relative.imageUrl, 'https://test.hamrig.com/uploads/x.jpg');
  assert.deepEqual(relative.hamrigUser, { username: 'anna', verified: false, avatarUrl: 'https://test.hamrig.com/uploads/avatars/a.jpg' });
  const defaults = normalizeStation({ callsign: { callsign: 'DL1ABC', name: 'Anna', profile_image_url: '/x.jpg', latitude: '50', longitude: '8' } }, null);
  assert.equal(defaults.imageUrl, 'https://hamrig.com/x.jpg');
});

// ---------------------------------------------------------------------------
// Propagation
// ---------------------------------------------------------------------------

test('normalizePropagation merges conditions + solar-extended + iono', () => {
  const summary = normalizePropagation({ conditions: conditionsFixture, solarExtended: solarExtendedFixture, iono: ionoFixture });
  assert.deepEqual(Object.keys(summary).sort(), ['bands', 'dayNight', 'ionosonde', 'solar', 'sources', 'updatedIso']);
  assert.deepEqual(summary.solar, {
    sfi: 110, kIndex: 2, aIndex: 8, ssn: 43.7, xrayClass: 'B3.1', solarWindKms: 411.8, bz: 3.08, auroraKpRequired: 6, geomagneticStatus: 'quiet',
  });
  assert.equal(summary.bands['20m'], 'good');
  assert.equal(Object.keys(summary.bands).length, 11);
  assert.deepEqual(summary.dayNight.AS, { status: 'night', label: 'Asia' });
  assert.deepEqual(summary.ionosonde.nearest, {
    name: 'Dourbes, Belgium', lat: 50.1, lon: 4.6, mufd: 22.6, fof2: 6.7, ageMin: 7, distanceKm: 315, highestBand: '15m',
  });
  assert.equal(summary.ionosonde.nearest.highestBand, mufFixture.nearest.highest_band, 'agrees with HamRig /api/muf');
  assert.deepEqual(summary.ionosonde.essn, { ssn: 43.7, sfi: 95.8, source: 'prop.kc2g eSSN' });
  assert.equal(summary.updatedIso, '2026-09-12T15:52:45.000Z');
  assert.deepEqual(summary.sources, ['hamrig:propagation-conditions', 'NOAA SWPC', 'GIRO ionosondes via prop.kc2g · eSSN prop.kc2g']);
});

test('normalizePropagation: every input is optional', () => {
  const empty = normalizePropagation({});
  assert.deepEqual(empty.solar, { sfi: null, kIndex: null, aIndex: null, ssn: null, xrayClass: null, solarWindKms: null, bz: null, auroraKpRequired: null, geomagneticStatus: null });
  assert.deepEqual(empty.bands, {});
  assert.deepEqual(empty.dayNight, {});
  assert.deepEqual(empty.ionosonde, { nearest: null, essn: null });
  assert.equal(empty.updatedIso, null);
  assert.deepEqual(empty.sources, []);
  const onlyExt = normalizePropagation({ solarExtended: { data: { kindex: { kp: 4, status: 'unsettled' }, xray: { class: 'C', magnitude: '2.0' } } } });
  assert.equal(onlyExt.solar.kIndex, 4, 'kp fallback when conditions are missing');
  assert.equal(onlyExt.solar.xrayClass, 'C2.0');
  assert.equal(onlyExt.solar.sfi, null, 'solarflux.flux null stays null');
  assert.equal(onlyExt.solar.bz, null);
  assert.deepEqual(onlyExt.sources, ['hamrig:solar-extended']);
  assert.equal(normalizePropagation().solar.sfi, null);
});

// ---------------------------------------------------------------------------
// VHF beacons, DXCC status, worked grids, rotators
// ---------------------------------------------------------------------------

test('normalizeVhfBeacons', () => {
  const payload = {
    success: true, updated: '2026-09-12T15:50:00+00:00', count: 3,
    beacons: [
      { call: 'DB0FAI', freq_khz: 144460, band: '2m', locator: 'JN58QH', lat: 48.3, lon: 11.4, location: 'Munich', sources: ['beaconspot'], updated_at: '2026-09-01', last_heard: { at: '2026-09-12T14:10:00+00:00', spotter: 'DL1ABC', snr: 12, freq_khz: 144460, source: 'pskr' } },
      { call: 'GB3VHF', freq_khz: 144430, band: '2m', locator: 'JO01EH', lat: null, lon: null, location: 'Kent', sources: [], updated_at: null, last_heard: null },
      { call: 'NOPOS', freq_khz: 144400, band: '2m', locator: '-', lat: null, lon: null },
      { call: '', freq_khz: 144400 },
    ],
  };
  const beacons = normalizeVhfBeacons(payload);
  assert.equal(beacons.length, 2);
  assert.deepEqual(beacons[0], {
    call: 'DB0FAI', freqHz: 144_460_000, band: '2m', locator: 'JN58QH', lat: 48.3, lon: 11.4, location: 'Munich',
    lastHeard: { atIso: '2026-09-12T14:10:00.000Z', spotter: 'DL1ABC', snr: 12 },
  });
  assert.equal(beacons[1].lastHeard, null);
  assert.ok(Math.abs(beacons[1].lat - 51.3125) < 1e-6 && Math.abs(beacons[1].lon - 0.375) < 1e-6, 'JO01EH centre');
  assert.deepEqual(normalizeVhfBeacons({ error: 'Unauthorized' }), []);
  assert.deepEqual(normalizeVhfBeacons(null), []);
});

test('normalizeDxccStatus + normalizeWorkedGrids', () => {
  const entities = normalizeDxccStatus({
    success: true, worked: 1, total: 2, scoped: 'all',
    entities: [
      { adif: 230, name: 'Fed. Rep. of Germany', prefix: 'DL', cont: 'EU', cqz: 14, lat: 51, lon: 10, worked: 1, bands: ['20m', '40m'] },
      { adif: 291, name: 'United States', prefix: 'K', cont: 'NA', cqz: 5, lat: 37.5, lon: -97.5, worked: 0, bands: [] },
      { adif: 1, name: 'Canada', prefix: 'VE', cont: 'NA', cqz: 5, lat: null, lon: null, worked: 0 },
    ],
  });
  assert.deepEqual(entities, [
    { adif: 230, name: 'Fed. Rep. of Germany', prefix: 'DL', continent: 'EU', cq: 14, lat: 51, lon: 10, worked: true, bands: ['20m', '40m'] },
    { adif: 291, name: 'United States', prefix: 'K', continent: 'NA', cq: 5, lat: 37.5, lon: -97.5, worked: false, bands: [] },
  ]);
  assert.deepEqual(normalizeDxccStatus(null), []);

  const grids = normalizeWorkedGrids({ success: true, total: 3, grids: [
    { grid: 'JO32', qsos: 12, lat: 52.5, lon: 7 },
    { grid: 'fn42', qsos: '3', lat: null, lon: null },
    { grid: '', qsos: 1 },
  ] });
  assert.deepEqual(grids[0], { grid: 'JO32', qsos: 12, lat: 52.5, lon: 7 });
  assert.equal(grids[1].grid, 'FN42');
  assert.equal(grids[1].qsos, 3);
  assert.ok(Math.abs(grids[1].lat - 42.5) < 1e-9 && Math.abs(grids[1].lon - (-71)) < 1e-9, 'centre from the grid when lat/lon missing');
  assert.equal(grids.length, 2);
  assert.deepEqual(normalizeWorkedGrids(undefined), []);
});

test('normalizeRotators strips gateway_key, merges live status, parses decimal strings', () => {
  const rotators = normalizeRotators(rotatorsFixture.list, rotatorsFixture.statuses);
  assert.equal(rotators.length, 2);
  for (const r of rotators) assertShape(r, ROTATOR_KEYS);
  const serialized = JSON.stringify(rotators);
  assert.ok(!serialized.includes('gateway_key'));
  assert.ok(!serialized.includes('gk_SECRET'));

  const tower = rotators[0];
  assert.equal(tower.id, 7);
  assert.equal(tower.name, 'Tower rotor');
  assert.equal(tower.model, 'Yaesu G-1000DXC');
  assert.equal(tower.lat, 52.186667);
  assert.equal(tower.lon, 7.04);
  assert.equal(tower.grid, 'JO32me');
  assert.equal(tower.azimuth, 120, 'live /status wins over the list row');
  assert.equal(tower.targetAzimuth, 180);
  assert.equal(tower.elevation, 0);
  assert.equal(tower.isMoving, true);
  assert.equal(tower.status, 'online');
  assert.equal(tower.online, true);
  assert.equal(tower.lastSeenIso, '2026-09-12T15:54:30.000Z');
  assert.deepEqual(tower.bands, ['20m', '15m', '10m']);

  const portable = rotators[1];
  assert.equal(portable.name, 'Rotator 8');
  assert.equal(portable.azimuth, 270);
  assert.equal(portable.elevation, 10);
  assert.equal(portable.targetAzimuth, 300);
  assert.equal(portable.isMoving, true);
  assert.equal(portable.status, 'offline');
  assert.equal(portable.online, false);
  assert.equal(portable.lastSeenIso, null);
  assert.ok(Math.abs(portable.lat - 51.5) < 1e-9 && Math.abs(portable.lon - 7) < 1e-9, 'JO31 centre when location_lat/lng are null');
  assert.deepEqual(portable.bands, []);

  const viaMap = normalizeRotators(rotatorsFixture.list, new Map([[7, { current_azimuth: 33 }]]));
  assert.equal(viaMap[0].azimuth, 33);
  const noStatus = normalizeRotators(rotatorsFixture.list);
  assert.equal(noStatus[0].azimuth, 95.5);
  assert.equal(noStatus[0].isMoving, false);
  assert.equal(noStatus[0].lastSeenIso, '2026-09-12T15:52:01.000Z');
  assert.deepEqual(normalizeRotators(null), []);
  assert.deepEqual(normalizeRotators({ error: 'Unauthorized' }), []);
});
