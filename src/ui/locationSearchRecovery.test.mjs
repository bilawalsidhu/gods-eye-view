import assert from 'node:assert/strict';
import test from 'node:test';
import { NavigationController } from './navigationController.js';
import { LocationNavigation } from './locationNavigation.js';

function settle() {
  const asked = [];
  const owner = {
    _activeLocationSearchGeneration: 4,
    settleSearch: (settled) => asked.push(settled),
  };
  NavigationController.prototype._settleLocationSearchUi.call(owner, 4);
  return { owner, asked };
}

test('a settled search settles the presentation once', () => {
  const { owner, asked } = settle();
  assert.equal(owner._activeLocationSearchGeneration, null);
  assert.equal(asked.length, 1);
  NavigationController.prototype._settleLocationSearchUi.call(owner, 4);
  assert.equal(asked.length, 1);
});

function navigation() {
  // The Omnibar renders the error from the controls' published view
  // (src/ui/commandDock.test.mjs).
  const errors = [];
  const settled = [];
  const toasts = [];
  const owner = {
    _disposed: false,
    _locationControls: { setSearchError: (message) => errors.push(message) },
    _activeLocationSearchGeneration: null,
    _settleLocationSearchUi: (generation) => settled.push(generation),
    _showToast: (message) => toasts.push(message),
    _setLocationSearchError:
      LocationNavigation.prototype._setLocationSearchError,
  };
  const handle = (status, type) =>
    LocationNavigation.prototype._handleLocationSearchState.call(
      owner,
      { status, query: 'Pariss' },
      { type, generation: 7 },
    );
  return { owner, errors, settled, toasts, handle };
}

for (const [status, text] of [
  ['missing', 'Location not found'],
  ['failed', 'Search failed'],
]) {
  test(`a ${status} search announces a lasting error in the Omnibar instead of a toast`, () => {
    const n = navigation();
    n.handle('searching', 'started');
    n.handle(status, status);
    n.handle(status, 'settled');
    assert.match(n.errors.at(-1), new RegExp(`^${text}\\. `));
    assert.deepEqual(n.settled, [7]);
    assert.deepEqual(n.toasts, []);
    n.handle('searching', 'started');
    assert.equal(n.errors.at(-1), null);
  });
}
