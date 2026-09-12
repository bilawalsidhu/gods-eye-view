import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_DXPEDITION_FILTER,
  DXPEDITION_COLORS,
  DXPEDITION_SPREAD,
  DXPEDITION_STATUSES,
  DXPEDITION_STATUS_FILTERS,
  MOST_WANTED_TOP_RANK,
  dxpeditionDays,
  dxpeditionDetail,
  dxpeditionDisplayPositions,
  dxpeditionLabel,
  dxpeditionMatchesFilter,
  dxpeditionStyle,
  effectiveStatus,
  filterDxpeditions,
  formatShortDate,
  freezeDxpedition,
  isMostWanted,
  isValidDxpedition,
  normalizeDxpeditionFilter,
  normalizeDxpeditionStatus,
  rankBucket,
  resolveDxpedition,
  sortDxpeditions,
  summarizeDxpeditions,
  trimDxpeditionItems,
} from './dxpeditionsLogic.js';
import { distanceKm } from './hamRadioShared.js';

const NOW = Date.parse('2026-09-12T16:00:00Z');
const DAY = 86_400_000;
const daysFromNow = (days) => new Date(NOW + days * DAY).toISOString();

/** Broker rows in the contract's `Dxpedition` shape (values from the live NG3K / most-wanted fixtures). */
function row(overrides = {}) {
  return {
    id: 'dxped:V51WH:1787616000',
    callsign: 'V51WH',
    entity: 'Namibia',
    adif: 278,
    continent: 'AF',
    lat: -22.0,
    lon: 17.0,
    precision: 'entity',
    startIso: '2026-08-25T00:00:00.000Z',
    endIso: '2026-10-10T00:00:00.000Z',
    status: 'active',
    daysUntil: null,
    qslVia: 'DK2WH',
    info: 'By DK2WH fm nr Omaruru; 160-6m, incl 60m; QRV as V55Y in CQWW RTTY Contest',
    url: null,
    iota: null,
    mostWantedRank: 224,
    bands: ['160m', '80m', '20m'],
    modes: ['RTTY'],
    ...overrides,
  };
}

const ROWS = [
  row(),
  row({ id: 'dxped:RI1FJZ:1', callsign: 'RI1FJZ', entity: 'Franz Josef Land', adif: 232, continent: 'EU', lat: 80.6, lon: 58.0, endIso: '2026-09-25T00:00:00.000Z', qslVia: 'LoTW', mostWantedRank: 55, iota: 'EU-019', info: 'By RA1ZZ R9LR fm IOTA EU-019; 160-10m; CW SSB FT8' }),
  row({ id: 'dxped:TF:2', callsign: 'TF', entity: 'Iceland', adif: 242, continent: 'EU', lat: 65.0, lon: -18.0, startIso: '2026-08-30T00:00:00.000Z', endIso: '2026-09-13T00:00:00.000Z', qslVia: 'LoTW', mostWantedRank: null, info: "By DA6IC as TF/DA6IC/p fm Iceland's Ring Road; focus on 40 15 10m; SSB, FT8 FT4" }),
  row({ id: 'dxped:TF:3', callsign: 'TF', entity: 'Iceland', adif: 242, continent: 'EU', lat: 65.0, lon: -18.0, startIso: daysFromNow(3), endIso: daysFromNow(9), status: 'upcoming', daysUntil: 3, qslVia: 'LoTW', mostWantedRank: null, info: 'By G0XYZ as TF/G0XYZ fm Reykjavik; HF; SSB' }),
  row({ id: 'dxped:VP5:4', callsign: 'VP5', entity: 'Turks & Caicos', adif: 295, continent: 'NA', lat: 21.8, lon: -71.8, startIso: daysFromNow(6), endIso: daysFromNow(11), status: 'upcoming', daysUntil: 6, qslVia: 'LoTW', mostWantedRank: 70, info: 'By K5UR as VP5/K5UR from Providenciales I (IOTA NA-002)' }),
  row({ id: 'dxped:3Y0K:5', callsign: '3Y0K', entity: 'Bouvet', adif: 24, continent: 'AF', lat: -54.4, lon: 3.4, startIso: daysFromNow(40), endIso: daysFromNow(60), status: 'upcoming', daysUntil: 40, qslVia: 'M0OXO OQRS', mostWantedRank: 2, info: 'Bouvet Island DXpedition; 160-6m; CW SSB FT8' }),
  row({ id: 'dxped:J3:6', callsign: 'J3', entity: 'Grenada', adif: 77, continent: 'NA', lat: 12.1, lon: -61.7, startIso: '2026-09-01T00:00:00.000Z', endIso: '2026-09-05T00:00:00.000Z', status: 'active', qslVia: 'LoTW', mostWantedRank: null, iota: 'NA-024', info: 'By MM8IJU as J38LD fm IOTA NA-024' }),
  row({ id: 'dxped:9N:7', callsign: '9N', entity: 'Nepal', adif: 369, continent: 'AS', lat: null, lon: null, startIso: daysFromNow(1), endIso: daysFromNow(12), status: 'upcoming', daysUntil: 1, mostWantedRank: null, info: 'By JA1XYZ as 9N7XY fm Kathmandu' }),
].map(freezeDxpedition);

