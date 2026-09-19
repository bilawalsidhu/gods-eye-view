import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, getStore, __resetStoreForTests } from './sessions-store.js';

afterEach(() => {
  __resetStoreForTests();
});

describe('server/ondemand/sessions-store.js', () => {
  test('get/set/delete round-trip', () => {
    const store = createStore(10);
    assert.equal(store.get('u1'), undefined);
    store.set('u1', { sessionId: 's1', createdAt: 'a', lastUsedAt: 'a' });
    assert.deepEqual(store.get('u1'), { sessionId: 's1', createdAt: 'a', lastUsedAt: 'a' });
    assert.equal(store.delete('u1'), true);
    assert.equal(store.get('u1'), undefined);
  });

  test('evicts the least-recently-used entry once maxEntries is exceeded', () => {
    const store = createStore(3);
    store.set('a', { sessionId: 'sa', createdAt: '', lastUsedAt: '' });
    store.set('b', { sessionId: 'sb', createdAt: '', lastUsedAt: '' });
    store.set('c', { sessionId: 'sc', createdAt: '', lastUsedAt: '' });
    assert.equal(store.size(), 3);
    // Touch 'a' so 'b' becomes the least-recently-used entry.
    store.get('a');
    store.set('d', { sessionId: 'sd', createdAt: '', lastUsedAt: '' });
    assert.equal(store.size(), 3);
    assert.equal(store.get('b'), undefined, 'b should have been evicted');
    assert.notEqual(store.get('a'), undefined, 'a should survive (recently touched)');
    assert.notEqual(store.get('c'), undefined, 'c should survive');
    assert.notEqual(store.get('d'), undefined, 'd should survive (just inserted)');
  });

  test('re-setting an existing key does not evict anything and updates its value', () => {
    const store = createStore(2);
    store.set('a', { sessionId: 's1', createdAt: '', lastUsedAt: '' });
    store.set('b', { sessionId: 's2', createdAt: '', lastUsedAt: '' });
    store.set('a', { sessionId: 's1-updated', createdAt: '', lastUsedAt: '' });
    assert.equal(store.size(), 2);
    assert.equal(store.get('a').sessionId, 's1-updated');
    assert.notEqual(store.get('b'), undefined);
  });

  test('getStore() is memoised on globalThis across calls', () => {
    const first = getStore();
    const second = getStore();
    assert.equal(first, second);
    first.set('shared', { sessionId: 'x', createdAt: '', lastUsedAt: '' });
    assert.deepEqual(second.get('shared'), { sessionId: 'x', createdAt: '', lastUsedAt: '' });
  });

  test('__resetStoreForTests() makes getStore() return a fresh store', () => {
    const first = getStore();
    first.set('will-be-lost', { sessionId: 'x', createdAt: '', lastUsedAt: '' });
    __resetStoreForTests();
    const second = getStore();
    assert.notEqual(first, second);
    assert.equal(second.get('will-be-lost'), undefined);
  });
});
