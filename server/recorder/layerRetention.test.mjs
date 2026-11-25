import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanSettings, parseLayerRetention, recorderConfig } from './config.js';
import { createRecorder } from './recorder.js';
import { openHistoryStore } from './store.js';

const row = (o) => ({
  id: 'a',
  layer: 'air',
  lat: 10,
  lon: 10,
  alt: 0,
  heading: 0,
  speed: 0,
  ts: 1000,
  ...o,
});

test('layer retention text is read and checked', () => {
  assert.deepEqual(parseLayerRetention('sat=1d, local = 30d'), {
    sat: '1d',
    local: '30d',
  });
  assert.deepEqual(parseLayerRetention(''), {});
  assert.deepEqual(parseLayerRetention({ air: '6h' }), { air: '6h' });
  assert.throws(() => parseLayerRetention('boat=1d'), /Unknown layer/);
  assert.throws(() => parseLayerRetention('sat'), /Bad layer retention/);
  assert.throws(() => parseLayerRetention('sat=soon'), /Bad retention/);
});

test('settings and the environment carry layer retention in seconds', () => {
  const { runtime, file } = cleanSettings({ layerRetention: 'sat=1d,local=0' });
  assert.deepEqual(runtime.layerRetention, { sat: 86400, local: 0 });
  assert.deepEqual(file.layerRetention, { sat: '1d', local: '0' });
  assert.deepEqual(
    recorderConfig({ GEV_HISTORY_LAYER_RETENTION: 'sat=1d' }).layerRetention,
    { sat: 86400 },
  );
  assert.deepEqual(recorderConfig({}).layerRetention, {});
});

test('purgeBefore can take one layer, or leave some layers alone', () => {
  const store = openHistoryStore(':memory:');
  const fill = () =>
    store.insertMany([
      row({ id: 'a', layer: 'air' }),
      row({ id: 's', layer: 'sat' }),
      row({ id: 'v', layer: 'vessel' }),
    ]);
  fill();
  assert.equal(store.purgeBefore(2000, { only: 'sat' }), 1);
  assert.equal(store.purgeBefore(2000, { skip: ['air'] }), 1);
  assert.equal(store.window({ from: 0, to: 5000 }).length, 1);
  store.close?.();
});

test('each layer is purged on its own clock, and 0 keeps a layer for ever', async () => {
  let clock = 100000 * 1000;
  const rec = createRecorder({
    file: ':memory:',
    retentionSec: 1000,
    layerRetention: { sat: 100, local: 0 },
    now: () => clock,
  });
  const old = 100000 - 500; // older than sat's 100 s, within general 1000 s
  const ancient = 100000 - 5000; // older than the general time
  rec.store.insertMany([
    row({ id: 'air-old', layer: 'air', ts: old }),
    row({ id: 'air-ancient', layer: 'air', ts: ancient }),
    row({ id: 'sat-old', layer: 'sat', ts: old }),
    row({ id: 'local-ancient', layer: 'local', ts: ancient }),
  ]);
  assert.deepEqual(rec.settings().layerRetention, { sat: 100, local: 0 });
  await rec.purgeNow();
  const left = rec.store
    .window({ from: 0, to: 200000 })
    .map((p) => p.id)
    .sort();
  assert.deepEqual(left, ['air-old', 'local-ancient']);
  rec.close();
});