test('constants expose statuses, filters, the top rank and the colours', () => {
  assert.deepEqual([...DXPEDITION_STATUSES], ['active', 'upcoming', 'ended']);
  assert.deepEqual(DXPEDITION_STATUS_FILTERS.map((row) => row.id), ['all', 'active', 'upcoming']);
  assert.equal(MOST_WANTED_TOP_RANK, 20);
  assert.equal(DXPEDITION_COLORS.wanted, '#f472b6');
  assert.equal(DXPEDITION_COLORS.regular, '#a78bfa');
  assert.deepEqual({ ...DEFAULT_DXPEDITION_FILTER }, { status: 'all', mostWantedOnly: false });
  assert.equal(DXPEDITION_SPREAD.maxKm, 60);
});

test('normalizeDxpeditionStatus maps upstream words', () => {
  assert.equal(normalizeDxpeditionStatus('Active'), 'active');
  assert.equal(normalizeDxpeditionStatus('past'), 'ended');
  assert.equal(normalizeDxpeditionStatus('ended'), 'ended');
  assert.equal(normalizeDxpeditionStatus('soon'), null);
});

test('isValidDxpedition accepts unlocated rows but rejects broken ones', () => {
  assert.equal(isValidDxpedition(row()), true);
  assert.equal(isValidDxpedition(row({ lat: null, lon: null })), true);
  assert.equal(isValidDxpedition(row({ lat: 91, lon: 0 })), false);
  assert.equal(isValidDxpedition(row({ lat: 0, lon: 0 })), false);
  assert.equal(isValidDxpedition(row({ lat: 10, lon: null })), false);
  assert.equal(isValidDxpedition(row({ callsign: 'bad call' })), false);
  assert.equal(isValidDxpedition(row({ callsign: '' })), false);
  assert.equal(isValidDxpedition(row({ id: '' })), false);
  assert.equal(isValidDxpedition(row({ status: 'weird', startIso: null, endIso: null })), false);
  assert.equal(isValidDxpedition(row({ status: null, startIso: null, endIso: '2026-10-10T00:00:00Z' })), true);
  assert.equal(isValidDxpedition(null), false);
});

test('freezeDxpedition cleans and freezes a row, marking located and rank', () => {
  const frozen = freezeDxpedition(row({
    callsign: ' tf ',
    entity: ' Iceland\n',
    continent: 'eu',
    lat: '65.0',
    lon: '-18.0',
    startIso: '2026-08-30T00:00:00',
    status: 'past',
    daysUntil: '3.4',
    qslVia: 'LoTW)',
    url: 'ftp://nope',
    iota: 'eu-021',
    mostWantedRank: '0',
    bands: ['40m', '', null, '15m'],
    modes: 'SSB',
  }));
  assert.equal(Object.isFrozen(frozen), true);
  assert.equal(frozen.callsign, 'TF');
  assert.equal(frozen.entity, 'Iceland');
  assert.equal(frozen.continent, 'EU');
  assert.equal(frozen.lat, 65);
  assert.equal(frozen.lon, -18);
  assert.equal(frozen.located, true);
  assert.equal(frozen.precision, 'entity');
  assert.equal(frozen.startIso, '2026-08-30T00:00:00.000Z');
  assert.equal(frozen.status, 'ended');
  assert.equal(frozen.daysUntil, 3);
  assert.equal(frozen.qslVia, 'LoTW)');
  assert.equal(frozen.url, null);
  assert.equal(frozen.iota, 'EU-021');
  assert.equal(frozen.mostWantedRank, null);
  assert.deepEqual([...frozen.bands], ['40m', '15m']);
  assert.deepEqual([...frozen.modes], []);
  const unlocated = freezeDxpedition(row({ lat: null, lon: null }));
  assert.equal(unlocated.located, false);
  assert.equal(unlocated.lat, null);
  assert.equal(freezeDxpedition(row({ url: 'https://www.qrz.com/db/D44TWO' })).url, 'https://www.qrz.com/db/D44TWO');
  assert.equal(freezeDxpedition(row({ status: 'nonsense' })).status, 'upcoming');
});

