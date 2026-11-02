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

function settle(searchInput, options) {
  const owner = { _activeLocationSearchGeneration: 4, searchInput };
  NavigationController.prototype._settleLocationSearchUi.call(
    owner,
    4,
    options,
  );
  return owner;
}

test('a search that found nothing keeps its query, the open field and focus', () => {
  const field = input();
  const owner = settle(field, { keepQuery: true });
  assert.equal(owner._activeLocationSearchGeneration, null);
  assert.equal(field.value, 'Pariss');
  assert.equal(field.classList.contains('expanded'), true);
  assert.equal(field.classList.contains('searching'), false);
  assert.equal(field.focused, true);
  assert.equal(field.selected, true);
});

test('a search that arrived still clears and closes the field', () => {
  const field = input();
  field.focused = true;
  settle(field);
  assert.equal(field.value, '');
  assert.equal(field.classList.contains('expanded'), false);
  assert.equal(field.focused, false);
});

function navigation() {
  const field = input();
  const error = { id: 'location-search-error', textContent: '' };
  const settled = [];
  const toasts = [];
  const owner = {
    _disposed: false,
    _locationSearch: field,
    _locationSearchError: error,
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
  return { owner, field, error, settled, toasts, handle };
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
    assert.match(n.error.textContent, new RegExp(`^${text}\\. `));
    assert.equal(n.field.getAttribute('aria-invalid'), 'true');
    assert.equal(
      n.field.getAttribute('aria-describedby'),
      'location-search-error',
    );
    assert.deepEqual(n.settled, [[7, { keepQuery: true }]]);
    assert.deepEqual(n.toasts, []);
    n.handle('searching', 'started');
    assert.equal(n.error.textContent, '');
    assert.equal(n.field.getAttribute('aria-invalid'), null);
    assert.equal(n.field.getAttribute('aria-describedby'), null);
  });
}
