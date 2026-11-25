// Selected and pointed aircraft voice answers qualify undated routes.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createTracking } from '../layers/flights/tracking.js';
import { setLocale } from '../i18n/index.js';
import { attachVoiceResult } from '../voice/speech.js';

const ID = 'civ001';
const ROUTE = {
  origin: { code: 'AUS' },
  destination: { code: 'LAX' },
  source: 'adsbdb',
  retrievedAtMs: null,
  operatingDate: null,
  verification: 'unverified-reference',
};

/** The selection context the production tracker publishes for one contact. */
function selectedContext() {
  const services = Object.fromEntries(
    [
      'context',
      'trails',
      'geoid',
      'groundFloor',
      'focus',
      'militaryRegistry',
      'readout',
      'camera',
      'picking',
    ].map((name) => [name, {}]),
  );
  services.aircraftPresentation = { isTr3b: () => false };
  const tracking = createTracking({
    flightState: {
      records: {
        data: new Map([[ID, { callsign: 'N12345' }]]),
        missingPolls: new Map(),
      },
      feed: { _backoff: false, _lastSource: 'Fixture aircraft' },
      // No drawn position (no billboard, no icon): the route is kept.
      _billboards: new Map(),
    },
    services,
    parts: {
      queries: {
        _contactLabel: (_, info) => info.callsign,
        _describeFlight: () => ({
          callsign: 'N12345',
          airline: 'TEST AIR',
          typeName: 'A320',
          altitudeM: 10_668,
          velocityMps: 250,
          track: 95,
          latitude: 30.1945,
          longitude: -97.6699,
          route: ROUTE,
        }),
      },
      icons: { _iconPosition: () => null },
      motion: { _signalLost: () => null },
    },
    layer: {},
  });
  return tracking._contextSubjectMetadata(ID);
}

/** A pointed contact, shaped as `describeTargetEntity` (gevActions.js) returns it. */
const POINTED = {
  id: ID,
  name: 'N12345',
  layerId: 'flights',
  layerName: 'Live Flights',
  source: null,
  properties: {
    name: 'N12345',
    callsign: 'N12345',
    operator: 'TEST AIR',
    type: 'A320',
    route: 'AUS → LAX',
    routeVerification: 'unverified-reference',
  },
  active: true,
};

const answer = (selected) =>
  attachVoiceResult('get_entity_context', {
    ok: true,
    action: 'get_entity_context',
    scope: 'selected',
    selected,
  });

afterEach(() => setLocale('en'));

test('selected voice answer keeps the unverified-route qualification', () => {
  const selected = selectedContext();
  assert.equal(selected.properties.route, 'AUS → LAX');
  assert.equal(selected.properties.routeVerification, 'unverified-reference');
  assert.match(
    answer(selected).identityLine,
    /AUS to LAX \(unverified route\)/,
  );
});

test('pointed voice answer keeps the unverified-route qualification', () => {
  assert.match(answer(POINTED).identityLine, /AUS to LAX \(unverified route\)/);
});

test('ru voice card translates the route warning', () => {
  setLocale('ru');
  const line = answer(selectedContext()).display.lines.find((l) =>
    /AUS/.test(l),
  );
  assert.equal(line, 'Маршрут AUS → LAX (не подтверждён)');
});