test('effectiveStatus recomputes from the dates and tolerates missing ones', () => {
  assert.equal(effectiveStatus(ROWS[0], NOW), 'active');
  assert.equal(effectiveStatus(ROWS[3], NOW), 'upcoming');
  assert.equal(effectiveStatus(ROWS[6], NOW), 'ended');
  // an operation stays active through the whole UTC end day
  const endsToday = freezeDxpedition(row({ startIso: daysFromNow(-5), endIso: '2026-09-12T00:00:00Z' }));
  assert.equal(effectiveStatus(endsToday, NOW), 'active');
  assert.equal(effectiveStatus(endsToday, Date.parse('2026-09-13T00:00:00Z')), 'ended');
  // one minute before the start it is still upcoming
  const starting = freezeDxpedition(row({ startIso: new Date(NOW + 60_000).toISOString(), endIso: daysFromNow(3), status: 'active' }));
  assert.equal(effectiveStatus(starting, NOW), 'upcoming');
  // without dates the upstream flag decides
  assert.equal(effectiveStatus(freezeDxpedition(row({ startIso: null, endIso: null, status: 'active' })), NOW), 'active');
  assert.equal(effectiveStatus(freezeDxpedition(row({ startIso: null, endIso: null, status: 'past' })), NOW), 'ended');
  assert.equal(effectiveStatus(freezeDxpedition(row({ startIso: daysFromNow(-1), endIso: null, status: 'upcoming' })), NOW), 'active');
  assert.equal(effectiveStatus(null, NOW), 'upcoming');
});

test('dxpeditionDays counts whole days to start and end', () => {
  assert.deepEqual(dxpeditionDays(ROWS[4], NOW), { daysUntilStart: 6, daysUntilEnd: 11 });
  const days = dxpeditionDays(ROWS[0], NOW);
  assert.ok(days.daysUntilStart < 0);
  assert.equal(days.daysUntilEnd, 28);
  assert.deepEqual(dxpeditionDays(freezeDxpedition(row({ startIso: null, endIso: null })), NOW), { daysUntilStart: null, daysUntilEnd: null });
});

test('isMostWanted and rankBucket classify ranks', () => {
  assert.equal(isMostWanted(ROWS[0]), true);
  assert.equal(isMostWanted(ROWS[2]), false);
  assert.equal(isMostWanted(null), false);
  assert.equal(rankBucket(2), 'top');
  assert.equal(rankBucket(20), 'top');
  assert.equal(rankBucket(21), 'high');
  assert.equal(rankBucket(100), 'high');
  assert.equal(rankBucket(224), 'other');
  assert.equal(rankBucket(null), 'none');
  assert.equal(rankBucket(0), 'none');
});

test('normalizeDxpeditionFilter validates status and coerces mostWantedOnly', () => {
  const current = { status: 'active', mostWantedOnly: true };
  assert.deepEqual(normalizeDxpeditionFilter({}, current), { status: 'active', mostWantedOnly: true });
  assert.deepEqual(normalizeDxpeditionFilter({ status: 'Upcoming' }, current), { status: 'upcoming', mostWantedOnly: true });
  assert.deepEqual(normalizeDxpeditionFilter({ status: 'all', mostWantedOnly: 'false' }, current), { status: 'all', mostWantedOnly: false });
  assert.deepEqual(normalizeDxpeditionFilter({ status: 'ended' }, current), { status: 'active', mostWantedOnly: true });
  assert.deepEqual(normalizeDxpeditionFilter({ status: '' }, current), { status: 'all', mostWantedOnly: true });
  assert.deepEqual(normalizeDxpeditionFilter({ mostWantedOnly: 'yes' }), { status: 'all', mostWantedOnly: true });
  assert.deepEqual(normalizeDxpeditionFilter({ mostWantedOnly: 1 }), { status: 'all', mostWantedOnly: true });
  assert.deepEqual(normalizeDxpeditionFilter({ mostWantedOnly: 0 }), { status: 'all', mostWantedOnly: false });
  assert.deepEqual(normalizeDxpeditionFilter(null, 'junk'), { status: 'all', mostWantedOnly: false });
  assert.deepEqual(normalizeDxpeditionFilter({}, { status: 'ended', mostWantedOnly: 'x' }), { status: 'all', mostWantedOnly: true });
});

