import assert from 'node:assert/strict';
import test from 'node:test';
import { createGnssIntegrityLayer } from './index.js';
import { fakeCameraPort } from '../../testSupport/fakeCameraPort.mjs';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';

function layerWith(getSnapshot, now) {
  const viewer = { scene: { globe: { show: true } } };
  bindFakeDraw(viewer, { camera: fakeCameraPort().port });
  const layer = createGnssIntegrityLayer({
    source: { getSnapshot },
    viewAnchor: () => ({ latitude: 50, longitude: 30 }),
    now,
    monotonicNow: () => 10_000,
  });
  layer.init(viewer);
  return layer;
}

test('no numeric headline while the first sample is pending or failed', async (t) => {
  let now = 10_000;
  let fail = true;
  const layer = layerWith(
    async () => {
      if (fail) throw new Error('network down');
      return { ageMs: 500, rows: [] };
    },
    () => now,
  );
  t.after(() => layer.destroy());
  layer.enable();
  // Pending: nothing sampled yet.
  assert.equal(
    layer.getContextSummary({ population: layer.getContextPopulation() })
      ?.headline,
    undefined,
    'pending: no "0 areas"',
  );
  await layer.update();
  assert.equal(
    layer.getStats().lastUpdate ?? null,
    null,
    'no successful sample yet',
  );
  assert.equal(
    layer.getContextSummary({ population: layer.getContextPopulation() })
      ?.headline,
    undefined,
    'failed: no "0 areas"',
  );
  // A successful empty sample may say "0 areas".
  now += 30_000; // The failed read starts a retry cooldown.
  fail = false;
  assert.equal(await layer.update(), true);
  assert.equal(
    layer.getContextSummary({ population: layer.getContextPopulation() })
      .headline,
    '0 areas',
  );
});
