import test from 'node:test';
import assert from 'node:assert/strict';
import { until } from '../../testSupport/kartaViewFakes.mjs';
import { createRecentImagerySource } from './source.js';
import { createThumbnailLoader } from './thumbnails.js';
import { createRecentImageryLayer } from './index.js';
import { createRecentImageryRenderer } from './rendering.js';
import { fakeGlobePort } from '../../testSupport/fakeGlobePort.mjs';
import { candidate } from './testDoubles.mjs';

const PLAIN = { west: -98, south: 30, east: -97, north: 31 };
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

test('hls-missing-header: a shown HLS day on a plain box stays on the map after a 200 without Data-Present', async () => {
  const day = candidate('S30', '2026-11-10');
  let release;
  const gate = new Promise((r) => (release = r));
  const { layer, loader, globe } = realLayer({
    candidates: [day],
    fetchImpl: async () => {
      await gate;
      return answer(null);
    },
  });
  layer.enable();
  layer.setBox(PLAIN);
  assert.equal(
    await until(() => globe.layers.length === 1, { ticks: 2000 }),
    true,
  );
  release();
  assert.equal(
    await until(() => loader.get(day.key).status === 'error', { ticks: 2000 }),
    true,
  );
  await until(() => false, { ticks: 50 });
  const shownA = layer.getSnapshot().shown.a;
  assert.equal(
    globe.layers.length,
    1,
    `layers=${globe.layers.length} shown.a=${shownA} availableBoxes=${JSON.stringify(loader.get(day.key).availableBoxes)}`,
  );
  layer.destroy();
});
