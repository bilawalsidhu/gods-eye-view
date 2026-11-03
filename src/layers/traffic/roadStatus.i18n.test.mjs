// The traffic road-status notes follow the UI language; English keeps
// its wording.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from '../../i18n/index.js';
import { createState } from './state.js';
import { createControls } from './controls.js';

function loadingLabel(overrides) {
  const state = createState({ services: {} });
  Object.assign(state, overrides);
  const controls = createControls({
    state,
    services: {},
    source: { getFlowSessionStats: () => ({}) },
    parts: { model: { trafficFeedPresentation: () => ({ loadingLabel: '' }) } },
  });
  return controls.methods.getStats().loadingLabel;
}

const DEGRADED = {
  _liveMode: false,
  _roadMode: 'tomtom',
  _roadSource: 'OpenStreetMap',
  _roadPartial: true,
  _detailLimited: true,
  _surfacePending: 2,
};

test('en: road status notes keep their English wording', () => {
  setLocale('en');
  assert.equal(
    loadingLabel(DEGRADED),
    ' · Roads: OpenStreetMap · TomTom roads need a TomTom key · Local surface still loading · Partial coverage · Reduced detail coverage',
  );
  assert.equal(
    loadingLabel({ _roadError: 'x', _roadSource: 'OpenStreetMap' }),
    'UNAVAILABLE · OpenStreetMap · Roads unavailable',
  );
});

for (const locale of ['es', 'ru']) {
  test(`${locale}: road status notes are in the UI language`, () => {
    setLocale(locale);
    try {
      const label = loadingLabel({
        ...DEGRADED,
        _roadPartial: false,
        _roadWarning: 'OpenFreeMap tiles rate-limited',
      });
      for (const english of [
        'Roads:',
        'TomTom key',
        'still loading',
        'rate-limited',
        'detail coverage',
      ])
        assert.ok(
          !label.includes(english),
          `${locale}: "${english}" in ${label}`,
        );
    } finally {
      setLocale('en');
    }
  });
}

function roadChips(liveMode) {
  const state = createState({ services: {} });
  state._liveMode = liveMode;
  const controls = createControls({
    state,
    services: {},
    source: { getFlowSessionStats: () => ({}) },
    parts: {},
  });
  return controls.methods.getRowControls().chips;
}

test('en: road-source chips keep their English labels and titles', () => {
  setLocale('en');
  assert.deepEqual(
    roadChips(false).map((chip) => [chip.label, chip.title]),
    [
      [
        'TomTom',
        'TomTom roads only, each with its live flow (needs a TomTom key)',
      ],
      ['OSM', 'OpenStreetMap roads, with TomTom flow matched when available'],
      [
        'Hybrid',
        'TomTom roads first; OpenStreetMap fills the rest, simulated (needs a TomTom key)',
      ],
    ],
  );
  assert.equal(
    roadChips(true)[2].title,
    'TomTom roads first; OpenStreetMap fills the rest, simulated',
  );
});

for (const [locale, hybrid] of [
  ['ru', 'Гибрид'],
  ['es', 'Híbrido'],
]) {
  test(`${locale}: the Hybrid chip and every chip title are translated`, () => {
    setLocale(locale);
    try {
      for (const live of [false, true]) {
        const chips = roadChips(live);
        assert.deepEqual(
          chips.map((chip) => chip.label),
          ['TomTom', 'OSM', hybrid],
        );
        for (const chip of chips)
          assert.doesNotMatch(
            chip.title,
            /roads only|roads, with|fills the rest|needs a/,
            `${locale}: ${chip.title}`,
          );
      }
    } finally {
      setLocale('en');
    }
  });
}
