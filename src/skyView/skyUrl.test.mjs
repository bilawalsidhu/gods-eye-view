import assert from 'node:assert/strict';
import test from 'node:test';
import { createSkyClock } from './skyClock.js';
import { makeView } from './skyMath.js';
import {
  DEFAULT_SKY_FLAGS,
  SKY_FLAGS,
  SKY_FLAG_BITS,
  decodeFlags,
  decodeSkyState,
  encodeFlags,
  encodeSkyState,
  isoUtc,
  readSkyUrl,
  writeSkyUrl,
} from './skyUrl.js';

const BASE =
  'https://example.com/?debug=1#v=2&lat=29.7604&lon=-95.3698&alt=500&l=abc';

test('sv round trip: lat/lon/az/el/fov/time/flags survive encode -> URL -> decode', () => {
  const cases = [
    {
      latDeg: 29.7604,
      lonDeg: -95.3698,
      view: makeView({ azDeg: 251.25, elDeg: 12.5, fovDeg: 70 }),
      timeMs: null,
      flags: {},
    },
    {
      latDeg: -33.8688,
      lonDeg: 151.2093,
      view: makeView({ azDeg: 0, elDeg: 90, fovDeg: 5 }),
      timeMs: Date.parse('2026-10-12T03:30:00Z'),
      flags: { flatHorizon: true, grid: true },
    },
    {
      latDeg: 89.99999,
      lonDeg: -180,
      view: makeView({ azDeg: 359.99, elDeg: -10, fovDeg: 100 }),
      timeMs: Date.parse('2030-01-01T00:00:00.250Z'),
      flags: { grid: true },
    },
  ];
  for (const state of cases) {
    const href = writeSkyUrl(BASE, state);
    const back = readSkyUrl(href);
    assert.ok(back, href);
    assert.ok(Math.abs(back.latDeg - state.latDeg) < 5e-6);
    assert.ok(Math.abs(back.lonDeg - state.lonDeg) < 5e-6);
    assert.ok(Math.abs(back.view.azDeg - state.view.azDeg) < 0.005);
    assert.ok(Math.abs(back.view.elDeg - state.view.elDeg) < 0.005);
    assert.ok(Math.abs(back.view.fovDeg - state.view.fovDeg) < 0.05);
    assert.equal(back.timeMs, state.timeMs);
    assert.equal(back.flags.flatHorizon, Boolean(state.flags.flatHorizon));
    assert.equal(back.flags.grid, Boolean(state.flags.grid));
    // a second trip is a fixed point
    assert.equal(writeSkyUrl(href, back), href);
  }
});

test('sv is its own query parameter: the hash (camera, l= layers) and other params are untouched', () => {
  const href = writeSkyUrl(BASE, {
    latDeg: 29.7604,
    lonDeg: -95.3698,
    view: makeView({ azDeg: 90, elDeg: 30, fovDeg: 60 }),
    flags: { grid: true },
  });
  const url = new URL(href);
  assert.equal(url.hash, new URL(BASE).hash);
  assert.equal(url.searchParams.get('debug'), '1');
  assert.equal(url.searchParams.get('sv'), '29.7604,-95.3698,90,30,60');
  assert.equal(url.searchParams.get('svf'), String(SKY_FLAGS.grid));
  assert.ok(!new URLSearchParams(url.hash.slice(1)).has('sv'));
  assert.match(
    href,
    /\?debug=1&sv=29\.7604,-95\.3698,90,30,60&svf=2#/,
    'readable commas',
  );
  const cleared = writeSkyUrl(href, null);
  assert.equal(cleared, new URL(BASE).href);
  assert.equal(readSkyUrl(cleared), null);
  // no flags -> no svf parameter
  const plain = new URL(
    writeSkyUrl(BASE, { latDeg: 1, lonDeg: 2, view: makeView() }),
  );
  assert.equal(plain.searchParams.has('svf'), false);
});

test('decodeSkyState rejects bad input and clamps the view', () => {
  for (const bad of [
    null,
    '',
    '1,2,3,4',
    '1,2,3,4,5,6,7',
    'a,2,3,4,5',
    '91,0,0,0,60',
    '0,181,0,0,60',
    '1,2,3,4,5,yesterday',
    '1,2,3,4,5,2026-10-12',
  ])
    assert.equal(decodeSkyState(bad), null, String(bad));
  const clamped = decodeSkyState('1,2,400,95,500');
  assert.equal(clamped.view.azDeg, 40);
  assert.equal(clamped.view.elDeg, 90);
  assert.equal(clamped.view.fovDeg, 100);
  assert.equal(readSkyUrl('not a url'), null);
});

