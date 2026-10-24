// The gauge card in Spanish, Russian and Chinese: the app's own words
// translate; gauge names, ids and the agency credit stay as NWPS sends them.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale } from '../../i18n/index.js';
import { buildRiverGaugeCard } from './cards.js';

const NOW = Date.parse('2026-10-24T02:00:00Z');
const gauge = {
  lid: 'MODR1',
  name: 'Guadalupe River at Victoria',
  state: 'TX',
  observed: {
    stage: 24.31,
    stageUnit: 'ft',
    flow: 31.2,
    flowUnit: 'kcfs',
    category: 'moderate',
    time: '2026-10-24T01:15:00Z',
  },
  forecast: {
    stage: 25.1,
    stageUnit: 'ft',
    flow: null,
    flowUnit: null,
    category: 'major',
    time: '2026-10-25T12:00:00Z',
  },
};
const detail = {
  lid: 'MODR1',
  usgsId: '08176500',
  inService: true,
  stageUnit: 'ft',
  thresholds: {
    action: { stage: 20, flow: null },
    minor: { stage: 21, flow: null },
    moderate: { stage: 24, flow: null },
    major: { stage: 28, flow: null },
  },
  crests: {
    historic: [{ time: '1936-07-03T00:00:00Z', stage: 33.4, flow: null }],
    recent: [{ time: '2024-06-21T00:00:00Z', stage: 22.1, flow: null }],
  },
};

test('English card: category, reading with age, forecast, stages, crests, link', () => {
  const card = buildRiverGaugeCard(gauge, detail, NOW);
  assert.equal(card.title, 'Guadalupe River at Victoria');
  assert.deepEqual(card.details, [
    'RIVER GAUGE · NWS MODR1 · TX',
    'Moderate flooding',
    'Stage 24.31\u00a0ft · Flow 31.2\u00a0kcfs · observed 45 minutes ago',
    'Forecast 25.1\u00a0ft · Major flooding · in 34 hours',
    'Flood stages (ft): action 20 · minor 21 · moderate 24 · major 28',
    'Recent crest 22.1\u00a0ft on Jun 21, 2024',
    'Highest crest 33.4\u00a0ft on Jul 3, 1936',
    'USGS site 08176500',
    'NWPS gauge page ↗ · click card to open',
    'NOAA/NWS National Water Prediction Service',
  ]);
  assert.equal(card.interactive, true);
  assert.equal(card.accent, '#ff2020');
  const plain = buildRiverGaugeCard(gauge, undefined, NOW, { link: false });
  assert.equal(plain.interactive, false);
  assert.ok(plain.details.includes('Loading flood stages…'));
  assert.ok(!plain.details.some((line) => line.includes('↗')));
});

for (const [locale, words] of [
  ['es', ['Inundación moderada', 'Niveles de inundación', 'Cresta reciente']],
  ['ru', ['Умеренное затопление', 'Уровни затопления', 'Недавний пик']],
  ['zh-CN', ['中度洪水', '洪水水位', '近期洪峰']],
]) {
  test(`${locale}: the card's own words translate, data stays as sent`, () => {
    setLocale(locale);
    try {
      const card = buildRiverGaugeCard(gauge, detail, NOW);
      const text = card.details.join('\n');
      for (const word of words) assert.ok(text.includes(word), word);
      for (const english of [
        'Moderate flooding',
        'Flood stages',
        'Recent crest',
        'Highest crest',
        'observed',
        'click card',
        'RIVER GAUGE',
      ])
        assert.ok(!text.includes(english), `${locale}: ${english}`);
      assert.equal(card.title, gauge.name);
      assert.ok(text.includes('MODR1') && text.includes('08176500'));
    } finally {
      setLocale('en');
    }
  });
}
