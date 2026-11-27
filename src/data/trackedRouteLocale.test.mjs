// The tracked-flight route warning is localized with the readout.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createTracking } from '../layers/flights/tracking.js';
import { setLocale, t } from '../i18n/index.js';

const ID = 'civ001';
const RECORD = {
  callsign: 'N12345',
  altitude: 10_668,
  velocity: 250,
  verticalRate: 0,
  airline: 'TEST AIR',
  typeName: 'A320',
  route: {
    origin: { code: 'AUS' },
    destination: { code: 'LAX' },
    source: 'adsbdb',
    retrievedAtMs: null,
    operatingDate: null,
    verification: 'unverified-reference',
  },
};

/**
 * The production tracker over one contact. The contact has no drawn position
 * (no billboard, no icon), so route plausibility cannot judge the route and
 * keeps it.
 */
function trackingFor(record) {
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
  return createTracking({
    flightState: {
      records: { data: new Map([[ID, record]]), missingPolls: new Map() },
      feed: { _backoff: false },
      _billboards: new Map(),
    },
    services,
    parts: {
      queries: { _contactLabel: (_, info) => info.callsign },
      icons: { _iconPosition: () => null },
      motion: { _signalLost: () => null },
    },
    layer: {},
  });
}

afterEach(() => setLocale('en'));

for (const locale of ['ru', 'zh-CN']) {
  test(`${locale} tracked route label is fully localized`, () => {
    setLocale(locale);
    const warning = t('UNVERIFIED ROUTE');
    assert.notEqual(warning, 'UNVERIFIED ROUTE', `${locale} translates it`);
    const routeLine = trackingFor(RECORD)
      ._trackedLabelText(ID)
      .split('\n')
      .find((line) => line.startsWith('AUS → LAX'));
    assert.equal(routeLine, `AUS → LAX · ${warning}`);
  });
}
