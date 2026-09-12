import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACTIVATION_BANDS,
  ACTIVATION_BAND_FILTERS,
  ACTIVATION_PROGRAMS,
  DEFAULT_ACTIVATION_FILTER,
  activationAgeStyle,
  activationDetail,
  activationLabel,
  activationMatchesFilter,
  dedupeActivations,
  filterActivations,
  frameRadiusM,
  freezeActivation,
  isFreshActivation,
  isValidActivation,
  nearestActivations,
  normalizeActivationFilter,
  normalizeProgram,
  programColor,
  resolveActivation,
  sortActivationsNewestFirst,
  spiralOffsetKm,
  spreadCoincidentPositions,
  summarizeActivations,
  trimActivationItems,
} from './hamActivationsLogic.js';
import { PROGRAM_COLORS, distanceKm } from './hamRadioShared.js';

const NOW = Date.parse('2026-09-12T16:00:00Z');
const minutesAgo = (minutes) => new Date(NOW - minutes * 60_000).toISOString();

/** Broker rows in the contract's `Activation` shape (trimmed from the live fixtures). */
function row(overrides = {}) {
  return {
    id: 'pota:56621705',
    program: 'POTA',
    callsign: 'K5SJC',
    reference: 'US-4404',
    name: 'Pike National Forest',
    freqHz: 14_047_500,
    band: '20m',
    mode: 'CW',
    timeIso: minutesAgo(8),
    spotter: 'TI7W',
    comments: 'RBN 23 dB 28 WPM via TI7W-#',
    lat: 39.2,
    lon: -105.3,
    precision: 'exact',
    locator: 'DM78aq',
    country: 'US',
    altitudeM: null,
    points: null,
    url: 'https://pota.app/#/park/US-4404',
    ...overrides,
  };
}

const ROWS = [
  row(),
  row({ id: 'pota:56621413', callsign: 'F5MQU/P', reference: 'FR-7356', name: 'Carrieres souterraines de Chichee', freqHz: 7_024_000, band: '40m', timeIso: minutesAgo(3), lat: 47.796, lon: 3.823, country: 'FR' }),
  row({ id: 'sota:389141', program: 'SOTA', callsign: 'K2CPT', reference: 'W2/GA-212', name: 'Azure Mountain', freqHz: 14_309_000, band: '20m', mode: 'SSB', timeIso: minutesAgo(11), lat: 44.5411, lon: -74.501, altitudeM: 765, points: 1, url: 'https://sotl.as/summits/W2/GA-212' }),
  row({ id: 'sota:389140', program: 'SOTA', callsign: 'OE3VBU/6', reference: 'OE/ST-365', name: 'Schiffall', freqHz: 7_028_700, band: '40m', timeIso: minutesAgo(12), lat: 47.3119, lon: 15.34, altitudeM: 1221, points: 4 }),
  row({ id: 'wwff:1', program: 'WWFF', callsign: 'DL1ABC', reference: 'DLFF-0001', name: 'Bayerischer Wald', freqHz: 14_244_000, band: '20m', mode: 'SSB', timeIso: minutesAgo(40), lat: 49.0, lon: 13.0, precision: 'grid', locator: 'JN69', country: 'DL', url: null }),
  row({ id: 'bota:9', program: 'BOTA', callsign: 'G4XYZ', reference: 'B/G-0123', name: 'Pillbox', freqHz: 145_500_000, band: '2m', mode: 'FM', timeIso: minutesAgo(70), lat: 51.5, lon: -0.1, country: 'G' }),
].map(freezeActivation);

test('constants expose the four programs, the band list and the default filter', () => {
  assert.deepEqual([...ACTIVATION_PROGRAMS], ['POTA', 'SOTA', 'WWFF', 'BOTA']);
  assert.equal(ACTIVATION_BAND_FILTERS[0].id, 'all');
  assert.equal(ACTIVATION_BAND_FILTERS.length, ACTIVATION_BANDS.length + 1);
  assert.deepEqual([...DEFAULT_ACTIVATION_FILTER.programs], ['POTA', 'SOTA', 'WWFF', 'BOTA']);
  assert.equal(DEFAULT_ACTIVATION_FILTER.band, 'all');
});