test('dxpeditionMatchesFilter and filterDxpeditions apply status and most-wanted', () => {
  const ids = (list) => list.map((op) => op.id);
  assert.deepEqual(ids(filterDxpeditions(ROWS, { status: 'active', mostWantedOnly: false }, NOW)), ['dxped:V51WH:1787616000', 'dxped:RI1FJZ:1', 'dxped:TF:2']);
  assert.deepEqual(ids(filterDxpeditions(ROWS, { status: 'upcoming', mostWantedOnly: false }, NOW)), ['dxped:TF:3', 'dxped:VP5:4', 'dxped:3Y0K:5', 'dxped:9N:7']);
  assert.deepEqual(ids(filterDxpeditions(ROWS, { status: 'all', mostWantedOnly: true }, NOW)), ['dxped:V51WH:1787616000', 'dxped:RI1FJZ:1', 'dxped:VP5:4', 'dxped:3Y0K:5']);
  // 'all' shows active + upcoming; ended operations (stale in the 24 h upstream cache) are hidden
  assert.equal(filterDxpeditions(ROWS, DEFAULT_DXPEDITION_FILTER, NOW).length, 7);
  assert.equal(dxpeditionMatchesFilter(ROWS[6], DEFAULT_DXPEDITION_FILTER, NOW), false);
  assert.equal(dxpeditionMatchesFilter(ROWS[0], undefined, NOW), true);
  assert.equal(dxpeditionMatchesFilter(null, DEFAULT_DXPEDITION_FILTER, NOW), false);
});

test('dxpeditionStyle sizes by rank, colours the top 20 pink and dims upcoming', () => {
  const top = dxpeditionStyle(ROWS[5], { nowMs: NOW });
  assert.equal(top.wanted, true);
  assert.equal(top.bucket, 'top');
  assert.equal(top.color, '#f472b6');
  assert.equal(top.pixelSize, 17);
  assert.equal(top.alpha, 0.55);
  assert.equal(top.labelAlways, false);
  assert.equal(top.status, 'upcoming');
  const high = dxpeditionStyle(ROWS[1], { nowMs: NOW });
  assert.equal(high.color, '#a78bfa');
  assert.equal(high.pixelSize, 13);
  assert.equal(high.alpha, 1);
  assert.equal(high.labelAlways, true);
  const other = dxpeditionStyle(ROWS[0], { nowMs: NOW });
  assert.equal(other.pixelSize, 11);
  assert.equal(other.bucket, 'other');
  const none = dxpeditionStyle(ROWS[2], { nowMs: NOW });
  assert.equal(none.pixelSize, 11);
  assert.equal(none.outlineWidth, 1.5);
  assert.equal(top.outlineWidth, 2.5);
  assert.equal(none.outlineColor, '#ffffff');
  const ended = dxpeditionStyle(ROWS[6], { nowMs: NOW });
  assert.equal(ended.alpha, 0.3);
  assert.equal(ended.labelAlways, false);
});

test('formatShortDate, dxpeditionLabel and dxpeditionDetail build the label lines', () => {
  assert.equal(formatShortDate('2026-10-10T00:00:00Z', NOW), '10 Oct');
  assert.equal(formatShortDate('2027-01-03T00:00:00Z', NOW), '3 Jan 2027');
  assert.equal(formatShortDate('nope', NOW), '');
  assert.equal(dxpeditionLabel(ROWS[0]), 'V51WH');
  assert.equal(dxpeditionLabel(null), '');
  assert.equal(dxpeditionDetail(ROWS[0], NOW), 'Namibia · until 10 Oct · QSL DK2WH · #224');
  assert.equal(dxpeditionDetail(ROWS[4], NOW), 'Turks & Caicos · starts 18 Sep (6 d) · QSL LoTW · #70');
  assert.equal(dxpeditionDetail(ROWS[6], NOW), 'Grenada · ended 5 Sep · QSL LoTW');
  assert.equal(dxpeditionDetail(freezeDxpedition(row({ entity: null, qslVia: null, mostWantedRank: null, endIso: null })), NOW), '');
  assert.equal(dxpeditionDetail(null, NOW), '');
});

