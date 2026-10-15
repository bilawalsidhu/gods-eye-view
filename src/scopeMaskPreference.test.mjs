import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readScopePreference,
  writeScopePreference,
  resolveScopeEnabled,
  SCOPE_PREFERENCE_KEY,
} from './scopeMaskPreference.js';
test('an explicit local Scope OFF choice survives a reload and authored ON state until the user opts back in', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key),
    setItem: (key, value) => values.set(key, value),
  };
  assert.equal(readScopePreference(storage), null);
  assert.equal(resolveScopeEnabled(true, null), true);
  writeScopePreference(false, storage);
  assert.equal(values.get(SCOPE_PREFERENCE_KEY), '0');
  assert.equal(resolveScopeEnabled(true, readScopePreference(storage)), false);
  writeScopePreference(true, storage);
  assert.equal(resolveScopeEnabled(true, readScopePreference(storage)), true);
  assert.equal(resolveScopeEnabled(false, readScopePreference(storage)), false);
});
test('malformed or blocked storage does not break scope controls', () => {
  assert.equal(readScopePreference({ getItem: () => '{bad' }), null);
  const denied = {
    getItem() {
      throw new Error('denied');
    },
    setItem() {
      throw new Error('denied');
    },
  };
  assert.equal(readScopePreference(denied), null);
  assert.doesNotThrow(() => writeScopePreference(false, denied));
});
