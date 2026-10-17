// getStats().statusMessage is English data (it is also the analyst's empty
// note to the model); the displays show it in the UI language through
// translateStatusPiece (ui/statusText.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale, t, tn, translateKnown } from '../../i18n/index.js';
import { translateStatusPiece } from '../../ui/statusText.js';
import { createControls } from './controls.js';

function stats(state) {
  const layerState = { records: [], enabled: true, ...state };
  return createControls({
    state: layerState,
    services: {},
    parts: {},
    source: {},
  }).methods.getStats();
}

function inLocale(locale, run) {
  setLocale(locale);
  try {
    run();
  } finally {
    setLocale('en');
  }
}

// Each layer state, the English statusMessage it reports, and how the UI
// shows it. A retry a minute out reads "60s" (rounded up).
const cases = [
  [
    { status: 'empty', lastUpdate: 1 },
    'No mapped sites in view',
    () => t('No mapped sites in view'),
  ],
  [
    {
      status: 'ready',
      lastUpdate: 1,
      records: [{ kind: 'installation' }, { kind: 'installation' }],
    },
    '2 mapped sites in view',
    () => tn(2, '{count} mapped site in view', '{count} mapped sites in view'),
  ],
  [
    {
      status: 'empty',
      lastUpdate: 1,
      wide: true,
      coverage: { kind: 'subject', radiusM: 25000 },
    },
    'No mapped sites within 25 km of the contact',
    () => t('No mapped sites within {km} km of the contact', { km: '25' }),
  ],
  [
    {
      status: 'ready',
      lastUpdate: 1,
      wide: true,
      coverage: { kind: 'subject', radiusM: 25000 },
      records: [{ kind: 'installation' }],
    },
    '1 mapped site within 25 km of the contact',
    () =>
      tn(
        1,
        '{count} mapped site within {km} km of the contact',
        '{count} mapped sites within {km} km of the contact',
        { km: '25' },
      ),
  ],
  [
    { status: 'unavailable', failureReason: 'tiles_unavailable' },
    'Map tiles temporarily unavailable',
    () => t('Map tiles temporarily unavailable'),
  ],
  [
    {
      status: 'unavailable',
      failureReason: 'names_unavailable',
      get retryAt() {
        return Date.now() + 60_000;
      },
    },
    'Mapped names temporarily unavailable — retrying in 60s',
    () =>
      t('{reason} — retrying in {seconds}s', {
        reason: t('Mapped names temporarily unavailable'),
        seconds: 60,
      }),
  ],
  [
    { status: 'zoom-in' },
    'Zoom in to search mapped installations',
    () => t('Zoom in to search mapped installations'),
  ],
];

for (const locale of ['es', 'ru']) {
  test(`${locale}: installation statusMessage stays English data`, () => {
    inLocale(locale, () => {
      for (const [state, english] of cases)
        assert.equal(stats(state).statusMessage, english);
    });
  });

  test(`${locale}: installation statusMessage is shown in the UI language`, () => {
    inLocale(locale, () => {
      for (const [state, english, shown] of cases) {
        const shownText = translateStatusPiece(stats(state).statusMessage);
        assert.notEqual(shownText, english);
        assert.equal(shownText, shown());
      }
      for (const text of [
        'Too many mapped sites in view to list them all',
        'Installation context unavailable',
      ]) {
        assert.notEqual(translateKnown(text), text);
      }
    });
  });
}

test('en: installation feedback keeps its English wording', () => {
  setLocale('en');
  for (const [state, english] of cases) {
    assert.equal(stats(state).statusMessage, english);
    assert.equal(translateStatusPiece(english), english);
  }
});
