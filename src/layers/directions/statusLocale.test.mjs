// Directions reports its fixed errors as English data (getStats(), and so the
// layer snapshot the voice tools and the analyst read); the Layers panel row
// shows them in the UI language.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale, t as translate } from '../../i18n/index.js';
import { LayerPanel } from '../../ui/layerPanel.js';
import { directionsStats, presentRoutingFailure } from './index.js';

const idle = {
  enabled: true,
  mode: 'car',
  armed: null,
  a: null,
  b: null,
  status: 'idle',
  error: null,
  route: null,
  lastUpdate: null,
};

const cases = [
  [
    { ...idle, pointerBlocked: true },
    'Another map tool is using clicks — close it, then SET A again',
  ],
  [{ ...idle, status: 'error' }, 'No route found'],
  [
    { ...idle, status: 'error', error: 'Routing timed out' },
    'Routing timed out',
  ],
];

function rowFor(stats) {
  return LayerPanel.prototype._buildMetaText({
    id: 'directions',
    enabled: true,
    stats,
  });
}

// Route request failures with the proxy's refusal or an HTTP status in them:
// [the request error, its English row error, the row text in the language]
const failures = () => [
  [
    { status: 429, refusal: 'route leg too long' },
    'route leg too long — try again in a moment',
    translate('{error} — try again in a moment', {
      error: translate('route leg too long'),
    }),
  ],
  [
    { status: 429, refusal: null },
    'Routing is rate limited — try again in a moment',
    translate('Routing is rate limited — try again in a moment'),
  ],
  [
    { status: 503 },
    'Routing unavailable (HTTP 503)',
    translate('Routing unavailable (HTTP {status})', { status: 503 }),
  ],
  [
    { status: 0, message: '' },
    'Routing unavailable',
    translate('Routing unavailable'),
  ],
];

for (const locale of ['es', 'ru']) {
  test(`${locale}: Directions errors stay English in stats and read translated in the row`, (t) => {
    t.after(() => setLocale('en'));
    setLocale(locale);
    for (const [state, english] of cases) {
      const stats = directionsStats(state);
      assert.equal(stats.error, english);
      const row = rowFor(stats);
      assert.ok(row.includes(translate(english)), `${locale}: ${row}`);
      assert.ok(!row.includes(english), `${locale}: ${row}`);
    }
  });
}

for (const locale of ['es', 'ru']) {
  test(`${locale}: route request failures stay English in stats and read translated in the row`, (t) => {
    t.after(() => setLocale('en'));
    setLocale(locale);
    for (const [failure, english, shown] of failures()) {
      const error = presentRoutingFailure(failure);
      assert.equal(error, english);
      const stats = directionsStats({ ...idle, status: 'error', error });
      assert.equal(stats.error, english);
      assert.ok(rowFor(stats).includes(shown), `${locale}: ${rowFor(stats)}`);
      assert.notEqual(shown, english);
    }
    // The proxy's refusal after "Routing failed:", and a text it never sends.
    for (const [refusal, shownRefusal] of [
      ['route too long', translate('route too long')],
      ['something else', 'something else'],
    ]) {
      const row = rowFor(
        directionsStats({
          ...idle,
          status: 'error',
          error: `Routing failed: ${refusal}`,
        }),
      );
      assert.ok(
        row.includes(
          translate('Routing failed: {error}', { error: shownRefusal }),
        ),
        `${locale}: ${row}`,
      );
    }
  });
}

test('en: the Directions row shows the English error', () => {
  setLocale('en');
  const row = rowFor(directionsStats({ ...idle, status: 'error' }));
  assert.match(row, /No route found/);
});
