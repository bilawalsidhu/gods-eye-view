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
