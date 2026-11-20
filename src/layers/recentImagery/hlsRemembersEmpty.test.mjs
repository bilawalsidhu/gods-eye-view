import test from 'node:test';
import assert from 'node:assert/strict';
import { until } from '../../testSupport/kartaViewFakes.mjs';
import { createRecentImagerySource } from './source.js';
import { createThumbnailLoader } from './thumbnails.js';
import { nonCrossingBoxes } from './model.js';
import { createRecentImageryLayer } from './index.js';
import { createRecentImageryRenderer } from './rendering.js';
import { fakeGlobePort } from '../../testSupport/fakeGlobePort.mjs';
import { FIJI_BOX, candidate } from './testDoubles.mjs';

const sideOf = (url) =>
  Number(new URL(url).searchParams.get('BBOX').split(',')[1]) > 0
    ? 'west'
    : 'east';
const answer = (present) =>
  new Response('img', {
    headers: present === null ? {} : { 'Data-Present': String(present) },
  });

function realLayer({ fetchImpl, candidates, maxDecoded = 16 }) {
  const source = createRecentImagerySource({ fetchImpl, halfDeadlineMs: 5000 });
  let nextUrl = 0;
  const loader = createThumbnailLoader({
    requestThumbnail: source.getThumbnail,
    createObjectUrl: () => `blob:${++nextUrl}`,
    revokeObjectUrl: () => {},
    maxDecoded,
  });
  const globe = fakeGlobePort();
  const layer = createRecentImageryLayer({
    catalog: {
      searchHls: async () => ({ candidates, truncated: false, errors: [] }),
    },
    renderer: createRecentImageryRenderer(),
    thumbnails: loader,
    host: () => ({ collection: globe.imagery, kind: 'globe' }),
    globeOf: () => globe,
    now: () => new Date('2026-11-13T15:00:00Z'),
  });
  layer.init({ camera: {} });
  return { layer, loader, globe };
}

test('hls-remembers-empty: a re-probe with one failed half keeps that half confirmed empty', async () => {
  const day1 = candidate('S30', '2026-11-10');
  const day2 = candidate('S30', '2026-11-11');
  let eastCalls = 0;
  let releaseDay2;
  const gate = new Promise((r) => (releaseDay2 = r));
  const { layer, loader, globe } = realLayer({
    candidates: [day2, day1],
    maxDecoded: 1,
    fetchImpl: async (url) => {
      if (new URL(url).searchParams.get('TIME') === day2.day) {
        await gate;
        return answer(true);
      }
      if (sideOf(url) === 'east') {
        eastCalls += 1;
        if (eastCalls === 1) return answer(false);
        throw new TypeError('Failed to fetch');
      }
      return answer(true);
    },
  });
  layer.enable();
  layer.setBox(FIJI_BOX);
  assert.equal(
    await until(() => loader.get(day1.key).status === 'present', {
      ticks: 2000,
    }),
    true,
  );
  const [west] = nonCrossingBoxes(FIJI_BOX);
  assert.deepEqual(loader.get(day1.key).availableBoxes, [west]);
  assert.equal(loader.get(day1.key).emptyBoxes.length, 1);
  releaseDay2();
  assert.equal(
    await until(() => loader.get(day2.key).status === 'present', {
      ticks: 2000,
    }),
    true,
  );
  assert.equal(loader.get(day1.key).objectUrl, null);
  layer.setAssignment('a', day1.key);
  assert.equal(
    await until(() => eastCalls === 2 && !loader.get(day1.key).loading, {
      ticks: 2000,
    }),
    true,
  );
  await until(() => false, { ticks: 50 });
  const entry = loader.get(day1.key);
  assert.deepEqual(
    {
      available: entry.availableBoxes.length,
      empty: entry.emptyBoxes.length,
      layers: globe.layers.length,
    },
    { available: 1, empty: 1, layers: 1 },
  );
  layer.destroy();
});
