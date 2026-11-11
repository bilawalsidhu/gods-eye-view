import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENGINE_STORAGE_KEY,
  engineOfChoice,
  resolveEngineKind,
} from './engineChoice.js';

const storage = (value) => ({
  getItem: (key) => (key === ENGINE_STORAGE_KEY ? value : null),
});

test('Cesium is the default engine', () => {
  assert.equal(resolveEngineKind(), 'cesium');
  assert.equal(
    resolveEngineKind({ search: '', storage: storage(null) }),
    'cesium',
  );
  assert.equal(ENGINE_STORAGE_KEY, 'gev.engine');
});

test('?engine= chooses the engine and wins over storage', () => {
  assert.equal(resolveEngineKind({ search: '?engine=navara' }), 'navara');
  assert.equal(
    resolveEngineKind({
      search: '?x=1&engine=cesium',
      storage: storage('navara'),
    }),
    'cesium',
  );
  assert.equal(resolveEngineKind({ search: '?engine=NAVARA' }), 'navara');
});

test('the stored choice applies without a query', () => {
  assert.equal(
    resolveEngineKind({ search: '', storage: storage('navara') }),
    'navara',
  );
  assert.equal(
    resolveEngineKind({ search: '?lat=1', storage: storage(' navara ') }),
    'navara',
  );
});

test('unknown values and unreadable storage fall back to Cesium', () => {
  assert.equal(resolveEngineKind({ search: '?engine=unreal' }), 'cesium');
  assert.equal(
    resolveEngineKind({ search: '?engine=unreal', storage: storage('navara') }),
    'navara',
    'an unknown query value does not hide a valid stored choice',
  );
  assert.equal(resolveEngineKind({ storage: storage('unreal') }), 'cesium');
  const throwing = {
    getItem() {
      throw new Error('SecurityError');
    },
  };
  assert.equal(resolveEngineKind({ search: '', storage: throwing }), 'cesium');
});

test('Navara HD is a choice of the Navara engine', () => {
  assert.equal(
    resolveEngineKind({
      search: '?engine=navara-hd',
      storage: storage('cesium'),
    }),
    'navara-hd',
  );
  assert.equal(
    resolveEngineKind({ search: '', storage: storage('navara-hd') }),
    'navara-hd',
  );
  assert.equal(resolveEngineKind({ search: '?engine=navara-4k' }), 'cesium');
  assert.deepEqual(['cesium', 'navara', 'navara-hd'].map(engineOfChoice), [
    'cesium',
    'navara',
    'navara',
  ]);
});
