// Flights / Military feed failure texts reach the DATA LAYERS row in the
// UI language; the feeds keep them in English.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LayerPanel } from './layerPanel.js';
import { setLocale } from '../i18n/index.js';
import { httpError, LiveSourceError } from '../sources/live/contract.js';

const panel = LayerPanel.prototype;

function flightsRow(error) {
  return panel._buildMetaText({
    id: 'flights',
    enabled: true,
    stats: {
      count: 0,
      stale: true,
      error,
      status: 429,
      retryInSec: 45,
      source: 'OpenSky',
      lastUpdate: Date.now(),
    },
  });
}

const cases = [
  ['OpenSky 429 anonymous', 'OpenSky rate limited (anonymous)'],
  ['OpenSky auth', 'OpenSky auth required'],
  ['generic 429', httpError({ status: 429 }, 'Flights').message],
  ['HTTP 503', httpError({ status: 503 }, 'Military aircraft').message],
  [
    'network error',
    new LiveSourceError('unavailable', 'Flights network error').message,
  ],
  ['stale snapshot', 'Source snapshot 7 min old'],
  ['snapshot time unknown', 'Source snapshot time unavailable'],
  ['non-LiveSourceError', 'Live data unavailable'],
  ['malformed', 'Malformed OpenSky response'],
  ['malformed rows', 'Malformed adsb.lol aircraft rows'],
];

test('en: feed failure texts stay English', () => {
  setLocale('en');
  for (const [, message] of cases)
    assert.equal(
      flightsRow(message),
      `STALE · OpenSky · ${message} · retry 45s`,
    );
});

for (const locale of ['es', 'ru']) {
  test(`${locale}: feed failure texts are translated in the layer row`, () => {
    setLocale(locale);
    try {
      for (const [name, message] of cases) {
        const row = flightsRow(message);
        assert.ok(
          !row.includes(message),
          `${locale} ${name}: row still contains English detail: ${row}`,
        );
      }
      assert.match(flightsRow('Source snapshot 7 min old'), /\b7\b/);
      assert.match(flightsRow('Flights HTTP 503'), /\b503\b/);
    } finally {
      setLocale('en');
    }
  });
}
