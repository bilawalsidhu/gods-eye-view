import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AT,
  HOUR,
  fireAt,
  piece,
  snapshot,
  harness,
} from '../../testSupport/perimeterLayerHarness.mjs';

/** The pieces in fill draw order across the layer's fill sets, oldest set first. */
const fillOrder = (h) => {
  const out = [];
  for (const id of h.renderer.testing.sets()) {
    if (!id.startsWith('fire-perimeters:') || !id.endsWith(':fills')) continue;
    for (const itemId of h.renderer.testing.setRecord(id).items.keys())
      out.push(itemId.split(':').slice(1, 3).join(':'));
  }
  return out;
};

test('an older piece that arrives late is drawn under the newer one, as a fresh draw does', async () => {
  const fires = [fireAt('a', -120, 38)];
  const A = piece('a', 'A', AT - 40 * HOUR);
  const B = piece('a', 'B', AT - HOUR);
  let pieces = [B];
  const h = harness(() => snapshot(fires, pieces));
  await h.layer.update();
  pieces = [A, B];
  await h.layer.update();
  const fresh = harness(() => snapshot(fires, pieces));
  await fresh.layer.update();
  assert.deepEqual(fresh.items('fills').size, 2);
  assert.deepEqual(fillOrder(h), fillOrder(fresh));
  h.layer.destroy();
  fresh.layer.destroy();
});

test('a replaced older piece keeps its place under the newer one', async () => {
  const fires = [fireAt('a', -120, 38)];
  const B = piece('a', 'B', AT - HOUR);
  let pieces = [piece('a', 'A1', AT - 40 * HOUR), B];
  const h = harness(() => snapshot(fires, pieces));
  await h.layer.update();
  pieces = [piece('a', 'A2', AT - 40 * HOUR), B];
  await h.layer.update();
  const fresh = harness(() => snapshot(fires, pieces));
  await fresh.layer.update();
  assert.deepEqual(fillOrder(h), fillOrder(fresh));
  h.layer.destroy();
  fresh.layer.destroy();
});