test('normalizeProgram and programColor follow the shared program palette', () => {
  assert.equal(normalizeProgram('pota'), 'POTA');
  assert.equal(normalizeProgram(' Sota '), 'SOTA');
  assert.equal(normalizeProgram('iota'), null);
  assert.equal(programColor('POTA'), PROGRAM_COLORS.POTA);
  assert.equal(programColor('sota'), '#f97316');
  assert.equal(programColor('wwff'), '#22c55e');
  assert.equal(programColor('bota'), '#2dd4bf');
  assert.equal(programColor('nope'), '#9aa4b2');
});

test('isValidActivation rejects rows that are missing what the layer renders', () => {
  assert.equal(isValidActivation(row()), true);
  assert.equal(isValidActivation(null), false);
  assert.equal(isValidActivation(row({ id: '' })), false);
  assert.equal(isValidActivation(row({ program: 'IOTA' })), false);
  assert.equal(isValidActivation(row({ callsign: 'K5' })), false);
  assert.equal(isValidActivation(row({ callsign: 'BAD CALL' })), false);
  assert.equal(isValidActivation(row({ reference: null })), false);
  assert.equal(isValidActivation(row({ freqHz: null })), false);
  assert.equal(isValidActivation(row({ freqHz: 0 })), false);
  assert.equal(isValidActivation(row({ lat: null })), false);
  assert.equal(isValidActivation(row({ lat: 0, lon: 0 })), false);
  assert.equal(isValidActivation(row({ lat: 91 })), false);
  assert.equal(isValidActivation(row({ lon: '-105.3' })), true);
});

test('freezeActivation cleans, upper-cases and freezes a row', () => {
  const frozen = freezeActivation(row({
    callsign: ' k5sjc ',
    reference: 'us-4404',
    name: 'Pike National\n Forest',
    mode: 'cw',
    band: '',
    lat: '39.2',
    lon: '-105.3',
    precision: 'grid',
    url: 'javascript:alert(1)',
    altitudeM: '765',
    timeIso: '2026-09-12T15:52:16',
  }));
  assert.equal(Object.isFrozen(frozen), true);
  assert.equal(frozen.callsign, 'K5SJC');
  assert.equal(frozen.reference, 'US-4404');
  assert.equal(frozen.name, 'Pike National Forest');
  assert.equal(frozen.mode, 'CW');
  assert.equal(frozen.band, '20m');
  assert.equal(frozen.lat, 39.2);
  assert.equal(frozen.lon, -105.3);
  assert.equal(frozen.precision, 'grid');
  assert.equal(frozen.url, null);
  assert.equal(frozen.altitudeM, 765);
  assert.equal(frozen.timeIso, '2026-09-12T15:52:16.000Z');
  assert.equal(freezeActivation(row({ timeIso: 'garbage' })).timeIso, null);
  assert.equal(freezeActivation(row({ precision: 'exact' })).precision, 'exact');
});

test('isFreshActivation drops rows older than the max age but keeps undated rows', () => {
  assert.equal(isFreshActivation(ROWS[0], NOW), true);
  assert.equal(isFreshActivation(freezeActivation(row({ timeIso: minutesAgo(200) })), NOW), false);
  assert.equal(isFreshActivation(freezeActivation(row({ timeIso: minutesAgo(200) })), NOW, 4 * 60 * 60 * 1000), true);
  assert.equal(isFreshActivation(freezeActivation(row({ timeIso: null })), NOW), true);
});

test('sortActivationsNewestFirst and dedupeActivations keep the newest spot per activation', () => {
  const sorted = sortActivationsNewestFirst(ROWS);
  assert.deepEqual(sorted.map((a) => a.id), ['pota:56621413', 'pota:56621705', 'sota:389141', 'sota:389140', 'wwff:1', 'bota:9']);
  const older = freezeActivation(row({ id: 'pota:1', timeIso: minutesAgo(30), spotter: 'OLD' }));
  const newer = freezeActivation(row({ id: 'pota:2', timeIso: minutesAgo(1), spotter: 'NEW' }));
  const otherRef = freezeActivation(row({ id: 'pota:3', reference: 'US-0001', timeIso: minutesAgo(5) }));
  const deduped = dedupeActivations([older, otherRef, newer]);
  assert.deepEqual(deduped.map((a) => a.id), ['pota:2', 'pota:3']);
  assert.equal(deduped[0].spotter, 'NEW');
  const undated = freezeActivation(row({ id: 'pota:u', timeIso: null }));
  assert.equal(sortActivationsNewestFirst([undated, newer]).at(-1).id, 'pota:u');
});