test('flags encode/decode; bits keep their meaning; unknown bits ignored', () => {
  assert.equal(encodeFlags({ flatHorizon: true, grid: true }), 3);
  assert.deepEqual(decodeFlags('3'), {
    ...DEFAULT_SKY_FLAGS,
    flatHorizon: true,
    grid: true,
  });
  assert.deepEqual(decodeFlags('1024'), DEFAULT_SKY_FLAGS);
  assert.deepEqual(decodeFlags('-1'), DEFAULT_SKY_FLAGS);
  assert.deepEqual(decodeFlags(null), DEFAULT_SKY_FLAGS);
  // the default view encodes to 0 (no svf parameter at all)
  assert.equal(encodeFlags(DEFAULT_SKY_FLAGS), 0);
  assert.equal(encodeFlags({}), 0);
});

test('svf round trip: every combination of the 9 switches survives encode -> URL -> decode', () => {
  const names = Object.keys(SKY_FLAG_BITS);
  assert.deepEqual(names, [
    'flatHorizon',
    'grid',
    'stars',
    'lines',
    'names',
    'boundaries',
    'planets',
    'starNames',
    'telescopic',
  ]);
  const seen = new Set();
  for (let combo = 0; combo < 1 << names.length; combo++) {
    const flags = Object.fromEntries(
      names.map((name, i) => [name, Boolean(combo & (1 << i))]),
    );
    const href = writeSkyUrl('https://gev.test/?x=1#l=abc', {
      latDeg: 29.76,
      lonDeg: -95.37,
      view: makeView({ azDeg: 90, elDeg: 30, fovDeg: 60 }),
      flags,
    });
    const back = readSkyUrl(href);
    assert.deepEqual(back.flags, flags, href);
    seen.add(new URL(href).searchParams.get('svf'));
  }
  assert.equal(seen.size, 512, 'each combination has its own svf value');
  // single switches: one bit each, defaults written as no parameter
  assert.equal(encodeFlags({ stars: false }), 4);
  assert.equal(encodeFlags({ lines: false }), 8);
  assert.equal(encodeFlags({ names: false }), 16);
  assert.equal(encodeFlags({ boundaries: true }), 32);
  assert.equal(encodeFlags({ planets: false }), 64);
  assert.equal(encodeFlags({ starNames: false }), 128);
  assert.equal(encodeFlags({ telescopic: true }), 256);
});

test('isoUtc drops zero milliseconds', () => {
  assert.equal(
    isoUtc(Date.parse('2026-10-12T03:30:00Z')),
    '2026-10-12T03:30:00Z',
  );
  assert.equal(
    isoUtc(Date.parse('2026-10-12T03:30:00.5Z')),
    '2026-10-12T03:30:00.500Z',
  );
  assert.equal(
    encodeSkyState({
      latDeg: 1.5,
      lonDeg: -2,
      view: makeView({ azDeg: 10, elDeg: 20, fovDeg: 30 }),
      timeMs: 0,
    }).sv,
    '1.5,-2,10,20,30,1970-01-01T00:00:00Z',
  );
});

test('sky clock: live reads now, fixed holds, subscribers hear mode changes', () => {
  let t = 1000;
  const clock = createSkyClock({ now: () => t });
  const heard = [];
  const off = clock.subscribe((c) => heard.push(c.mode));
  assert.equal(clock.mode, 'live');
  assert.equal(clock.getTime(), 1000);
  t = 2000;
  assert.equal(clock.getTime(), 2000);
  assert.equal(clock.setFixed('x'), false);
  assert.equal(clock.setFixed(5), true);
  t = 9000;
  assert.equal(clock.getTime(), 5);
  clock.setFixed(5); // same instant: no event
  clock.setLive();
  clock.setLive(); // already live: no event
  assert.equal(clock.getTime(), 9000);
  off();
  clock.setFixed(7);
  assert.deepEqual(heard, ['fixed', 'live']);
});
