// A failed tool step: the card shows the tool error in the UI language; the
// result keeps gevActions' English for the model.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale } from '../i18n/index.js';
import { attachVoiceResult, spokenLabel } from './speech.js';
import {
  initialVoiceCardState,
  reduceVoiceCard,
  voiceCardView,
} from './voiceCardPresentation.js';

// Error texts as gevActions.js builds them (frameOverhead, select_nearest_aircraft).
const CASES = [
  {
    name: 'frame_overhead',
    args: { target: 'military' },
    result: {
      ok: false,
      action: 'frame_overhead',
      layerId: 'military',
      error: 'The military layer is not enabled',
    },
  },
  {
    name: 'select_nearest_aircraft',
    args: { locationQuery: 'Madrid' },
    result: {
      ok: false,
      action: 'select_nearest_aircraft',
      stage: 'nearest',
      cancelled: false,
      error:
        'Live Flights is enabled, but no airborne aircraft is loaded in the Madrid view yet',
      location: { label: 'Madrid' },
      layer: { label: 'Live Flights' },
      feed: { state: 'nominal', source: 'OpenSky' },
      count: 0,
    },
  },
  {
    name: 'frame_overhead',
    args: { target: 'flights' },
    result: {
      ok: false,
      action: 'frame_overhead',
      layerId: 'flights',
      radiusKm: 150,
      count: 0,
      error: 'No flights within 150 km of the current view',
    },
  },
];

function cardFor(locale, { name, args, result }) {
  setLocale(locale);
  let state = reduceVoiceCard(initialVoiceCardState(), {
    type: 'action-call',
    id: 'c1',
    name,
    arguments: args,
  });
  state = reduceVoiceCard(state, {
    type: 'action-result',
    id: 'c1',
    name,
    result: attachVoiceResult(name, result, args),
  });
  return voiceCardView(state);
}

for (const locale of ['es', 'ru']) {
  for (const c of CASES) {
    test(`${locale}: ${c.name} failure shows the card lines in the UI language`, () => {
      const view = cardFor(locale, c);
      try {
        assert.ok(view.result.visible, 'card shows a result');
        assert.notEqual(view.result.title, '', 'card has a title');
        // Title and step status are translated.
        assert.notEqual(
          view.steps[0].statusText,
          'failed',
          'step status translated',
        );
        // The error line is translated, not the raw English.
        for (const line of view.result.lines) {
          assert.ok(
            !/\b(is not enabled|no airborne aircraft|of the current view)\b/.test(
              line,
            ),
            `English tool error shown under ${locale} title "${view.result.title}" / step "${view.steps[0].label}: ${view.steps[0].statusText}": "${line}"`,
          );
        }
      } finally {
        setLocale('en');
      }
    });
  }
}

test('en: the card shows the tool error as the model got it', () => {
  for (const c of CASES) {
    const view = cardFor('en', c);
    // Whole, not cut at 80 characters: the card wraps an error line.
    assert.deepEqual(view.result.lines, [
      spokenLabel(c.result.error, Infinity),
    ]);
  }
});
