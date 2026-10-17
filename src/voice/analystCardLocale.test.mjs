// The analyst card shows its headline, scope, chips and caveats in the UI
// language; the spoken headline stays English for the model.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale } from '../i18n/index.js';
import { attachVoiceResult as withSpeech } from './speech.js';
import {
  initialVoiceCardState,
  reduceVoiceCard,
  voiceCardView,
} from './voiceCardPresentation.js';

function cardFor(name, result, args = {}) {
  const shaped = withSpeech(name, result, args);
  return {
    shaped,
    view: voiceCardView(
      [
        { type: 'action-call', callId: 'c1', name, arguments: args },
        { type: 'action-result', callId: 'c1', name, result: shaped },
      ].reduce(reduceVoiceCard, initialVoiceCardState()),
    ),
  };
}

const analyst = {
  ok: true,
  count: 3,
  complete: true,
  scopeLabel: 'anywhere in the loaded data',
  partial: true,
  feedState: 'degraded',
  unanswered: ['earthquakes'],
  coverage: { layersQueried: [{ layerKey: 'flights', source: 'OpenSky' }] },
  display: { scope: 'anywhere in the loaded data' },
  items: [],
};

const radius = {
  ...analyst,
  count: 1234,
  complete: false,
  partial: false,
  feedState: 'nominal',
  unanswered: [],
  scopeLabel: 'in view',
  display: {
    scope: 'within 42 km of the view centre',
    window: 'last 24 h',
    caveat:
      'counted 1,000 of 2,345 loaded records; earthquakes loading; flights: distance is ground distance, not overhead',
  },
  coverage: {
    layersQueried: [{ layerKey: 'flights', source: 'OpenSky' }],
    note: 'the flights layer loads by viewport',
  },
};

test('analyst card in es has no English text', () => {
  setLocale('es');
  try {
    const { view } = cardFor('analyst_query', analyst);
    assert.doesNotMatch(view.result.title, /anywhere in the loaded data/);
    assert.ok(!view.result.chips.includes('partial'));
    assert.ok(!view.result.chips.includes('degraded'));
    assert.ok(!view.result.notes.some((n) => n.startsWith('Not answered')));
  } finally {
    setLocale('en');
  }
});

test('analyst scope, window and caveats in ru', () => {
  setLocale('ru');
  try {
    const { shaped, view } = cardFor('analyst_query', radius);
    assert.match(shaped.say, /^At least 1,234 aircraft in view/);
    assert.doesNotMatch(
      JSON.stringify(view.result),
      /aircraft|within|view centre|last 24 h|counted|loading|ground distance|loads by viewport/,
    );
    assert.match(view.result.title, /^1\s234 /);
  } finally {
    setLocale('en');
  }
});

test('en: the card keeps its English text and names layers', () => {
  const { shaped, view } = cardFor('analyst_query', analyst);
  assert.equal(view.result.title, '3 aircraft anywhere in the loaded data');
  assert.deepEqual(view.result.chips, ['degraded', 'partial']);
  assert.ok(view.result.notes.includes('Not answered: Earthquakes (24h)'));
  // The model still gets the layer key.
  assert.match(shaped.say, /earthquakes not answered/);
  const capped = cardFor('analyst_query', radius).view.result;
  assert.equal(capped.title, 'At least 1,234 aircraft in view');
  assert.deepEqual(capped.lines, [
    'within 42 km of the view centre',
    'last 24 h',
  ]);
  assert.ok(capped.notes.includes('counted 1,000 of 2,345 loaded records'));
  assert.ok(capped.notes.includes('the flights layer loads by viewport'));
});
