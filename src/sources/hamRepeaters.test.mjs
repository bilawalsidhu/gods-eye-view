import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_LIMIT,
  DEFAULT_RADIUS_KM,
  FAILED_LOAD_RETRY_MS,
  HAM_BANDS,
  HEIGHT_GATE_M,
  MAX_RADIUS_KM,
  MIN_RADIUS_KM,
  MOVE_END_DEBOUNCE_MS,
  REPEATER_BANDS,
  REPEATER_BAND_FILTERS,
  REPEATER_COLORS,
  REPEATER_KIND_FILTERS,
  REPEATER_ROW_KEYS,
  bandForHz,
  buildRepeatersUrl,
  cameraFetchPlan,
  clampRadiusKm,
  deriveViewCentre,
  describeArea,
  destinationPoint,
  distanceKm,
  formatAge,
  formatHz,
  freezeRepeater,
  initialBearingDeg,
  isValidRepeater,
  kindQueryValue,
  nearestRepeaters,
  normalizeHamrigDstarRow,
  normalizeHamrigFmRow,
  normalizeHamrigRepeaters,
  normalizeRepeaterFilter,
  parseRepeatersResponse,
  radiusForSpanKm,
  repeaterBand,
  repeaterColor,
  repeaterDetails,
  repeaterLabel,
  repeaterMatchesFilter,
  repeaterProvenance,
  resolveRepeaterQuery,
  sortByDistance,
  trimList,
  viewSpanKm,
  withDistanceFrom,
} from './hamRepeaters.js';