test('sortDxpeditions orders active by rank then end, upcoming by start, ended last', () => {
  const sorted = sortDxpeditions(ROWS, NOW).map((op) => op.id);
  assert.deepEqual(sorted, [
    'dxped:RI1FJZ:1', 'dxped:V51WH:1787616000', 'dxped:TF:2',
    'dxped:9N:7', 'dxped:TF:3', 'dxped:VP5:4', 'dxped:3Y0K:5',
    'dxped:J3:6',
  ]);
  // stable regardless of input order
  assert.deepEqual(sortDxpeditions([...ROWS].reverse(), NOW).map((op) => op.id), sorted);
});

test('resolveDxpedition finds by id, callsign, prefix, entity, mention and words', () => {
  assert.equal(resolveDxpedition(ROWS, 'DXPED:VP5:4', NOW).id, 'dxped:VP5:4');
  assert.equal(resolveDxpedition(ROWS, 'v51wh', NOW).id, 'dxped:V51WH:1787616000');
  // a bare prefix resolves to the active operation first
  assert.equal(resolveDxpedition(ROWS, 'tf', NOW).id, 'dxped:TF:2');
  assert.equal(resolveDxpedition(ROWS, 'iceland', NOW).id, 'dxped:TF:2');
  // a full call that the info mentions
  assert.equal(resolveDxpedition(ROWS, 'TF/G0XYZ', NOW).id, 'dxped:TF:3');
  assert.equal(resolveDxpedition(ROWS, 'vp5/k5ur', NOW).id, 'dxped:VP5:4');
  assert.equal(resolveDxpedition(ROWS, '9N7XY', NOW).id, 'dxped:9N:7');
  // a call starting with a listed prefix falls back to that prefix row
  assert.equal(resolveDxpedition(ROWS, 'VP5ABC', NOW).id, 'dxped:VP5:4');
  assert.equal(resolveDxpedition(ROWS, 'bouvet', NOW).id, 'dxped:3Y0K:5');
  assert.equal(resolveDxpedition(ROWS, 'franz josef', NOW).id, 'dxped:RI1FJZ:1');
  assert.equal(resolveDxpedition(ROWS, 'na-024', NOW).id, 'dxped:J3:6');
  assert.equal(resolveDxpedition(ROWS, 'nothing like this', NOW), null);
  assert.equal(resolveDxpedition(ROWS, '', NOW), null);
  assert.equal(resolveDxpedition(ROWS, '(', NOW), null);
});

test('dxpeditionDisplayPositions spreads shared entity centroids and skips unlocated rows', () => {
  const positions = dxpeditionDisplayPositions(ROWS);
  assert.equal(positions.size, 7);
  assert.equal(positions.has('dxped:9N:7'), false);
  const a = positions.get('dxped:TF:2');
  const b = positions.get('dxped:TF:3');
  assert.deepEqual(a, { lat: 65, lon: -18, offset: false });
  assert.equal(b.offset, true);
  const km = distanceKm({ lat: 65, lon: -18 }, b);
  assert.ok(km > 5 && km <= 60.5, `spread ${km} km`);
  assert.deepEqual(positions.get('dxped:V51WH:1787616000'), { lat: -22, lon: 17, offset: false });
});

test('trimDxpeditionItems and summarizeDxpeditions', () => {
  assert.deepEqual(trimDxpeditionItems(ROWS, 2, NOW).map((op) => op.id), ['dxped:RI1FJZ:1', 'dxped:V51WH:1787616000']);
  assert.equal(trimDxpeditionItems(ROWS, 'x', NOW).length, 0);
  assert.equal(trimDxpeditionItems(ROWS, undefined, NOW).length, ROWS.length);
  assert.deepEqual(summarizeDxpeditions(ROWS, NOW), { total: 8, active: 3, upcoming: 4, ended: 1, mostWanted: 4, located: 7 });
  assert.deepEqual(summarizeDxpeditions([], NOW), { total: 0, active: 0, upcoming: 0, ended: 0, mostWanted: 0, located: 0 });
});