test('normalizeActivationFilter accepts Sets, arrays, strings and the singular program key', () => {
  const current = { programs: new Set(['POTA', 'SOTA']), band: '20m' };
  assert.deepEqual([...normalizeActivationFilter({ programs: new Set(['wwff']) }, current).programs], ['WWFF']);
  assert.deepEqual([...normalizeActivationFilter({ programs: ['bota', 'pota'] }, current).programs], ['POTA', 'BOTA']);
  assert.deepEqual([...normalizeActivationFilter({ programs: 'sota,wwff' }, current).programs], ['SOTA', 'WWFF']);
  assert.deepEqual([...normalizeActivationFilter({ programs: 'all' }, current).programs], ['POTA', 'SOTA', 'WWFF', 'BOTA']);
  assert.deepEqual([...normalizeActivationFilter({ program: 'pota' }, current).programs], ['POTA']);
  assert.deepEqual([...normalizeActivationFilter({ program: 'all' }, current).programs], ['POTA', 'SOTA', 'WWFF', 'BOTA']);
  // unknown names leave the current selection alone; explicit empty hides everything
  assert.deepEqual([...normalizeActivationFilter({ programs: ['iota'] }, current).programs], ['POTA', 'SOTA']);
  assert.deepEqual([...normalizeActivationFilter({ programs: [] }, current).programs], []);
  // band handling
  assert.equal(normalizeActivationFilter({}, current).band, '20m');
  assert.equal(normalizeActivationFilter({ band: '40M' }, current).band, '40m');
  assert.equal(normalizeActivationFilter({ band: 'all' }, current).band, 'all');
  assert.equal(normalizeActivationFilter({ band: '' }, current).band, 'all');
  assert.equal(normalizeActivationFilter({ band: '13cm' }, current).band, '20m');
  // never mutates the input filter and tolerates junk
  assert.deepEqual([...current.programs], ['POTA', 'SOTA']);
  assert.deepEqual([...normalizeActivationFilter(null, undefined).programs], ['POTA', 'SOTA', 'WWFF', 'BOTA']);
  assert.equal(normalizeActivationFilter('junk', { programs: 'not a set', band: 'x' }).band, 'all');
});

test('activationMatchesFilter and filterActivations apply program and band', () => {
  const potaOnly = normalizeActivationFilter({ programs: ['pota'] });
  assert.deepEqual(filterActivations(ROWS, potaOnly).map((a) => a.id), ['pota:56621705', 'pota:56621413']);
  const twenty = normalizeActivationFilter({ band: '20m' });
  assert.deepEqual(filterActivations(ROWS, twenty).map((a) => a.program), ['POTA', 'SOTA', 'WWFF']);
  const sota40 = normalizeActivationFilter({ programs: 'sota', band: '40m' });
  assert.deepEqual(filterActivations(ROWS, sota40).map((a) => a.callsign), ['OE3VBU/6']);
  assert.equal(activationMatchesFilter(ROWS[0]), true);
  assert.equal(activationMatchesFilter(null), false);
  assert.equal(activationMatchesFilter(ROWS[0], { programs: 'broken', band: 'all' }), true);
  assert.equal(filterActivations(ROWS, normalizeActivationFilter({ programs: [] })).length, 0);
});

