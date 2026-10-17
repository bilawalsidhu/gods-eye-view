// The analyst card's empty notes can be a layer's status line: Local ADS-B
// with every decoder feed stale, Transit with a quiet feed ("(95s old)") or
// its getStats().coverage text. The card shows them in the UI language; the
// model gets the English.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale } from '../i18n/index.js';
import { attachVoiceResult } from './speech.js';
import {
  initialVoiceCardState,
  reduceVoiceCard,
  voiceCardView,
} from './voiceCardPresentation.js';

function viewFor(layer, caveat) {
  const shaped = attachVoiceResult(
    'analyst_query',
    {
      ok: true,
      count: 0,
      complete: true,
      scopeLabel: 'in view',
      feedState: 'nominal',
      unanswered: [],
      coverage: { layersQueried: [{ ...layer, status: 'empty' }] },
      display: { scope: 'in view', caveat },
      items: [],
    },
    {},
  );
  return voiceCardView(
    [
      {
        type: 'action-call',
        callId: 'c1',
        name: 'analyst_query',
        arguments: {},
      },
      {
        type: 'action-result',
        callId: 'c1',
        name: 'analyst_query',
        result: shaped,
      },
    ].reduce(reduceVoiceCard, initialVoiceCardState()),
  );
}

function notesFor(layerKey, caveat) {
  return viewFor({ layerKey }, caveat).result.notes;
}

function inLocale(locale, run) {
  setLocale(locale);
  try {
    run();
  } finally {
    setLocale('en');
  }
}

// Caveat = `${layerKey}: ${getEmptyNote(layerKey)}` (data/analystEngine.js;
// gevActions.js getEmptyNote → stats.coverage || stats.statusMessage).
const cases = [
  ['local-adsb', 'local-adsb: feeds 1090, 978 stale · 0 heard'],
  ['local-adsb', 'local-adsb: feed 1090 stale · 0 heard'],
  ['transit', 'transit: TTC 0 (95s old)'],
  ['transit', 'transit: TTC 0 · GO Transit 0 (95s old)'],
];

// Transit's coverage text when nothing is in view (transit/queries.js).
const transitCoverage = [
  'transit: Fly below 3,000 km to a covered region',
  'transit: No feed here yet · 12 regions available',
];

for (const locale of ['es', 'ru']) {
  for (const [layerKey, caveat] of cases) {
    test(`${locale}: analyst note "${caveat}" is translated`, () => {
      inLocale(locale, () => {
        const notes = notesFor(layerKey, caveat);
        assert.ok(notes.length > 0, 'the note is shown');
        assert.doesNotMatch(notes.join(' | '), /\b(stale|heard|old)\b/);
      });
    });
  }

  test(`${locale}: Transit's empty note is translated on the analyst card`, () => {
    inLocale(locale, () => {
      for (const caveat of transitCoverage) {
        const view = viewFor(
          { layerKey: 'transit', source: 'GTFS-RT' },
          caveat,
        );
        const text = JSON.stringify(view.result);
        assert.doesNotMatch(
          text,
          /Fly below|No feed here yet|regions available/,
          text,
        );
      }
    });
  });
}

for (const [layerKey, caveat] of cases) {
  test(`en: analyst note "${caveat}" keeps its status line`, () => {
    setLocale('en');
    const line = caveat.slice(caveat.indexOf(': ') + 2);
    assert.ok(
      notesFor(layerKey, caveat).some((note) => note.endsWith(`: ${line}`)),
    );
  });
}
