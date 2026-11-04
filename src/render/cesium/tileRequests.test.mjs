import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTileRequestHook } from './tileRequests.js';

class Provider {
  constructor() {
    this._tilingScheme = { name: 'geographic' };
    this.calls = [];
  }
  get tilingScheme() {
    return this._tilingScheme;
  }
  get credit() {
    return 'stock';
  }
  requestImage(x, y, level, request) {
    this.calls.push([x, y, level, request]);
    return Promise.resolve({ x, y, level });
  }
}

test('the hook decides each tile request and issues it on the provider', async () => {
  const provider = new Provider();
  const seen = [];
  const hooked = withTileRequestHook(provider, {
    requestImage: (tile, issue) => {
      seen.push(tile);
      return tile.level > 3 ? undefined : issue();
    },
  });
  const request = {};
  assert.deepEqual(await hooked.requestImage(1, 2, 3, request), {
    x: 1,
    y: 2,
    level: 3,
  });
  assert.equal(hooked.requestImage(1, 2, 4), undefined, 'deferred');
  assert.deepEqual(seen, [
    { x: 1, y: 2, level: 3, request },
    { x: 1, y: 2, level: 4, request: undefined },
  ]);
  assert.deepEqual(provider.calls, [[1, 2, 3, request]]);
});

test('the provider itself is left untouched and still read through', () => {
  const provider = new Provider();
  const own = Object.getOwnPropertyNames(provider);
  let credit = 'first';
  const hooked = withTileRequestHook(provider, {
    requestImage: (_tile, issue) => issue(),
    credit: () => credit,
  });
  assert.deepEqual(Object.getOwnPropertyNames(provider), own);
  assert.equal(provider.requestImage, Provider.prototype.requestImage);
  assert.equal(provider.credit, 'stock');
  assert.equal(hooked.tilingScheme, provider.tilingScheme);
  assert.equal(hooked.credit, 'first');
  credit = 'refreshed';
  assert.equal(hooked.credit, 'refreshed', 'read every time');
});

test('without hooks the provider answers as it is', () => {
  const provider = new Provider();
  const hooked = withTileRequestHook(provider);
  hooked.requestImage(0, 0, 0);
  assert.equal(provider.calls.length, 1);
  assert.equal(hooked.credit, 'stock');
});
