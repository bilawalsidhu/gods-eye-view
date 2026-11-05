// Layer status texts arrive as English data and show in the UI language by
// their shape; English shows exactly as it came.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale, t } from '../i18n/index.js';
import {
  translateFeedError,
  translateStatusLine,
  translateStatusMessage,
} from './statusText.js';

function inLocale(locale, run) {
  setLocale(locale);
  try {
    return run();
  } finally {
    setLocale('en');
  }
}

const STATUS_LINES = [
  'feed 1090 unreachable',
  'feeds 1090, entry 2 invalid',
  '3 heard · USB 5.8 msg/s · feed 1090 stale',
  '2 feeds live · 14 heard',
  'TTC 0 (95s old)',
  'TTC 0 · GO Transit 4 (95s old)',
  'Loading TTC, MiWay',
];

test('en: status lines and errors show as they came', () => {
  setLocale('en');
  for (const text of [
    ...STATUS_LINES,
    'ECCC HTTP 503',
    'GNSS feed unavailable (HTTP 503)',
    'Upstream response too large',
  ]) {
    assert.equal(translateFeedError(text), text);
    assert.equal(translateStatusLine(text), text);
  }
});

for (const locale of ['es', 'ru']) {
  test(`${locale}: a lone feed problem translates like a joined one`, () => {
    inLocale(locale, () => {
      const lone = translateFeedError('feed 1090 unreachable');
      assert.doesNotMatch(lone, /unreachable/, lone);
      assert.equal(
        translateFeedError('feed 1090 unreachable · 2 heard').split(' · ')[0],
        lone,
      );
    });
  });

  test(`${locale}: a feed with no band is named in the UI language`, () => {
    inLocale(locale, () => {
      const shown = translateFeedError('feeds 1090, entry 2 invalid');
      assert.doesNotMatch(shown, /\b(entry|invalid)\b/, shown);
      assert.ok(shown.includes(t('entry {n}', { n: 2 })), shown);
      assert.ok(shown.includes('1090'), shown);
    });
  });

  test(`${locale}: a quiet transit feed keeps its name and numbers`, () => {
    inLocale(locale, () => {
      const shown = translateStatusLine('TTC 0 · GO Transit 4 (95s old)');
      assert.doesNotMatch(shown, /\bold\b/, shown);
      assert.ok(shown.startsWith('TTC 0 · GO Transit 4 '), shown);
      assert.ok(shown.includes('95'), shown);
    });
  });

  test(`${locale}: a known error shows its catalog entry`, () => {
    inLocale(locale, () => {
      const text = 'Upstream response too large';
      assert.notEqual(t(text), text, 'the catalog has the entry');
      assert.equal(translateFeedError(text), t(text));
    });
  });
}

// A layer's coverage note when no feed covers the view: one sentence with a
// " · " in it (transit/queries.js, bikeshare/controls.js).
const COVERAGE_NOTES = [
  'Fly below 2,850 km to a covered region',
  'No feed here yet · 16 regions available',
  'Fly below 48 km to a covered city',
  'No bike share here yet · 61 systems available',
];

test('en: coverage notes show as they came', () => {
  setLocale('en');
  for (const text of COVERAGE_NOTES)
    assert.equal(translateStatusMessage(text), text);
  assert.equal(
    translateStatusMessage('No bike share here yet · 1 systems available'),
    'No bike share here yet · 1 system available',
  );
});

for (const locale of ['es', 'ru', 'ja']) {
  test(`${locale}: a coverage note translates whole, numbers kept`, () => {
    inLocale(locale, () => {
      for (const text of COVERAGE_NOTES) {
        const shown = translateStatusMessage(text);
        assert.doesNotMatch(
          shown,
          /\b(Fly|below|covered|feed|bike share|available)\b/,
          shown,
        );
        const number = /[\d,]+(?= km| regions| systems)/.exec(text)[0];
        assert.ok(
          shown.replace(/[^\d]/g, '').includes(number.replace(/,/g, '')),
          shown,
        );
      }
    });
  });

  test(`${locale}: a status message without a coverage note keeps its other forms`, () => {
    inLocale(locale, () => {
      assert.equal(
        translateStatusMessage('Upstream response too large'),
        t('Upstream response too large'),
      );
      assert.equal(
        translateStatusMessage('2 feeds live · 14 heard'),
        translateStatusLine('2 feeds live · 14 heard'),
      );
    });
  });
}
