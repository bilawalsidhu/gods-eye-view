import assert from 'node:assert/strict';
import test from 'node:test';
import { LocationNavigation } from './locationNavigation.js';
import { LocationSearch } from './locationSearch.js';

const search = LocationNavigation.prototype._searchFlightOrPlace;

/** A navigation owner whose flight lookup answers `outcome`. */
function owner(outcome, { tracks = true } = {}) {
  const calls = { tracked: [], toasts: [], places: 0 };
  const layer = {
    trackById: (id, options) => {
      calls.tracked.push([id, options]);
      return tracks;
    },
  };
  return {
    calls,
    self: {
      _flightNumberSearch: { find: async () => outcome },
      services: { flightsLayer: layer, militaryFlightsLayer: layer },
      _showToast: (text) => calls.toasts.push(text),
    },
    places: (answer) => async () => {
      calls.places++;
      return answer;
    },
  };
}

const flight = { label: 'ZX 123' };
const options = { beforeFly: () => true };

test('a loaded flight resolves to that aircraft, without a place search', async () => {
  const { self, calls, places } = owner({
    status: 'found',
    flight,
    layerId: 'flights',
    match: { icao24: 'abc123', callsign: 'ZXY123' },
  });
  const result = await search.call(self, 'ZX 123', options, places(null));
  assert.deepEqual(result, {
    kind: 'aircraft',
    label: 'ZXY123',
    flightLabel: 'ZX 123',
    icao24: 'abc123',
    layerId: 'flights',
  });
  assert.equal(calls.places, 0);
  // Following waits for the lookup's `found`, so it cannot cancel the lookup.
  assert.deepEqual(calls.tracked, []);
});

test('a vetoed hand-off cancels instead of resolving', async () => {
  const { self, places } = owner({
    status: 'found',
    flight,
    layerId: 'flights',
    match: { icao24: 'abc123', callsign: 'ZXY123' },
  });
  const result = await search.call(
    self,
    'ZX 123',
    { beforeFly: () => false },
    places(null),
  );
  assert.deepEqual(result, { cancelled: true });
});

const follow = LocationNavigation.prototype._followSearchedAircraft;
const destination = {
  icao24: 'abc123',
  layerId: 'military',
  label: 'ZXY123',
  flightLabel: 'ZX 123',
};

test('a found flight is followed on its own layer as a user action', () => {
  const { self, calls } = owner(null);
  const errors = [];
  self._setLocationSearchError = (text) => errors.push(text);
  assert.equal(follow.call(self, destination), true);
  assert.deepEqual(calls.tracked, [['abc123', { origin: 'user' }]]);
  assert.equal(calls.toasts.length, 1);
  assert.match(calls.toasts[0], /ZXY123/);
  assert.deepEqual(errors, []);
});

test('failed tracking never claims success', () => {
  const { self, calls } = owner(null, { tracks: false });
  const errors = [];
  self._setLocationSearchError = (text) => errors.push(text);
  assert.equal(follow.call(self, destination), false);
  assert.equal(calls.toasts.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /ZXY123/);
});

test('several matching aircraft ask for a callsign instead of choosing', async () => {
  const { self, calls, places } = owner({
    status: 'ambiguous',
    flight,
    matches: [
      { layerId: 'flights', match: { icao24: 'a', callsign: 'ZXY7' } },
      { layerId: 'military', match: { icao24: 'b', callsign: 'ZXO7' } },
    ],
  });
  const result = await search.call(self, 'ZX 7', options, places(null));
  assert.match(result.missingMessage, /ZXY7, ZXO7/);
  assert.deepEqual(calls.tracked, []);
});

test('a flight number with no aircraft still reaches place search first', async () => {
  const place = { label: 'A10' };
  const miss = { status: 'none', flight, reason: 'no-contact' };
  const found = owner(miss);
  assert.equal(
    await search.call(found.self, 'A10', options, found.places(place)),
    place,
  );
  const missing = owner(miss);
  const result = await search.call(
    missing.self,
    'ZX 123',
    options,
    missing.places(null),
  );
  assert.match(result.missingMessage, /ZX 123/);
});

test('ordinary text is a place search with the ordinary miss', async () => {
  const { self, places } = owner({ status: 'not-flight' });
  assert.equal(
    await search.call(self, 'Atlantis', options, places(null)),
    null,
  );
});

test('the lookup reports a flight miss as missing, with its message', async () => {
  const lookup = new LocationSearch({
    begin: () => 1,
    isCurrent: () => true,
    beforeFly: () => true,
    search: async () => ({ missingMessage: 'No aircraft is flying ZX 123.' }),
  });
  const results = [];
  lookup.onResult = () => results.push('found');
  await lookup.run('ZX 123');
  assert.deepEqual(results, []);
  assert.equal(lookup.getState().status, 'missing');
  assert.equal(
    lookup.getState().missingMessage,
    'No aircraft is flying ZX 123.',
  );
  lookup.destroy();
});
