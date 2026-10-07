import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeState,
  latestDst,
  latestKp,
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
    // Kp and Dst are fetched alongside the solar wind, each with its own cache,
    // so count only the feed under test rather than every request the provider
    // makes.
    fetchImpl: async (url) => {
      const text = String(url);
      const kp = text.includes('planetary_k_index');
      const dst = text.includes('kyoto-dst');
      if (!kp && !dst) calls += 1;
      let body = JSON.stringify([HEADER, row()]);
      if (kp)
        body = JSON.stringify([
          { time_tag: '2026-10-01T12:00:00', estimated_kp: 2.3 },
        ]);
      if (dst)
        body = JSON.stringify([{ time_tag: '2026-10-01T12:00:00', dst: -18 }]);
      return { ok: true, headers: { get: () => null }, text: async () => body };
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
    fetchImpl: async (url) => {
      const kp = String(url).includes('planetary_k_index');
      if (mode === 'fail' && !kp) return { ok: false, status: 503 };
      return {
        ok: true,
        headers: { get: () => null },
        text: async () =>
          kp
            ? JSON.stringify([{ time_tag: '2026-10-01T12:00:00', estimated_kp: 2.3 }])
            : JSON.stringify([HEADER, row()]),
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

test('Kp takes the newest usable reading and refuses impossible ones', async () => {
  const { latestKp } = await import('../../server/providers/magnetosphere.js');
  assert.equal(
    latestKp([
      { time_tag: '2026-10-01T11:00:00', estimated_kp: 1.0 },
      { time_tag: '2026-10-01T12:00:00', estimated_kp: 4.7 },
    ]).kp,
    4.7,
  );
  // A missing or absurd Kp must not become a number the model would trust.
  assert.equal(latestKp([{ time_tag: 'x', estimated_kp: 99 }]), null);
  assert.equal(latestKp([]), null);
  assert.equal(latestKp(null), null);
});

test('By comes through for T96, and its absence is not fatal', () => {
  // T96 needs the IMF By; T89 and the Shue boundary do not. A feed that omits
  // it must still serve a usable state rather than failing the whole request.
  assert.equal(latestSolarWind([HEADER, row({ by: -6.5 })]).byNT, -6.5);
  assert.equal(latestSolarWind([HEADER, row({ by: null })]).byNT, null);
  // A by far outside anything physical is a broken feed, same as bz.
  assert.throws(() => latestSolarWind([HEADER, row({ by: 900 })]), /by_range/);
  // And a feed with no by column at all still parses.
  const noBy = HEADER.filter((name) => name !== 'by');
  const trimmed = row();
  const columns = HEADER.map((name, i) => [name, trimmed[i]]);
  const reduced = noBy.map(
    (name) => columns.find(([key]) => key === name)[1],
  );
  assert.equal(latestSolarWind([noBy, reduced]).byNT, null);
});

test('Dst takes the newest usable hourly value and stamps it UTC', () => {
  assert.deepEqual(
    latestDst([
      { time_tag: '2026-10-01T18:00:00', dst: 5 },
      { time_tag: '2026-10-01T19:00:00', dst: -42 },
    ]),
    { dst: -42, observedAt: '2026-10-01T19:00:00Z' },
  );
  // Positive Dst of a few tens of nT is ordinary quiet-time behaviour, not an
  // error, so it must not be filtered out.
  assert.equal(latestDst([{ time_tag: '2026-10-01T19:00:00', dst: 12 }]).dst, 12);
  // Values past the record storm, nulls and junk are skipped, newest first.
  assert.deepEqual(
    latestDst([
      { time_tag: '2026-10-01T17:00:00', dst: -30 },
      { time_tag: '2026-10-01T18:00:00', dst: null },
      { time_tag: '2026-10-01T19:00:00', dst: -5000 },
    ]),
    { dst: -30, observedAt: '2026-10-01T17:00:00Z' },
  );
  assert.equal(latestDst([]), null);
  // Number(null) is 0, so a null reading would otherwise come back as a
  // perfectly quiet 0 nT. It must be skipped instead.
  assert.equal(latestDst([{ time_tag: '2026-10-01T19:00:00', dst: null }]), null);
  assert.equal(latestDst([{ time_tag: '2026-10-01T19:00:00', dst: '' }]), null);
  assert.equal(latestDst(null), null);
  // An already-zoned stamp must not end up with two designators.
  assert.equal(
    latestDst([{ time_tag: '2026-10-01T19:00:00Z', dst: -7 }]).observedAt,
    '2026-10-01T19:00:00Z',
  );
});

test('state carries Dst through so the client can choose T96', () => {
  const sample = latestSolarWind([HEADER, row({ by: 3 })]);
  const state = describeState(sample, {
    kp: { kp: 2.3 },
    dst: { dst: -18, observedAt: '2026-10-01T12:00:00Z' },
  });
  assert.equal(state.dst.dst, -18);
  assert.equal(state.solarWind.byNT, 3);
  // Omitting them must give null, not undefined, so the JSON carries the key.
  assert.equal(describeState(sample).dst, null);
});

test('a null index reading is skipped rather than read as zero', () => {
  // Number(null) is 0. For Kp that would turn a dead feed into "perfectly
  // quiet", which is the one failure mode this provider is written to avoid.
  assert.equal(
    latestKp([{ time_tag: '2026-10-01T12:00:00', estimated_kp: null, kp_index: null }]),
    null,
  );
  assert.equal(
    latestKp([{ time_tag: '2026-10-01T12:00:00', estimated_kp: '' }]),
    null,
  );
  // A genuine zero still gets through.
  assert.equal(
    latestKp([{ time_tag: '2026-10-01T12:00:00', estimated_kp: 0 }]).kp,
    0,
  );
});
