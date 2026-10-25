// The station card in every shipped language: the app's own words translate;
// station names, codes, sensor ids and the facility credit stay as IOC sends
// them.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale } from '../../i18n/index.js';
import {
  SEA_LEVEL_PLOT_COLUMNS,
  buildSeaLevelCard,
  seaLevelPlot,
} from './cards.js';

const END = Date.parse('2026-10-24T20:20:00Z');
const station = {
  code: 'hoek',
  name: 'Hoek van Holland',
  country: 'Netherlands',
  sensor: 'flt',
  lastIso: '2026-10-24T20:20:00.000Z',
  lastValue: 0.54,
  ageMs: 20 * 60_000,
};
// A semidiurnal tide sampled every 10 minutes for 72 hours.
const points = Array.from({ length: 432 }, (_, i) => {
  const ms = END - (431 - i) * 600_000;
  return [
    ms,
    Math.round(Math.sin((ms / 3_600_000) * ((2 * Math.PI) / 12.42)) * 1000) /
      1000,
  ];
});
const series = {
  code: 'hoek',
  sensor: 'flt',
  count: 4320,
  min: -1.02,
  max: 1.05,
  latest: { iso: '2026-10-24T20:20:00.000Z', value: 0.54 },
  points,
};

test('English card: band, reading with age, sensor time, plot, range, caveats, link', () => {
  const card = buildSeaLevelCard(station, series);
  assert.equal(card.title, 'Hoek van Holland');
  const [plot, ...rest] = card.details.slice(4);
  assert.deepEqual(card.details.slice(0, 4), [
    'SEA LEVEL STATION · IOC hoek · Netherlands',
    'Reporting (within 3 h)',
    'Last reading 0.54 m · 20 minutes ago',
    'Sensor flt · Oct 24, 2026, 20:20 UTC',
  ]);
  assert.equal([...plot].length, SEA_LEVEL_PLOT_COLUMNS);
  assert.deepEqual(rest, [
    'Last 72 h: low -1.02 m · high 1.05 m',
    'Latest 0.54 m is at 75% of that range',
    'Levels are against this gauge’s own datum; never compare stations',
    'Raw data, not quality controlled',
    'IOC station page ↗ · click card to open',
    'IOC Sea Level Station Monitoring Facility (VLIZ)',
  ]);
  assert.equal(card.interactive, true);
  assert.equal(card.accent, '#38c6f4');
  const plain = buildSeaLevelCard(station, undefined, { link: false });
  assert.equal(plain.interactive, false);
  assert.ok(plain.details.includes('Loading the last 72 hours…'));
  assert.ok(!plain.details.some((line) => line.includes('↗')));
});

test('the plot spans the station’s own range and leaves gaps where it has no reading', () => {
  const plot = [...seaLevelPlot(series, END)];
  assert.equal(plot.length, SEA_LEVEL_PLOT_COLUMNS);
  assert.ok(plot.includes('▁') && plot.includes('█'));
  const gappy = [
    ...seaLevelPlot({ ...series, points: points.slice(216) }, END),
  ];
  assert.equal(gappy.slice(0, 18).join(''), ' '.repeat(18));
  assert.equal(
    seaLevelPlot({ ...series, points: points.slice(0, 1) }, END),
    null,
  );
  assert.equal(
    seaLevelPlot({ ...series, points: points.map(([ms]) => [ms, 1]) }, END),
    null,
  );
});

test('silent and unread stations say so without inventing a reading', () => {
  const silent = buildSeaLevelCard(
    { ...station, lastIso: null, lastValue: null, ageMs: null },
    { ...series, latest: null, points: [] },
  );
  assert.ok(silent.details.includes('Silent (over 24 h)'));
  assert.ok(silent.details.includes('No reading reported'));
  assert.ok(silent.details.includes('No readings in the last 72 hours'));
  const failed = buildSeaLevelCard(station, null);
  assert.ok(failed.details.includes('Last 72 hours unavailable'));
});

for (const locale of ['es', 'ru', 'zh-CN']) {
  test(`${locale}: the card's own words translate, data stays as sent`, () => {
    setLocale(locale);
    try {
      const card = buildSeaLevelCard(station, series);
      const text = card.details.join('\n');
      for (const english of [
        'SEA LEVEL STATION',
        'Reporting',
        'Last reading',
        'minutes ago',
        'Last 72 h',
        'of that range',
        'own datum',
        'quality controlled',
        'click card',
      ])
        assert.ok(!text.includes(english), `${locale}: ${english}`);
      assert.equal(card.title, station.name);
      assert.ok(text.includes('hoek') && text.includes('flt'));
      assert.ok(
        text.includes('IOC Sea Level Station Monitoring Facility (VLIZ)'),
      );
    } finally {
      setLocale('en');
    }
  });
}
