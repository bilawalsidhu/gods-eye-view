import test from 'node:test';
import assert from 'node:assert/strict';

import { createAlphaEarthLayer } from './index.js';
import { createAlphaEarthRenderer } from './rendering.js';
import { AlphaEarthSourceError, createAlphaEarthSource } from './source.js';
import {
  changePayload,
  fakeCollection,
  fakeRendererDeps,
  fakeSource,
  tick,
} from './testDoubles.mjs';

const BOX = { west: -97.64, south: 30.21, east: -97.6, north: 30.24 };

function setup() {
  const deps = fakeRendererDeps();
  const collection = fakeCollection();
  let hostInfo = { collection, kind: 'globe' };
  const source = fakeSource();
  const adopted = [];
  const layer = createAlphaEarthLayer({
    source,
    renderer: createAlphaEarthRenderer(deps),
    host: () => hostInfo,
  });
  layer.attachDataManager({
    adoptLayerParams: (id, params) => adopted.push({ id, params }),
  });
  return {
    deps,
    collection,
    source,
    layer,
    adopted,
    setHost: (next) => {
      hostInfo = next;
    },
  };
}

test('a box compares the default years and drapes one layer', async () => {
  const { layer, source, collection, deps, adopted } = setup();
  layer.enable({});
  await tick();
  assert.deepEqual(layer.getSnapshot().years, [2017, 2018, 2024]);
  assert.equal(layer.setBox(BOX), true);
  assert.equal(layer.getSnapshot().status, 'loading');
  assert.equal(source.requests.length, 1);
  assert.deepEqual(source.requests[0].query.box, BOX);
  assert.equal(source.requests[0].query.from, 2018);
  assert.equal(source.requests[0].query.to, 2024);
  source.requests[0].resolve(changePayload());
  await tick();
  const snapshot = layer.getSnapshot();
  assert.equal(snapshot.status, 'ready');
  assert.equal(snapshot.result.pixelMeters, 160);
  assert.equal(snapshot.result.changedFraction, 0.571);
  assert.equal(collection.layers.length, 1);
  assert.equal(deps.cesium.providers[0].options.tileWidth, 4);
  assert.match(deps.cesium.providers[0].options.url, /@0\.35$/);
  assert.equal(adopted[0].id, 'alpha-earth-change');
  assert.equal(adopted[0].params.west, -976400);
});

test('the threshold repaints without a request; years re-request', async () => {
  const { layer, source, collection, deps } = setup();
  layer.enable({});
  await tick();
  layer.setBox(BOX);
  source.requests[0].resolve(changePayload());
  await tick();
  layer.setThreshold(0.9);
  assert.equal(source.requests.length, 1);
  assert.equal(collection.layers.length, 1);
  assert.match(deps.cesium.providers.at(-1).options.url, /@0\.9$/);
  assert.equal(layer.getSnapshot().result.changedFraction, 0.571);
  layer.setThreshold(0.05);
  assert.equal(layer.getSnapshot().result.changedFraction, 1);

  assert.equal(layer.setYears(2024, 2017), true);
  assert.equal(collection.layers.length, 0, 'a stale map never stays up');
  assert.equal(source.requests.length, 2);
  assert.equal(source.requests[1].query.from, 2017);
  assert.equal(layer.setYears(2018, 2030), false, 'unpublished years refused');
});

test('a newer request supersedes a slower one', async () => {
  const { layer, source } = setup();
  layer.enable({});
  await tick();
  layer.setBox(BOX);
  layer.setDetail('high');
  assert.equal(source.requests.length, 2);
  assert.equal(source.requests[1].query.detail, 'high');
  source.requests[1].resolve(changePayload({ width: 8, height: 2 }));
  await tick();
  assert.equal(layer.getSnapshot().result.width, 8);
  assert.equal(layer.getSnapshot().status, 'ready');
});

test('refusals and failures are reported, not hidden', async () => {
  const { layer, source, collection } = setup();
  layer.enable({});
  await tick();
  assert.equal(layer.setBox({ west: 0, south: 0, east: 2, north: 2 }), false);
  assert.match(layer.getSnapshot().boxError, /limit 100 km/);
  assert.equal(source.requests.length, 0);
  layer.setBox(BOX);
  assert.equal(layer.getSnapshot().boxError, null);
  source.requests[0].reject(new AlphaEarthSourceError('no_coverage', 'No embeddings'));
  await tick();
  assert.equal(layer.getSnapshot().status, 'error');
  assert.equal(layer.getSnapshot().error, 'No embeddings');
  assert.equal(collection.layers.length, 0);
  assert.equal(layer.retry(), true);
  assert.equal(source.requests.length, 2);
});

test('the drape follows the host and leaves on disable', async () => {
  const { layer, source, collection, setHost } = setup();
  layer.enable({});
  await tick();
  layer.setBox(BOX);
  source.requests[0].resolve(changePayload());
  await tick();
  const tileset = fakeCollection();
  setHost({ collection: tileset, kind: 'tileset' });
  layer.getStats();
  assert.equal(collection.layers.length, 0);
  assert.equal(tileset.layers.length, 1);
  setHost({ collection: null, kind: 'none' });
  layer.getStats();
  assert.equal(tileset.layers.length, 0);
  assert.match(layer.getSnapshot().hostError, /globe/);
  setHost({ collection, kind: 'globe' });
  layer.getStats();
  assert.equal(collection.layers.length, 1);
  layer.disable();
  assert.equal(collection.layers.length, 0);
  layer.enable({});
  assert.equal(collection.layers.length, 1, 'the last result comes back');
  assert.equal(source.requests.length, 1);
  layer.destroy();
  assert.equal(collection.layers.length, 0);
});

test('params restore a comparison and round-trip', async () => {
  const { layer, source } = setup();
  layer.setParams({
    west: -976400,
    south: 302100,
    east: -976000,
    north: 302400,
    from: 2017,
    to: 2024,
    threshold: 50,
    detail: 'high',
  });
  assert.equal(source.requests.length, 0, 'nothing loads while disabled');
  layer.enable({});
  await tick();
  assert.equal(source.requests.length, 1);
  assert.deepEqual(source.requests[0].query.box, BOX);
  assert.equal(source.requests[0].query.from, 2017);
  assert.equal(source.requests[0].query.detail, 'high');
  assert.deepEqual(layer.getParams(), {
    west: -976400,
    south: 302100,
    east: -976000,
    north: 302400,
    from: 2017,
    to: 2024,
    threshold: 50,
    detail: 'high',
  });
});

test('the source maps server errors and checks the grid encoding', async () => {
  const replies = [
    { ok: true, status: 200, json: async () => ({ years: [2024, 2018] }) },
    { ok: false, status: 404, json: async () => ({ error: 'no_coverage' }) },
    { ok: true, status: 200, json: async () => ({ encoding: 'png' }) },
    { ok: true, status: 200, json: async () => changePayload() },
  ];
  const urls = [];
  const source = createAlphaEarthSource({
    fetchImpl: async (url) => {
      urls.push(url);
      return replies.shift();
    },
  });
  assert.deepEqual(await source.listYears(), [2018, 2024]);
  const query = { box: BOX, from: 2018, to: 2024 };
  await assert.rejects(source.fetchChange(query), (error) =>
    error.code === 'no_coverage' && /No embeddings/.test(error.message),
  );
  await assert.rejects(source.fetchChange(query), /Unknown grid encoding/);
  assert.equal((await source.fetchChange(query)).width, 4);
  assert.match(urls[1], /^\/api\/alpha-earth\/change\?west=-97\.64&south=30\.21/);
  assert.match(urls[1], /detail=standard/);
});
