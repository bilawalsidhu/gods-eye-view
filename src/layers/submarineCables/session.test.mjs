import test from 'node:test';
import assert from 'node:assert/strict';
import { createCableSessionLayer } from './session.js';

test('cables arriving during handoff belong to the incoming display', async () => {
  let resolve,
    reads = 0;
  const shown = [];
  const layer = createCableSessionLayer({
    source: {
      label: 'fixture',
      fetch: () => {
        reads++;
        return new Promise((done) => {
          resolve = done;
        });
      },
    },
    createNavara: (engine) => ({
      show: (dataset) => shown.push([engine, dataset]),
      destroy() {},
      hide() {},
    }),
  });
  layer.init(null, { engine: 'outgoing' });
  const pending = layer.enable();
  layer.detachRenderer();
  const handoff = layer.attachRenderer(null, { engine: 'incoming' });
  const dataset = { cables: { features: [] }, landingPoints: { features: [] } };
  resolve(dataset);
  await Promise.all([pending, handoff]);
  assert.deepEqual(shown, [['incoming', dataset]]);
  assert.equal(reads, 1);
  layer.destroy();
});

test('a released scene stops waiting for a stalled cable load, which stays in the session', async () => {
  let resolve;
  const shown = [];
  const layer = createCableSessionLayer({
    source: {
      label: 'fixture',
      fetch: () =>
        new Promise((done) => {
          resolve = done;
        }),
    },
    createNavara: (engine) => ({
      show: (dataset) => shown.push([engine, dataset]),
      destroy() {},
      hide() {},
    }),
  });
  layer.init(null, { engine: 'outgoing' });
  const pending = layer.enable();
  layer.detachRenderer();
  const scene = new AbortController();
  const attaching = layer.attachRenderer(null, {
    engine: 'released',
    signal: scene.signal,
  });
  scene.abort();
  await attaching;
  layer.detachRenderer();
  const dataset = { cables: { features: [] }, landingPoints: { features: [] } };
  resolve(dataset);
  await pending;
  assert.deepEqual(shown, []);
  await layer.attachRenderer(null, { engine: 'next' });
  assert.deepEqual(shown, [['next', dataset]]);
  layer.destroy();
});
