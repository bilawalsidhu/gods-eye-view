import assert from 'node:assert/strict';
import test from 'node:test';
import { NavigationController } from './navigationController.js';
import { LocationNavigation } from './locationNavigation.js';

function input() {
  const classes = new Set(['expanded', 'searching']);
  const attributes = new Map();
  return {
    id: 'location-search',
    value: 'Pariss',
    focused: false,
    selected: false,
    classList: {
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
    },
    focus() {
      this.focused = true;
    },
    blur() {
      this.focused = false;
    },
    select() {
      this.selected = true;
    },
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: (name) => attributes.delete(name),
    getAttribute: (name) => attributes.get(name) ?? null,
  };
}

function settle(options) {
  const asked = [];
  const owner = {
    _activeLocationSearchGeneration: 4,
    settleSearch: (settled) => asked.push(settled),
  };
  NavigationController.prototype._settleLocationSearchUi.call(
    owner,
    4,
    options,
  );
  return { owner, asked };
}

// The location controls keep or clear the field (src/ui/locationControls.test.mjs).
test('a search that found nothing asks the field to keep its query', () => {
  const { owner, asked } = settle({ keepQuery: true });
  assert.equal(owner._activeLocationSearchGeneration, null);
  assert.deepEqual(asked, [{ keepQuery: true }]);
});

test('a search that arrived asks the field to clear, once', () => {
  const { owner, asked } = settle();
  assert.deepEqual(asked, [{ keepQuery: false }]);
  NavigationController.prototype._settleLocationSearchUi.call(owner, 4);
  assert.deepEqual(asked, [{ keepQuery: false }]);
});

function navigation() {
  const field = input();
  // The tray renders the error and the field's aria-invalid from the
  // controls' published view (src/ui/commandDock.test.mjs).
  const errors = [];
  const settled = [];
  const toasts = [];
  const owner = {
    _disposed: false,
    _locationSearch: field,
    _locationControls: { setSearchError: (message) => errors.push(message) },
    _activeLocationSearchGeneration: null,
    _settleLocationSearchUi: (generation, options) =>
      settled.push([generation, options]),
    _showToast: (message) => toasts.push(message),
    _setLocationSearchError:
      LocationNavigation.prototype._setLocationSearchError,
  };
  const handle = (status, type) =>
    LocationNavigation.prototype._handleLocationSearchState.call(
      owner,
      { status, query: field.value },
      { type, generation: 7 },
    );
  return { owner, field, errors, settled, toasts, handle };
}

for (const [status, text] of [
  ['missing', 'Location not found'],
  ['failed', 'Search failed'],
]) {
  test(`a ${status} search announces a lasting error on the field instead of a toast`, () => {
    const n = navigation();
    n.handle('searching', 'started');
    n.handle(status, status);
    n.handle(status, 'settled');
    assert.match(n.errors.at(-1), new RegExp(`^${text}\\. `));
    assert.deepEqual(n.settled, [[7, { keepQuery: true }]]);
    assert.deepEqual(n.toasts, []);
    n.handle('searching', 'started');
    assert.equal(n.errors.at(-1), null);
  });
}

test('Escape closes the search field only while it is open; panel collapse always', () => {
  let closed = 0;
  const owner = {
    _locationControls: {
      searchExpanded: false,
      closeSearch: () => (closed += 1),
    },
  };
  LocationNavigation.prototype.closeSearch.call(owner, { ifOpen: true });
  assert.equal(closed, 0);
  owner._locationControls.searchExpanded = true;
  LocationNavigation.prototype.closeSearch.call(owner, { ifOpen: true });
  assert.equal(closed, 1);
  owner._locationControls.searchExpanded = false;
  LocationNavigation.prototype.closeSearch.call(owner);
  assert.equal(closed, 2);
});
