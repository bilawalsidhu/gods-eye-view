// The selected-fire card of Fire Perimeters and its accessible
// label follow the UI language, like the legend of the same layer
// (perimeters/index.js). cards.test.mjs pins the English card.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale, t } from '../../i18n/index.js';
import { buildIncidentCard } from './cards.js';

const now = Date.UTC(2026, 9, 14);
const row = {
  stableId: 'x',
  name: 'Lake',
  acres: 1200,
  containedPct: 40,
  state: 'CA',
  discoveredTime: now - 2 * 3600e3,
  updatedTime: now - 3600e3,
  cause: 'Human',
  behavior: 'Moderate',
  complexity: 'Type 3 Incident',
  personnel: 1500,
  county: 'Plumas',
  costToDate: 4200000,
  complexName: 'NORTH COMPLEX',
};

test('en: the fire card keeps its English wording', () => {
  setLocale('en');
  const card = buildIncidentCard(row, now, { link: 'https://inciweb.example' });
  assert.equal(card.title, 'FIRE · Lake');
  assert.deepEqual(card.details, [
    '1,200 ac · 40% contained · CA',
    'part of North Complex',
    'Human cause · Moderate · Type 3 Incident',
    '1,500 personnel · Plumas County · $4.2M to date',
    'discovered 2h ago · updated 1h ago',
    'InciWeb ↗ · click card to open',
  ]);
  assert.equal(card.accessibilityLabel, 'Open FIRE · Lake on InciWeb');
});

for (const locale of ['es', 'ru']) {
  test(`${locale}: selected fire card follows the UI language`, () => {
    setLocale(locale);
    try {
      assert.notEqual(
        t('Fully contained'),
        'Fully contained',
        'legend is translated',
      );
      const card = buildIncidentCard(row, now, {
        link: 'https://inciweb.example',
      });
      const text = [card.title, ...card.details, card.accessibilityLabel].join(
        ' | ',
      );
      for (const english of [
        'FIRE',
        ' ac ',
        'contained',
        'discovered',
        'updated',
        'part of',
        'cause',
        'personnel',
        'County',
        'to date',
        'click card to open',
        'Open ',
      ])
        assert.ok(
          !text.includes(english),
          `${locale}: English "${english}" in ${text}`,
        );
      assert.ok(
        !text.includes('1,200'),
        `${locale}: en-US grouping in ${text}`,
      );
    } finally {
      setLocale('en');
    }
  });
}

// Known WFIGS values, the cost and the unnamed title follow the
// UI language; the row keeps the feed's English for the AI tools.
const expected = {
  es: {
    situation: 'causa: humana · actividad moderada · incidente de tipo 3',
    cost: '4,2 M$ hasta la fecha',
    unnamed: 'INCENDIO · Sin nombre',
  },
  ru: {
    situation:
      'причина: деятельность человека · умеренная активность · инцидент 3-го типа',
    cost: '4,2 млн $ на сегодня',
    unnamed: 'ПОЖАР · Без названия',
  },
};

for (const [locale, want] of Object.entries(expected)) {
  test(`${locale}: feed values, cost and unnamed title are localized`, () => {
    setLocale(locale);
    try {
      const card = buildIncidentCard(row, now);
      assert.equal(card.details[2], want.situation);
      assert.ok(
        card.details[3].endsWith(want.cost),
        `${locale}: ${card.details[3]}`,
      );
      assert.equal(
        buildIncidentCard({ ...row, name: '' }, now).title,
        want.unnamed,
      );
      assert.equal(row.cause, 'Human', 'the row keeps the feed value');
    } finally {
      setLocale('en');
    }
  });
}

test('unknown WFIGS values are shown as sent', () => {
  setLocale('ru');
  try {
    const card = buildIncidentCard(
      {
        ...row,
        cause: 'Investigated',
        behavior: 'Smoldering',
        complexity: 'Complex Incident',
      },
      now,
    );
    assert.equal(
      card.details[2],
      'причина: Investigated · Smoldering · Complex Incident',
    );
  } finally {
    setLocale('en');
  }
});

test('en: compact costs keep the dollar prefix', () => {
  setLocale('en');
  const cost = (costToDate) =>
    buildIncidentCard({ ...row, costToDate }, now).details[3].split(' · ')[2];
  assert.equal(cost(85_000), '$85K to date');
  assert.equal(cost(999_600), '$1M to date');
  assert.equal(cost(1_300_000_000), '$1.3B to date');
});
