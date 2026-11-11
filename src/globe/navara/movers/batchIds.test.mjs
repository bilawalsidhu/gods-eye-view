import assert from 'node:assert/strict';
import test from 'node:test';
import { createBatchIdPool } from './batchIds.js';

// A view context that never takes an id back, as Navara 0.2.1's core.
function fakeContext() {
  let next = 0;
  return {
    issued: () => next,
    genGlobalBatchId: () => ++next,
  };
}

// The wrapper's part that matters here: one id per instance, from its ctx.
const wrapper = (ctx, count) => ({
  batchIds: Array.from({ length: count }, () => ctx.genGlobalBatchId() ?? 0),
});

test('a rebuilt set takes the ids of the set it replaces', () => {
  const ctx = fakeContext();
  const pool = createBatchIdPool();
  let set = wrapper(pool.source(ctx), 1000);
  for (let attach = 0; attach < 50; attach++) {
    pool.release(set);
    set = wrapper(pool.source(ctx), 1000);
  }
  assert.equal(ctx.issued(), 1000);
  assert.equal(new Set(set.batchIds).size, 1000);
});

test('live sets never share an id, and a set gives its ids back once', () => {
  const ctx = fakeContext();
  const pool = createBatchIdPool();
  const a = wrapper(pool.source(ctx), 3);
  pool.release(a);
  pool.release(a);
  const b = wrapper(pool.source(ctx), 2);
  const c = wrapper(pool.source(ctx), 2);
  const ids = [...b.batchIds, ...c.batchIds];
  assert.equal(new Set(ids).size, 4);
  assert.equal(ctx.issued(), 4);
});

test('ids Navara could not give (0) are not pooled', () => {
  const pool = createBatchIdPool();
  pool.release({ batchIds: [0, 0, 7] });
  pool.release(null);
  const none = { genGlobalBatchId: () => undefined };
  assert.equal(pool.source(none).genGlobalBatchId(), 7);
  assert.equal(pool.source(none).genGlobalBatchId(), undefined);
});

test('everything else reaches the view context itself', () => {
  const ctx = {
    _meshes: new Map(),
    genGlobalBatchId: () => 1,
    registerPickableMesh(key, wrapper) {
      this._meshes.set(key, wrapper);
    },
  };
  const source = createBatchIdPool().source(ctx);
  source.registerPickableMesh('a', 'wrapper');
  assert.equal(ctx._meshes.get('a'), 'wrapper');
  assert.equal(source._meshes, ctx._meshes);
});
