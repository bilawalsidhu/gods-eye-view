// The Transit selection card follows the UI language. The copy builder
// stays free of i18n (AI tools import policy.js); the browser hands it t().
import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale, t } from '../../i18n/index.js';
import { buildTransitSelectionCopy } from './policy.js';

const feed = { name: 'Metro Transit', region: 'Minneapolis–St Paul, MN' };
const now = 1_788_936_960_000;
const record = {
  id: 'T1',
  label: 'T1',
  routeId: 'Blue',
  lat: 44.9,
  lon: -93.4,
  bearing: 248,
  speedMps: 11.2,
  timestamp: 1_788_936_900,
  timestampSource: 'header',
  stopId: '57458',
  status: 'STOPPED_AT',
  occupancy: 'FEW_SEATS_AVAILABLE',
};

test('en: the copy is unchanged with and without the i18n t()', () => {
  setLocale('en');
  const plain = buildTransitSelectionCopy(feed, record, 'subway', now);
  assert.deepEqual(
    buildTransitSelectionCopy(feed, record, 'subway', now, null, null, t),
    plain,
  );
  assert.deepEqual(plain.details, [
    'Subway · Metro Transit · Minneapolis–St Paul, MN',
    'Reported 60 s ago (feed time)',
    'reported 40 km/h · reported hdg 248°',
    'Last report: stopped at stop 57458 · few seats available',
    'Shown at street level · depth not in the feed',
    'Vehicle T1',
  ]);
});

test('a report 90 seconds old reads as 1 minute, not 2', () => {
  setLocale('en');
  const line = (ageMs) =>
    buildTransitSelectionCopy(
      feed,
      {
        id: 'age',
        lat: 1,
        lon: 1,
        timestamp: Math.floor((now - ageMs) / 1000),
        timestampSource: 'vehicle',
      },
      'bus',
      now,
    ).details[1];
  assert.equal(line(89_000), 'Reported 89 s ago');
  assert.equal(line(90_000), 'Reported 1 min ago');
  assert.equal(line(120_000), 'Reported 2 min ago');
});

for (const locale of ['es', 'ru']) {
  test(`${locale}: the Transit card is in the UI language`, () => {
    setLocale(locale);
    try {
      const copy = buildTransitSelectionCopy(
        feed,
        record,
        'subway',
        now,
        null,
        null,
        t,
      );
      const text = [copy.title, ...copy.details].join(' | ');
      for (const english of [
        'Route',
        'Subway',
        'Reported',
        'reported',
        'Last report',
        'few seats',
        'street level',
        'Vehicle',
        'feed time',
      ])
        assert.ok(
          !text.includes(english),
          `${locale}: "${english}" in ${text}`,
        );
    } finally {
      setLocale('en');
    }
  });
}
