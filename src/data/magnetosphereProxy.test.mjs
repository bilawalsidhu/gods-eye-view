import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeState,
  latestSolarWind,
  magnetosphereProxy,
} from '../../server/providers/magnetosphere.js';

const HEADER = [
  'time_tag',
  'speed',
  'density',
  'temperature',
  'bx',
  'by',
  'bz',
  'bt',
  'vx',
  'vy',
  'vz',
  'propagated_time_tag',
];
const row = (overrides = {}) => {
  const base = {
    time_tag: '2026-10-01T12:00:00Z',
    speed: 400,
    density: 5,
    temperature: 50000,
    bx: 1,
    by: 2,
    bz: -4,
    bt: 5,
    vx: -400,
    vy: 0,
    vz: 0,
    propagated_time_tag: '2026-10-01T13:00:00Z',
  };
  const merged = { ...base, ...overrides };
  return HEADER.map((key) => merged[key]);
};

test('takes the newest COMPLETE row, not merely the last one', () => {
  // SWPC's tail is often a timestamp with null plasma values. Reading it as
  // the current state would render "no data" as a dead-calm solar wind.
  const sample = latestSolarWind([
    HEADER,
    row({ time_tag: '2026-10-01T11:00:00Z', speed: 350 }),
    row({ time_tag: '2026-10-01T12:00:00Z', speed: 450 }),
    row({ time_tag: '2026-10-01T12:05:00Z', speed: null, density: null }),
  ]);
  assert.equal(sample.speedKmPerS, 450);
  assert.equal(sample.observedAt, '2026-10-01T12:00:00.000Z');
});

test('carries the propagated arrival time, which is what the model needs', () => {
  const sample = latestSolarWind([HEADER, row()]);
  assert.equal(sample.arrivesAt, '2026-10-01T13:00:00.000Z');
});

test('columns are resolved by name, so a reordered feed does not silently swap them', () => {
  const swapped = ['density', 'speed', ...HEADER.filter((k) => k !== 'speed' && k !== 'density')];
  const values = swapped.map((key) =>
    ({ density: 9, speed: 600, time_tag: '2026-10-01T12:00:00Z', bz: -3, bt: 4 })[key] ?? 0,
  );
  const sample = latestSolarWind([swapped, values]);
  assert.equal(sample.speedKmPerS, 600);
  assert.equal(sample.densityPerCm3, 9);
});

test('physically impossible values are rejected rather than modelled', () => {
  for (const bad of [{ speed: 99999 }, { density: 9999 }, { bz: 9999 }]) {
    assert.throws(
      () => latestSolarWind([HEADER, row(bad)]),
      /invalid_solar_wind_data/,
      `accepted ${JSON.stringify(bad)}`,
    );
  }
});

test('a feed with no usable row fails closed instead of inventing calm', () => {
  assert.throws(
    () => latestSolarWind([HEADER, row({ speed: null })]),
    /no_complete_row/,
  );
  assert.throws(() => latestSolarWind([HEADER]), /shape/);
  assert.throws(() => latestSolarWind([HEADER, row({ bz: 'x' })]), /invalid_solar_wind_data/);
});

test('state carries the magnetopause and says when it is extrapolated', () => {
  const calm = describeState(latestSolarWind([HEADER, row({ speed: 300, density: 2, bz: 1 })]));
  assert.ok(calm.magnetopause.standoffRe > 10);
  assert.equal(calm.magnetopause.insideGeosynchronous, false);
  assert.equal(calm.magnetopause.extrapolatedBeyondFit, true, 'quiet wind is below the fitted range');

  const storm = describeState(latestSolarWind([HEADER, row({ speed: 800, density: 30, bz: -20 })]));
  assert.ok(storm.magnetopause.standoffRe < 6.6);
  assert.equal(storm.magnetopause.insideGeosynchronous, true);
});

test('one upstream request serves concurrent callers, and the cache is reused', async () => {
  let calls = 0;
  let clock = 0;
  const proxy = magnetosphereProxy({
    now: () => clock,
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: true,
        headers: { get: () => null },
        text: async () => JSON.stringify([HEADER, row()]),
      };
    },
  });
  const run = () =>
    new Promise((resolve) => {
      const chunks = [];
      proxy.configureServer({
        middlewares: {
          use(_path, handler) {
            handler(
              { method: 'GET', url: '/' },
              {
                on() {},
                removeListener() {},
                setHeader() {},
                end(body) {
                  chunks.push(body);
                  resolve(JSON.parse(body));
                },
              },
            );
          },
        },
      });
    });
  const [a, b] = await Promise.all([run(), run()]);
  assert.equal(calls, 1, 'concurrent callers must coalesce');
  assert.equal(a.magnetopause.standoffRe, b.magnetopause.standoffRe);
  clock += 30_000;
  await run();
  assert.equal(calls, 1, 'inside the cache window nothing refetches');
  clock += 60_000;
  await run();
  assert.equal(calls, 2, 'past the window it refreshes');
});

test('an upstream failure degrades to a labelled stale answer, then to unavailable', async () => {
  let clock = 0;
  let mode = 'ok';
  const proxy = magnetosphereProxy({
    now: () => clock,
    fetchImpl: async () => {
      if (mode === 'fail') return { ok: false, status: 503 };
      return {
        ok: true,
        headers: { get: () => null },
        text: async () => JSON.stringify([HEADER, row()]),
      };
    },
  });
  const run = () =>
    new Promise((resolve) => {
      proxy.configureServer({
        middlewares: {
          use(_path, handler) {
            handler(
              { method: 'GET', url: '/' },
              { on() {}, removeListener() {}, setHeader() {}, end: (b) => resolve(JSON.parse(b)) },
            );
          },
        },
      });
    });
  await run();
  mode = 'fail';
  clock += 120_000;
  const stale = await run();
  assert.equal(stale.stale, true);
  assert.equal(stale.unavailable, false);
  assert.ok(stale.magnetopause.standoffRe > 0);

  clock += 7 * 3600_000;
  const gone = await run();
  assert.equal(gone.unavailable, true);
  assert.ok(gone.reason);
});
