import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AT,
  fireAt,
  piece,
  snapshot,
  harness,
} from '../../testSupport/perimeterLayerHarness.mjs';

const ids = (h, kind) => [...h.items(kind).keys()].sort();

test('a piece id with a lone UTF-16 surrogate does not fail the read', async () => {
  const fires = [fireAt('a', -120, 38)];
  const lone = JSON.parse('"x\\ud800"');
  const h = harness(() =>
    snapshot(fires, [
      piece('a', 'ok', AT),
      piece('a', lone, AT, { lon: -121 }),
    ]),
  );
  assert.equal(await h.layer.update(), true);
  assert.equal(h.items('fills').size, 2);
  h.layer.destroy();
});

test('after a read that met a bad id, the next good read matches a fresh draw (addition)', async () => {
  const fires = [fireAt('a', -120, 38)];
  const pX = piece('a', 'pX', AT, { lon: -120.5 });
  let pieces = [piece('a', 'p1', AT)];
  const h = harness(() => snapshot(fires, pieces));
  await h.layer.update();
  pieces = [piece('a', 'p1', AT), pX, piece('a', '\uD800', AT, { lon: -121 })];
  await h.layer.update();
  pieces = [piece('a', 'p1', AT), pX, piece('a', 'fixed', AT, { lon: -121 })];
  assert.equal(await h.layer.update(), true);
  const fresh = harness(() => snapshot(fires, pieces));
  await fresh.layer.update();
  assert.deepEqual(ids(h, 'fills'), ids(fresh, 'fills'));
  assert.deepEqual(ids(h, 'lines'), ids(fresh, 'lines'));
  h.layer.destroy();
  fresh.layer.destroy();
});

test('after a read that met a bad id, the next good read matches a fresh draw (removal)', async () => {
  const fires = [fireAt('a', -120, 38)];
  let pieces = [piece('a', 'p1', AT), piece('a', 'p2', AT, { lon: -120.5 })];
  const h = harness(() => snapshot(fires, pieces));
  await h.layer.update();
  pieces = [piece('a', 'p1', AT), piece('a', '\uD800', AT, { lon: -121 })];
  await h.layer.update();
  pieces = [piece('a', 'p1', AT), piece('a', 'good', AT, { lon: -121 })];
  assert.equal(await h.layer.update(), true);
  const fresh = harness(() => snapshot(fires, pieces));
  await fresh.layer.update();
  assert.deepEqual(ids(h, 'fills'), ids(fresh, 'fills'));
  assert.deepEqual(ids(h, 'lines'), ids(fresh, 'lines'));
  h.layer.destroy();
  fresh.layer.destroy();
});
