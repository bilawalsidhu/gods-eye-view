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

test('exact aircraft search frames a fresh single match without starting follow', () => {
  let called = null;
  const owner = {
    viewer: { camera: { flyTo: (options) => { called = options; } } },
    services: {
      flightsLayer: {
        findExactFlightMatches: () => ({
          status: 'found',
          matches: [{
            callsign: 'UAL123', icao24: 'abc123', latitude: 40,
            longitude: -73, altitudeM: 1250,
          }],
        }),
      },
    },
  };
  const identity = { kind: 'callsign', value: 'UAL123' };
  const result = LocationNavigation.prototype._searchObservedFlight.call(
    owner, identity, { beforeFly: () => true },
  );
  assert.equal(result.navigationMode, 'aircraft-snapshot');
  assert.match(result.label, /not following/);
  assert.ok(called?.destination);
  assert.equal(called.duration, 2.3);
});

test('flight search never moves the camera on ambiguous, disabled or cancelled lookup', () => {
  let moved = 0;
  const owner = {
    viewer: { camera: { flyTo: () => moved++ } },
    services: { flightsLayer: {
      findExactFlightMatches: () => ({
        status: 'found',
        matches: [{ icao24: 'abc123' }, { icao24: 'def456' }],
      }),
    } },
  };
  const invoke = (options) =>
    LocationNavigation.prototype._searchObservedFlight.call(
      owner, { kind: 'callsign', value: 'UAL123' }, options,
    );
  assert.throws(() => invoke(), /Several aircraft match/);
  owner.services.flightsLayer.findExactFlightMatches = () => ({ status: 'disabled', matches: [] });
  assert.throws(() => invoke(), /Enable Live Flights/);
  owner.services.flightsLayer.findExactFlightMatches = () => ({
    status: 'found', matches: [{ icao24: 'abc123', latitude: 40, longitude: -73, altitudeM: 900 }],
  });
  assert.deepEqual(invoke({ beforeFly: () => false }), { cancelled: true });
  assert.equal(moved, 0);
});

test('flight lookup refusals remain visible after failed lookup settles', () => {
  const n = navigation();
  n.handle('searching', 'started');
  LocationNavigation.prototype._handleLocationSearchState.call(
    n.owner,
    { status: 'failed', query: 'UAL123', error: { message: 'Flight search: No exact match in currently loaded flights.' } },
    { type: 'failed', generation: 7 },
  );
  assert.equal(n.errors.at(-1), 'Flight search: No exact match in currently loaded flights.');
});
