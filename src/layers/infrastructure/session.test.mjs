import test from 'node:test';
import assert from 'node:assert/strict';
import { createInfrastructureSessionLayer } from './index.js';

test('a bundled file delivered between planets keeps multipart IDs and is read only once', async (t) => {
  let deliver,
    reads = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    reads++;
    return {
      ok: true,
      text: () =>
        new Promise((resolve) => {
          deliver = resolve;
        }),
    };
  });
  const captures = [];
  const layer = createInfrastructureSessionLayer(
    { id: 'local-dams', name: 'Dams', url: '/dams' },
    {},
    () => ({
      show: (data) => captures.push(data),
      hide() {},
      destroy() {},
      lod() {},
    }),
  );
  layer.init(null, { engine: {} });
  const enabled = layer.enable();
  await new Promise(setImmediate);
  layer.detachRenderer();
  const ring = [
    [10, 20],
    [10.02, 20],
    [10, 20.01],
    [10, 20],
  ];
  deliver(
    JSON.stringify({
      type: 'Feature',
      id: 'd',
      properties: { name: 'Dam' },
      geometry: {
        type: 'MultiPolygon',
        coordinates: [[ring], [ring]],
      },
    }),
  );
  await enabled;
  assert.equal(layer.getAnalystRecords().length, 2);
  assert.equal(captures.length, 0);
  await layer.attachRenderer(null, { engine: {} });
  layer.detachRenderer();
  await layer.attachRenderer(null, { engine: {} });
  assert.equal(captures[0], captures[1]);
  assert.deepEqual(
    captures[0].records.map((r) => r.id),
    ['d', 'd_2'],
  );
  assert.equal(reads, 1);
  layer.destroy();
});

test('a released scene stops waiting for a stalled dataset load, which stays in the session', async (t) => {
  let deliver;
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    text: () =>
      new Promise((resolve) => {
        deliver = resolve;
      }),
  }));
  const captures = [];
  const layer = createInfrastructureSessionLayer(
    { id: 'local-dams', name: 'Dams', url: '/dams' },
    {},
    () => ({
      show: (data) => captures.push(data),
      hide() {},
      destroy() {},
      lod() {},
    }),
  );
  layer.init(null, { engine: {} });
  const enabled = layer.enable();
  await new Promise(setImmediate);
  layer.detachRenderer();
  const scene = new AbortController();
  const attaching = layer.attachRenderer(null, {
    engine: {},
    signal: scene.signal,
  });
  scene.abort();
  await attaching;
  layer.detachRenderer();
  deliver(
    JSON.stringify({
      type: 'Feature',
      id: 'd',
      properties: { name: 'Dam' },
      geometry: { type: 'Point', coordinates: [10, 20] },
    }),
  );
  await enabled;
  assert.equal(captures.length, 0);
  assert.equal(layer.getAnalystRecords().length, 1);
});
