import assert from 'node:assert/strict';
import test from 'node:test';
import { createTemperatureSource, probeTileUrl } from './source.js';

const NOW = Date.parse('2026-09-30T06:00:00Z');
const dateIn = (url) => url.match(/default\/([\d-]+)\//)[1];

test('the probe URL carries the month in the path, where GIBS expects it', () => {
  const url = probeTileUrl('2026-08-01');
  // EPSG:3857 on purpose: the geographic matrix sets are not power-of-two
  // pyramids and Cesium mispositions them.
  assert.ok(url.includes('/wmts/epsg3857/best/'));
  assert.ok(
    url.includes(
      '/MODIS_Terra_L3_Land_Surface_Temp_Monthly_Day/default/2026-08-01/GoogleMapsCompatible_Level6/',
    ),
  );
  assert.ok(url.endsWith('.png'));
});

test('the probe is a required dependency, not an optional default', () => {
  // source.js is a portable export and may not reach browser globals, so the
  // image probe is injected rather than defaulted.
  assert.throws(() => createTemperatureSource(), /tile availability probe/);
  assert.throws(
    () => createTemperatureSource({ probeImpl: 'nope' }),
    /tile availability probe/,
  );
});

test('the newest published month wins, stepping over unpublished ones', async () => {
  const tried = [];
  const source = createTemperatureSource({
    probeImpl: async (url) => {
      tried.push(dateIn(url));
      return dateIn(url) <= '2026-08-01';
    },
  });
  const resolved = await source.resolveLatest({ now: NOW });
  assert.equal(resolved.date, '2026-08-01');
  assert.equal(resolved.candidatesTried, 2);
  assert.deepEqual(tried, ['2026-09-01', '2026-08-01']);
});

test('an unreachable lookback reports unavailable rather than a fabricated month', async () => {
  let probes = 0;
  const source = createTemperatureSource({
    probeImpl: async () => {
      probes += 1;
      return false;
    },
  });
  await assert.rejects(
    source.resolveLatest({ now: NOW, months: 4 }),
    (error) => {
      assert.equal(error.failureReason, 'unavailable');
      return true;
    },
  );
  assert.equal(probes, 4, 'every candidate is tried before giving up');
});

test('a year resolves its published months, oldest first, skipping gaps', async () => {
  const source = createTemperatureSource({
    probeImpl: async (url) => dateIn(url) !== '2019-03-01',
  });
  const year = await source.resolveYear({ year: 2019, latest: '2026-08-01' });
  assert.equal(year.dates.length, 11);
  assert.equal(year.dates[0], '2019-01-01');
  assert.ok(!year.dates.includes('2019-03-01'));
  assert.equal(year.dates.at(-1), '2019-12-01');
});

test('the current year stops at the newest published month', async () => {
  const probed = [];
  const source = createTemperatureSource({
    probeImpl: async (url) => {
      probed.push(dateIn(url));
      return true;
    },
  });
  const year = await source.resolveYear({ year: 2026, latest: '2026-08-01' });
  assert.equal(year.dates.length, 8);
  assert.ok(
    !probed.includes('2026-09-01'),
    'unpublished months are not probed',
  );
});

test('a year outside the record is refused, and an empty one is unavailable', async () => {
  const none = createTemperatureSource({ probeImpl: async () => false });
  await assert.rejects(
    none.resolveYear({ year: 2019, latest: '2026-08-01' }),
    (error) => error.failureReason === 'unavailable',
  );
  await assert.rejects(
    none.resolveYear({ year: 1999, latest: '2026-08-01' }),
    RangeError,
  );
  await assert.rejects(
    none.resolveYear({ year: 2027, latest: '2026-08-01' }),
    RangeError,
  );
});

test('cancellation stops a walk before any probe, and before admitting a month', async () => {
  const aborted = new AbortController();
  aborted.abort();
  const unreachable = createTemperatureSource({
    probeImpl: async () => {
      throw new Error('should not be reached');
    },
  });
  await assert.rejects(
    unreachable.resolveLatest({ now: NOW, signal: aborted.signal }),
    { name: 'AbortError' },
  );
  const midway = new AbortController();
  const source = createTemperatureSource({
    probeImpl: async () => {
      midway.abort();
      return true;
    },
  });
  await assert.rejects(
    source.resolveYear({
      year: 2019,
      latest: '2026-08-01',
      signal: midway.signal,
    }),
    { name: 'AbortError' },
  );
});