const FM = JSON.parse(
  readFileSync(
    new URL(
      '../data/fixtures/hamrig-fm-repeaters-nearby.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const DSTAR = JSON.parse(
  readFileSync(
    new URL(
      '../data/fixtures/hamrig-dstar-repeaters-nearby.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const NOW = Date.parse('2026-09-12T15:00:00.000Z');
const normalized = () => normalizeHamrigRepeaters(FM, DSTAR);
const rows = () =>
  parseRepeatersResponse({
    repeaters: normalized(),
    generatedAt: '2026-09-12T16:00:00.000Z',
  }).repeaters;

test('constants match the contract', () => {
  assert.equal(REPEATER_COLORS.FM, '#f59e0b');
  assert.equal(REPEATER_COLORS['D-STAR'], '#a855f7');
  assert.equal(HEIGHT_GATE_M, 1_500_000);
  assert.equal(MAX_RADIUS_KM, 300);
  assert.equal(MOVE_END_DEBOUNCE_MS, 1500);
  assert.equal(DEFAULT_LIMIT, 200);
  assert.deepEqual([...REPEATER_BANDS], ['6m', '2m', '1.25m', '70cm', '23cm']);
  assert.deepEqual(
    REPEATER_KIND_FILTERS.map((row) => row.id),
    ['all', 'FM', 'D-STAR'],
  );
  assert.deepEqual(
    REPEATER_BAND_FILTERS.map((row) => row.id),
    ['all', '6m', '2m', '1.25m', '70cm', '23cm'],
  );
  assert.ok(
    Object.isFrozen(REPEATER_COLORS) && Object.isFrozen(REPEATER_KIND_FILTERS),
  );
  assert.equal(HAM_BANDS.length, 19);
});

test('HamRig FM rows and one D-STAR row per module become provider-neutral rows, nearest first', () => {
  const list = normalized();
  assert.equal(list.length, 6 + 8, '6 FM + 8 D-STAR modules');
  for (const row of list)
    assert.deepEqual(Object.keys(row).sort(), [...REPEATER_ROW_KEYS].sort());
  const distances = list.map((row) => row.distanceKm);
  assert.deepEqual(
    distances,
    [...distances].sort((a, b) => a - b),
  );
  const pi2non = list.find((row) => row.callsign === 'PI2NON');
  assert.equal(pi2non.id, 'hamrig-fm:1886');
  assert.equal(pi2non.kind, 'FM');
  assert.equal(pi2non.outputHz, 430_275_000);
  assert.equal(pi2non.inputHz, 431_875_000);
  assert.equal(pi2non.offsetHz, 1_600_000);
  assert.equal(pi2non.band, '70cm');
  assert.equal(pi2non.toneHz, null);
  assert.equal(pi2non.city, 'Enschede');
  assert.equal(pi2non.country, 'Netherlands');
  assert.equal(pi2non.status, 'On-air');
  assert.equal(pi2non.statusKnown, true);
  assert.equal(pi2non.positionPrecise, true);
  assert.equal(pi2non.source, 'hamrig-fm');
  assert.equal(
    pi2non.confidence,
    'unverified',
    'the FM import has uncleared provenance',
  );
  assert.equal(pi2non.recordUpdatedAt, '2015-10-30');
  assert.equal(pi2non.module, null);
  const do0ll = list.find((row) => row.callsign === 'DO0LL');
  assert.equal(do0ll.toneHz, 123);
  assert.equal(do0ll.echolink, '6053');
  assert.equal(do0ll.allstar, null);
  const db0vq = list.find((row) => row.callsign === 'DB0VQ');
  assert.equal(db0vq.toneHz, null, '1750 Hz is a tone-burst, not a CTCSS tone');
  assert.equal(db0vq.toneBurstHz, 1750);
  assert.equal(
    list.find((row) => row.callsign === 'DB0EG').outputHz,
    1_242_500_000,
  );
  assert.equal(list.find((row) => row.callsign === 'DB0EG').band, '23cm');
  const db0rtv = list.find((row) => row.id === 'hamrig-dstar:561:B');
  assert.equal(db0rtv.kind, 'D-STAR');
  assert.equal(db0rtv.module, 'B');
  assert.equal(db0rtv.outputHz, 438_512_500);
  assert.equal(db0rtv.inputHz, 430_912_500, 'output + (−7.6 MHz)');
  assert.equal(db0rtv.offsetHz, -7_600_000);
  assert.equal(db0rtv.country, 'Germany');
  assert.equal(db0rtv.region, 'North Rhine-Westphalia');
  assert.equal(db0rtv.city, 'Rheine');
  assert.equal(db0rtv.status, 'UNKNOWN');
  assert.equal(db0rtv.statusKnown, false);
  assert.equal(db0rtv.source, 'hamrig-dstar');
  assert.equal(db0rtv.confidence, 'reported');
  assert.equal(db0rtv.recordUpdatedAt, '2017-12-21');
  const pi1mep = list.filter((row) => row.callsign === 'PI1MEP');
  assert.deepEqual(
    pi1mep.map((row) => row.module),
    ['A', 'B', 'C'],
  );
  assert.equal(pi1mep[0].outputHz, 1_297_225_000);
  assert.equal(pi1mep[0].inputHz, 1_267_225_000);
  assert.equal(pi1mep[1].inputHz, 431_000_000, 'zero offset');
  assert.equal(pi1mep[0].country, 'Netherlands');
  assert.equal(pi1mep[0].region, null);
  assert.equal(
    list.find((row) => row.callsign === 'DB0NGR').inputHz,
    146_187_500,
    'positive offset',
  );
  const serialized = JSON.stringify(list);
  assert.doesNotMatch(
    serialized,
    /information_email|repeaterbook|county|sponsor/,
  );
});

test('normalisers tolerate missing payloads and bad rows', () => {
  assert.deepEqual(normalizeHamrigRepeaters(null, null), []);
  assert.deepEqual(
    normalizeHamrigRepeaters({ success: false }, { data: 'x' }),
    [],
  );
  assert.deepEqual(
    normalizeHamrigRepeaters(
      {
        data: [
          {
            id: 1,
            callsign: 'X',
            frequency: 'abc',
            latitude: '1',
            longitude: '1',
          },
          {
            id: 2,
            callsign: 'DB0X',
            frequency: '145.6',
            latitude: null,
            longitude: null,
          },
        ],
      },
      null,
    ),
    [],
  );
  assert.equal(normalizeHamrigFmRow(null), null);
  assert.deepEqual(
    normalizeHamrigDstarRow({
      callsign: 'DB0X',
      latitude: '1',
      longitude: '1',
    }),
    [],
  );
  const fallbackId = normalizeHamrigFmRow({
    callsign: 'db0x',
    frequency: '145.600',
    latitude: '51.5',
    longitude: '7.5',
  });
  assert.equal(fallbackId.id, 'hamrig-fm:DB0X:145600000');
  assert.equal(fallbackId.recordUpdatedAt, null);
  assert.equal(fallbackId.positionPrecise, null);
});

test('bandForHz maps edges and rejects gaps and garbage', () => {
  assert.equal(bandForHz(14_074_000), '20m');
  assert.equal(bandForHz(2_000_000), '160m', 'inclusive high edge');
  assert.equal(bandForHz(5_357_000), '60m');
  assert.equal(bandForHz(135_700), '2200m');
  assert.equal(bandForHz(1_296_000_000), '23cm');
  assert.equal(bandForHz(2_500_000), null);
  assert.equal(bandForHz(27_000_000), null, 'CB is not a ham band');
  assert.equal(bandForHz('14074000'), '20m');
  assert.equal(bandForHz(0), null);
  assert.equal(bandForHz('nope'), null);
  assert.equal(bandForHz(null), null);
});

test('the browser re-validates rows and freezes them', () => {
  const good = normalized()[0];
  assert.equal(isValidRepeater(good), true);
  assert.equal(isValidRepeater({ ...good, id: '' }), false);
  assert.equal(isValidRepeater({ ...good, kind: 'DMR' }), false);
  assert.equal(isValidRepeater({ ...good, callsign: '  ' }), false);
  assert.equal(isValidRepeater({ ...good, outputHz: 'abc' }), false);
  assert.equal(isValidRepeater({ ...good, outputHz: 0 }), false);
  assert.equal(isValidRepeater({ ...good, lat: 0, lon: 0 }), false);
  assert.equal(isValidRepeater({ ...good, lat: 95 }), false);
  assert.equal(isValidRepeater({ ...good, lon: null }), false);
  assert.equal(isValidRepeater(null), false);
  assert.equal(isValidRepeater('fm:1'), false);
  const frozen = freezeRepeater({
    ...good,
    callsign: ' pi2non ',
    city: 'Ens chede',
    module: 'ABC',
    toneHz: '88.5',
    distanceKm: '9.55',
    confidence: 'made-up',
    sourceUrl: 'http://insecure.example/',
    recordUpdatedAt: '2025-05-06 10:00:00',
  });
  assert.equal(frozen.callsign, 'PI2NON');
  assert.equal(frozen.city, 'Ens chede');
  assert.equal(frozen.module, 'AB');
  assert.equal(frozen.toneHz, 88.5);
  assert.equal(frozen.distanceKm, 9.6);
  assert.equal(
    frozen.confidence,
    'unverified',
    'an unknown confidence is never upgraded',
  );
  assert.equal(frozen.sourceUrl, null, 'only https record links are kept');
  assert.equal(frozen.recordUpdatedAt, '2025-05-06');
  assert.ok(Object.isFrozen(frozen));
  const parsed = parseRepeatersResponse({
    repeaters: [good, good, { ...good, id: 'bad', lat: 0, lon: 0 }],
    generatedAt: '2026-09-12T16:00:00.000Z',
    partial: true,
    errors: { 'D-STAR': 'down' },
    sources: ['hamrig-fm'],
  });
  assert.equal(
    parsed.repeaters.length,
    1,
    'duplicates collapse, invalid rows drop',
  );
  assert.equal(parsed.updatedAt, '2026-09-12T16:00:00.000Z');
  assert.equal(parsed.partial, true);
  assert.deepEqual(parsed.errors, { 'D-STAR': 'down' });
  assert.deepEqual(parsed.sources, ['hamrig-fm']);
  assert.equal(parseRepeatersResponse(null).repeaters.length, 0);
  assert.equal(parseRepeatersResponse({ repeaters: 'nope' }).updatedAt, null);
  assert.equal(
    parseRepeatersResponse([good]).repeaters.length,
    1,
    'bare arrays are accepted',
  );
});

test('colours, bands, labels, details and provenance', () => {
  assert.equal(repeaterColor('FM'), '#f59e0b');
  assert.equal(repeaterColor('d-star'), '#a855f7');
  assert.equal(repeaterColor('DMR'), '#9aa4b2');
  assert.equal(repeaterColor(null), '#9aa4b2');
  assert.equal(repeaterBand(430_275_000), '70cm');
  assert.equal(repeaterBand(223_000_000), '1.25m');
  const list = rows();
  const fm = list[0];
  assert.equal(repeaterLabel(fm), 'PI2NON 430.275 MHz');
  assert.equal(
    repeaterDetails(fm),
    'FM · Enschede, Netherlands · in 431.875 MHz',
  );
  const dstar = list.find((row) => row.id === 'hamrig-dstar:561:B');
  assert.ok(repeaterLabel(dstar).startsWith('DB0RTV B 438.51'));
  assert.ok(
    repeaterDetails(dstar).startsWith('D-STAR · Rheine, Germany · in 430.91'),
  );
  const echolink = list.find((row) => row.callsign === 'DO0LL');
  assert.equal(
    repeaterDetails(echolink),
    'FM · Legden, Germany · CTCSS 123 · EchoLink 6053',
  );
  const burst = list.find((row) => row.callsign === 'DB0VQ');
  assert.equal(
    repeaterDetails(burst),
    'FM · Bad Bentheim, Germany · 1750 Hz tone-burst · in 145.175 MHz',
  );
  assert.equal(
    repeaterProvenance(fm),
    'HamRig FM table (historic import, cross-checked against hearham.com) · unverified · record 2015-10-30 · status On-air (as listed)',
  );
  assert.equal(
    repeaterProvenance(dstar),
    'dstarinfo.com / ircddb.net via HamRig · reported · record 2017-12-21 · status UNKNOWN (not verified)',
  );
  assert.equal(repeaterLabel(null), '');
  assert.equal(repeaterDetails(null), '');
  assert.equal(repeaterProvenance(null), '');
});

test('filter validation and matching', () => {
  const current = { kind: 'all', band: 'all' };
  assert.deepEqual(
    normalizeRepeaterFilter({ kind: 'fm', band: '70CM' }, current),
    { kind: 'FM', band: '70cm' },
  );
  assert.deepEqual(normalizeRepeaterFilter({ kind: 'dstar' }, current), {
    kind: 'D-STAR',
    band: 'all',
  });
  assert.deepEqual(
    normalizeRepeaterFilter(
      { kind: 'D-STAR', band: '33cm' },
      { kind: 'FM', band: '2m' },
    ),
    { kind: 'D-STAR', band: '2m' },
  );
  assert.deepEqual(
    normalizeRepeaterFilter({ kind: 'nonsense' }, { kind: 'FM', band: '2m' }),
    { kind: 'FM', band: '2m' },
  );
  assert.deepEqual(
    normalizeRepeaterFilter(
      { kind: 'all', band: 'all' },
      { kind: 'FM', band: '2m' },
    ),
    { kind: 'all', band: 'all' },
  );
  assert.ok(Object.isFrozen(normalizeRepeaterFilter()));
  const list = rows();
  const fm70 = list[0];
  const dstar70 = list.find((row) => row.id === 'hamrig-dstar:561:B');
  assert.equal(repeaterMatchesFilter(fm70, { kind: 'all', band: 'all' }), true);
  assert.equal(repeaterMatchesFilter(fm70, { kind: 'FM', band: '70cm' }), true);
  assert.equal(
    repeaterMatchesFilter(fm70, { kind: 'D-STAR', band: 'all' }),
    false,
  );
  assert.equal(repeaterMatchesFilter(fm70, { kind: 'all', band: '2m' }), false);
  assert.equal(
    repeaterMatchesFilter(dstar70, { kind: 'D-STAR', band: '70cm' }),
    true,
  );
  assert.equal(repeaterMatchesFilter(null, {}), false);
  assert.equal(kindQueryValue('FM'), 'fm');
  assert.equal(kindQueryValue('D-STAR'), 'dstar');
  assert.equal(kindQueryValue('dstar'), 'dstar');
  assert.equal(kindQueryValue('all'), 'all');
  assert.equal(kindQueryValue(undefined), 'all');
});

test('sorting, distance recomputation, nearest-N and trimming', () => {
  const list = rows();
  const shuffled = [
    list[5],
    list[0],
    { ...list[1], distanceKm: null },
    list[3],
  ];
  const sorted = sortByDistance(shuffled);
  assert.equal(sorted[0].id, list[0].id);
  assert.equal(sorted[sorted.length - 1].distanceKm, null);
  assert.equal(shuffled[0].id, list[5].id, 'never mutates');
  const munich = { lat: 48.14, lon: 11.58 };
  const recomputed = withDistanceFrom(list, munich);
  assert.equal(recomputed.length, list.length);
  assert.ok(
    Math.abs(recomputed[0].distanceKm - distanceKm(munich, list[0])) < 0.1,
  );
  assert.ok(Object.isFrozen(recomputed[0]));
  assert.equal(withDistanceFrom(list, { lat: 'x' }), list);
  const nearest = nearestRepeaters(list, 52.23, 6.92, 3);
  assert.equal(nearest.length, 3);
  assert.equal(nearest[0].callsign, 'PI2NON');
  assert.ok(nearest[0].distanceKm < 1);
  assert.ok(
    nearest[0].distanceKm <= nearest[1].distanceKm &&
      nearest[1].distanceKm <= nearest[2].distanceKm,
  );
  const dstarOnly = nearestRepeaters(list, 52.23, 6.92, 2, {
    kind: 'D-STAR',
    band: 'all',
  });
  assert.ok(dstarOnly.every((row) => row.kind === 'D-STAR'));
  assert.deepEqual(nearestRepeaters(list, null, 6.92, 3), []);
  assert.equal(nearestRepeaters(list, 52.23, 6.92, 0).length, 1);
  const big = Array.from({ length: 250 }, (_, index) => index);
  assert.equal(trimList(big).length, 200);
  assert.equal(big.length, 250);
  assert.deepEqual(trimList([1, 2, 3], 2), [1, 2]);
  assert.deepEqual(trimList(undefined), []);
});

test('resolveRepeaterQuery accepts ids, callsigns, module suffixes and cities', () => {
  const list = rows();
  assert.equal(resolveRepeaterQuery('hamrig-fm:1886', list).callsign, 'PI2NON');
  assert.equal(
    resolveRepeaterQuery('HAMRIG-DSTAR:561:B', list).callsign,
    'DB0RTV',
  );
  assert.equal(resolveRepeaterQuery('db0rtv', list).id, 'hamrig-dstar:561:B');
  assert.equal(resolveRepeaterQuery('db0rtv b', list).id, 'hamrig-dstar:561:B');
  assert.equal(resolveRepeaterQuery('DB0RTV/B', list).id, 'hamrig-dstar:561:B');
  assert.equal(resolveRepeaterQuery('Enschede', list).callsign, 'PI2NON');
  assert.equal(resolveRepeaterQuery('PI2N', list).callsign, 'PI2NON');
  assert.equal(resolveRepeaterQuery('ZZ9ZZZ', list), null);
  assert.equal(resolveRepeaterQuery('', list), null);
  assert.equal(resolveRepeaterQuery('PI2NON', null), null);
});

test('formatHz, formatAge and the spherical helpers', () => {
  assert.equal(formatHz(14_025_000), '14025.0 kHz');
  assert.equal(formatHz(145_500_000), '145.500 MHz');
  assert.equal(formatHz(30_000_000), '30.000 MHz');
  assert.equal(formatHz(14_025_000, { unit: false }), '14025.0');
  assert.equal(formatHz(0), '');
  assert.equal(formatHz('nope'), '');
  const now = Date.parse('2026-09-12T12:00:00Z');
  assert.equal(formatAge('2026-09-12T11:59:40Z', now), '20 s');
  assert.equal(formatAge('2026-09-12T11:57:00Z', now), '3 min');
  assert.equal(formatAge('2026-09-12T10:00:00Z', now), '2 h');
  assert.equal(formatAge('2026-09-09T12:00:00Z', now), '3 d');
  assert.equal(formatAge('2026-09-12T12:05:00Z', now), '0 s');
  assert.equal(formatAge(now - 90_000, now), '2 min');
  assert.equal(formatAge('garbage', now), '');
  const twente = { lat: 52.2292, lon: 6.875 };
  const arvika = { lat: 59.546, lon: 12.526 };
  const km = distanceKm(twente, arvika);
  assert.ok(
    Math.abs(km - 885.9) < 0.5,
    `Twente→Arvika is about 886 km, got ${km}`,
  );
  assert.equal(distanceKm(twente, twente), 0);
  assert.ok(Number.isNaN(distanceKm(null, twente)));
  assert.equal(initialBearingDeg({ lat: 0, lon: 0 }, { lat: 0, lon: 10 }), 90);
  assert.equal(
    initialBearingDeg({ lat: 0, lon: 0 }, { lat: 0, lon: -10 }),
    270,
  );
  const there = destinationPoint(twente, initialBearingDeg(twente, arvika), km);
  assert.ok(
    Math.abs(there.lat - arvika.lat) < 1e-6 &&
      Math.abs(there.lon - arvika.lon) < 1e-6,
  );
  const wrapped = destinationPoint({ lat: 0, lon: 179 }, 90, 2 * 111.195);
  assert.ok(
    Math.abs(wrapped.lon + 179) < 0.01,
    'longitude wraps to −179, not 181',
  );
  assert.equal(destinationPoint(null, 0, 1), null);
});

test('viewSpanKm measures a rectangle at its middle latitude and survives the dateline', () => {
  const span = viewSpanKm({ south: 47.5, west: 10.5, north: 48.5, east: 12.5 });
  assert.ok(Math.abs(span.heightKm - 111.2) < 1);
  assert.ok(Math.abs(span.widthKm - 148.8) < 1.5);
  assert.equal(span.spanKm, span.widthKm);
  const dateline = viewSpanKm({ south: -1, west: 179, north: 1, east: -179 });
  assert.ok(Math.abs(dateline.widthKm - 222.4) < 1.5);
  assert.equal(viewSpanKm({ south: 1, west: 2 }), null);
  assert.equal(viewSpanKm(null), null);
});

test('radius comes from the visible span and is clamped to 15–300 km', () => {
  assert.equal(radiusForSpanKm(1000), 300);
  assert.equal(radiusForSpanKm(100), 50);
  assert.equal(radiusForSpanKm(10), MIN_RADIUS_KM);
  assert.equal(radiusForSpanKm(NaN), DEFAULT_RADIUS_KM);
  assert.equal(clampRadiusKm(1000), 300);
  assert.equal(clampRadiusKm('60'), 60);
  assert.equal(clampRadiusKm(3), 15);
  assert.equal(clampRadiusKm(undefined), 100);
});

test('deriveViewCentre prefers the look-at hit and pulls a horizon gaze back towards the nadir', () => {
  const nadir = { lat: 48, lon: 11 };
  assert.deepEqual(deriveViewCentre({ nadir }), {
    lat: 48,
    lon: 11,
    source: 'nadir',
  });
  assert.deepEqual(
    deriveViewCentre({ nadir, hit: { lat: 48.2, lon: 11.3 }, heightM: 50_000 }),
    { lat: 48.2, lon: 11.3, source: 'look-at' },
  );
  const pulled = deriveViewCentre({
    nadir,
    hit: { lat: 60, lon: 30 },
    heightM: 100_000,
  });
  assert.equal(pulled.source, 'pulled');
  assert.ok(
    Math.abs(distanceKm(nadir, pulled) - 150) < 1,
    '100 km height → 150 km pull limit',
  );
  assert.equal(
    deriveViewCentre({ nadir, hit: { lat: 55, lon: 20 }, heightM: 1_400_000 })
      .source,
    'look-at',
  );
  assert.equal(deriveViewCentre({ nadir: { lat: 'x' } }), null);
});

test('cameraFetchPlan applies the height gate, movement, zoom and retry rules', () => {
  const centre = { lat: 48.14, lon: 11.58 };
  const above = cameraFetchPlan({ heightM: 2_000_000, centre, spanKm: 400 });
  assert.equal(above.fetch, false);
  assert.equal(above.reason, 'above-gate');
  const initial = cameraFetchPlan({ heightM: 200_000, centre, spanKm: 400 });
  assert.deepEqual(initial, {
    fetch: true,
    reason: 'initial',
    withinGate: true,
    radiusKm: 200,
    lat: 48.14,
    lon: 11.58,
  });
  const last = { lat: 48.14, lon: 11.58, radiusKm: 200, at: NOW - 10_000 };
  assert.equal(
    cameraFetchPlan({
      heightM: 200_000,
      centre: { lat: 48.2, lon: 11.6 },
      spanKm: 400,
      last,
      nowMs: NOW,
    }).reason,
    'unchanged',
  );
  const moved = cameraFetchPlan({
    heightM: 200_000,
    centre: { lat: 49.0, lon: 11.6 },
    spanKm: 400,
    last,
    nowMs: NOW,
  });
  assert.equal(moved.reason, 'moved');
  assert.ok(moved.movedKm > 90);
  const zoomed = cameraFetchPlan({
    heightM: 50_000,
    centre,
    spanKm: 60,
    last,
    nowMs: NOW,
  });
  assert.equal(zoomed.reason, 'zoomed');
  assert.equal(zoomed.radiusKm, 30);
  const forced = cameraFetchPlan({
    heightM: 5_000_000,
    centre,
    spanKm: 4000,
    force: true,
  });
  assert.equal(forced.reason, 'forced');
  assert.equal(forced.radiusKm, 300);
  const failed = { ...last, failed: true, at: NOW - 5_000 };
  assert.equal(
    cameraFetchPlan({
      heightM: 200_000,
      centre,
      spanKm: 400,
      last: failed,
      nowMs: NOW,
    }).reason,
    'retry-wait',
  );
  assert.equal(
    cameraFetchPlan({
      heightM: 200_000,
      centre,
      spanKm: 400,
      last: { ...failed, at: NOW - FAILED_LOAD_RETRY_MS },
      nowMs: NOW,
    }).reason,
    'retry',
  );
  assert.equal(
    cameraFetchPlan({ heightM: 200_000, centre: { lat: null }, spanKm: 400 })
      .reason,
    'no-centre',
  );
  assert.equal(
    cameraFetchPlan({ heightM: NaN, centre, spanKm: 400 }).reason,
    'above-gate',
  );
});

test('buildRepeatersUrl is same-origin and maps the filter to upstream names', () => {
  assert.equal(
    buildRepeatersUrl({
      lat: 48.13512,
      lon: 11.58198,
      radiusKm: 60,
      limit: 200,
      band: '70cm',
      kind: 'D-STAR',
    }),
    '/api/ham-repeaters/nearby?lat=48.1351&lon=11.582&radiusKm=60&limit=200&band=70cm&kind=dstar',
  );
  assert.equal(
    buildRepeatersUrl({ lat: 48, lon: 11 }),
    '/api/ham-repeaters/nearby?lat=48&lon=11&radiusKm=100&limit=200&kind=all',
  );
  assert.equal(
    buildRepeatersUrl({
      lat: 48,
      lon: 11,
      radiusKm: 900,
      limit: 5000,
      band: '33cm',
      kind: 'fm',
    }),
    '/api/ham-repeaters/nearby?lat=48&lon=11&radiusKm=300&limit=200&kind=fm',
  );
  assert.equal(buildRepeatersUrl({ lat: 'x', lon: 11 }), null);
  assert.equal(buildRepeatersUrl(), null);
  assert.equal(
    describeArea({ lat: 48.1351, lon: 11.582, radiusKm: 60.4 }),
    '60 km around 48.14, 11.58',
  );
  assert.equal(describeArea({ lat: 48.1351, lon: 11.582 }), '48.14, 11.58');
  assert.equal(describeArea(null), '');
});