test('activationAgeStyle shrinks and fades linearly over the fade window', () => {
  assert.deepEqual(activationAgeStyle(minutesAgo(0), NOW), { pixelSize: 11, alpha: 1, ageMin: 0 });
  const half = activationAgeStyle(minutesAgo(30), NOW);
  assert.equal(half.pixelSize, 9);
  assert.equal(half.alpha, 0.725);
  assert.equal(half.ageMin, 30);
  assert.deepEqual(activationAgeStyle(minutesAgo(60), NOW), { pixelSize: 7, alpha: 0.45, ageMin: 60 });
  assert.deepEqual(activationAgeStyle(minutesAgo(600), NOW), { pixelSize: 7, alpha: 0.45, ageMin: 600 });
  // future timestamps clamp to fresh; undated rows render faded
  assert.equal(activationAgeStyle(minutesAgo(-5), NOW).pixelSize, 11);
  assert.deepEqual(activationAgeStyle(null, NOW), { pixelSize: 7, alpha: 0.45, ageMin: null });
  const custom = activationAgeStyle(minutesAgo(10), NOW, { fadeMinutes: 20, maxSize: 20, minSize: 10, maxAlpha: 0.8, minAlpha: 0.2 });
  assert.deepEqual(custom, { pixelSize: 15, alpha: 0.5, ageMin: 10 });
});

test('spiralOffsetKm is deterministic, zero at index 0 and capped', () => {
  assert.deepEqual(spiralOffsetKm(0), { eastKm: 0, northKm: 0 });
  const a = spiralOffsetKm(3);
  const b = spiralOffsetKm(3);
  assert.deepEqual(a, b);
  assert.ok(Math.hypot(a.eastKm, a.northKm) > 0);
  const far = spiralOffsetKm(500, { stepKm: 1, maxKm: 3 });
  assert.ok(Math.abs(Math.hypot(far.eastKm, far.northKm) - 3) < 1e-9);
  assert.notDeepEqual(spiralOffsetKm(1), spiralOffsetKm(2));
  assert.deepEqual(spiralOffsetKm(-4), { eastKm: 0, northKm: 0 });
  assert.deepEqual(spiralOffsetKm('nope'), { eastKm: 0, northKm: 0 });
});

test('spreadCoincidentPositions keeps lone markers in place and spirals piles by id order', () => {
  const pile = [
    { id: 'c', lat: 47.3119, lon: 15.34 },
    { id: 'a', lat: 47.3119, lon: 15.34 },
    { id: 'b', lat: 47.3119, lon: 15.34 },
    { id: 'lone', lat: 10, lon: 20 },
    { id: 'bad', lat: null, lon: 20 },
  ];
  const positions = spreadCoincidentPositions(pile);
  assert.equal(positions.size, 4);
  assert.deepEqual(positions.get('lone'), { lat: 10, lon: 20, offset: false });
  assert.deepEqual(positions.get('a'), { lat: 47.3119, lon: 15.34, offset: false });
  const b = positions.get('b');
  const c = positions.get('c');
  assert.equal(b.offset, true);
  assert.equal(c.offset, true);
  const kmB = distanceKm({ lat: 47.3119, lon: 15.34 }, b);
  const kmC = distanceKm({ lat: 47.3119, lon: 15.34 }, c);
  assert.ok(kmB > 0.05 && kmB <= 3.01, `b offset ${kmB} km`);
  assert.ok(kmC > 0.05 && kmC <= 3.01, `c offset ${kmC} km`);
  assert.ok(distanceKm(b, c) > 0.05);
  // same result regardless of input order
  const shuffled = spreadCoincidentPositions([pile[1], pile[2], pile[0]]);
  assert.deepEqual(shuffled.get('b'), b);
  assert.deepEqual(shuffled.get('c'), c);
  // larger step/cap for entity-centroid piles, and dateline wrap
  const wide = spreadCoincidentPositions([{ id: 'x', lat: 0, lon: 179.999 }, { id: 'y', lat: 0, lon: 179.999 }], { stepKm: 60, maxKm: 60 });
  const y = wide.get('y');
  assert.ok(Math.abs(y.lon) <= 180);
  assert.ok(distanceKm({ lat: 0, lon: 179.999 }, y) <= 60.5);
});

test('activationLabel and activationDetail build the map label lines', () => {
  assert.equal(activationLabel(ROWS[0]), 'K5SJC US-4404');
  assert.equal(activationLabel(null), '');
  assert.equal(activationDetail(ROWS[0], NOW), 'POTA · Pike National Forest · 14047.5 kHz CW · 8 min');
  assert.equal(activationDetail(ROWS[5], NOW), 'BOTA · Pillbox · 145.500 MHz FM · 1 h');
  const bare = freezeActivation(row({ name: '', mode: null, timeIso: null }));
  assert.equal(activationDetail(bare, NOW), 'POTA · 14047.5 kHz');
});

test('resolveActivation matches id, callsign (with or without suffix), reference and words', () => {
  assert.equal(resolveActivation(ROWS, 'SOTA:389141').id, 'sota:389141');
  assert.equal(resolveActivation(ROWS, 'k5sjc').id, 'pota:56621705');
  assert.equal(resolveActivation(ROWS, 'f5mqu').id, 'pota:56621413');
  assert.equal(resolveActivation(ROWS, 'F5MQU/P').id, 'pota:56621413');
  assert.equal(resolveActivation(ROWS, 'oe3vbu/p').id, 'sota:389140');
  assert.equal(resolveActivation(ROWS, 'w2/ga-212').id, 'sota:389141');
  assert.equal(resolveActivation(ROWS, 'azure mountain').id, 'sota:389141');
  assert.equal(resolveActivation(ROWS, 'schiffall sota').id, 'sota:389140');
  assert.equal(resolveActivation(ROWS, 'nothing here'), null);
  assert.equal(resolveActivation(ROWS, ''), null);
  assert.equal(resolveActivation(ROWS, null), null);
  // the newest match wins when several activations share a callsign
  const older = freezeActivation(row({ id: 'pota:old', reference: 'US-0002', timeIso: minutesAgo(50) }));
  assert.equal(resolveActivation([older, ...ROWS], 'K5SJC').id, 'pota:56621705');
});

test('nearestActivations sorts by distance and attaches km', () => {
  const near = nearestActivations(ROWS, 48.2, 16.4, 3);
  assert.deepEqual(near.map((entry) => entry.activation.id), ['sota:389140', 'wwff:1', 'pota:56621413']);
  assert.ok(near[0].distanceKm < 150 && near[0].distanceKm > 50);
  assert.ok(near[0].distanceKm < near[1].distanceKm && near[1].distanceKm < near[2].distanceKm);
  assert.equal(nearestActivations(ROWS, 48.2, 16.4).length, 5);
  assert.equal(nearestActivations(ROWS, 48.2, 16.4, 0).length, 1);
  assert.deepEqual(nearestActivations(ROWS, 'x', 16.4, 3), []);
  assert.deepEqual(nearestActivations(ROWS, 95, 16.4, 3), []);
  assert.deepEqual(nearestActivations([], 48, 16, 3), []);
});

test('trimActivationItems caps the snapshot list newest first', () => {
  const trimmed = trimActivationItems(ROWS, 2);
  assert.deepEqual(trimmed.map((a) => a.id), ['pota:56621413', 'pota:56621705']);
  assert.equal(trimActivationItems(ROWS).length, ROWS.length);
  assert.equal(trimActivationItems(ROWS, 0).length, 0);
  assert.equal(trimActivationItems(ROWS, 'x').length, 0);
});

test('summarizeActivations counts programs and bands', () => {
  const summary = summarizeActivations(ROWS);
  assert.equal(summary.total, 6);
  assert.deepEqual(summary.byProgram, { POTA: 2, SOTA: 2, WWFF: 1, BOTA: 1 });
  assert.deepEqual(summary.byBand, { '20m': 3, '40m': 2, '2m': 1 });
  assert.deepEqual(summarizeActivations([]).byProgram, { POTA: 0, SOTA: 0, WWFF: 0, BOTA: 0 });
});

test('frameRadiusM pads the bounding sphere and enforces a minimum', () => {
  assert.equal(frameRadiusM(100_000), 160_000);
  assert.equal(frameRadiusM(1_000), 60_000);
  assert.equal(frameRadiusM(NaN), 60_000);
  assert.equal(frameRadiusM(500_000, { padding: 1.2, minM: 10 }), 600_000);
});
