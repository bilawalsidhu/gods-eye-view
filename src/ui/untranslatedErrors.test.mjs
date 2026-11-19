// Refusals and failures that source modules produce in English reach
// the page translated — through a placeholder at the point of display, or
// through a catalog entry when the text is stored as data.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale, t, translateKnown } from '../i18n/index.js';
import { presentStreetLevelPanel } from './streetLevelPresentation.js';
import { providerSnapshot } from '../testSupport/streetLevelFakes.mjs';
import { createWeatherSource } from '../layers/weather/source.js';
import { presentRoutingFailure } from '../layers/directions/index.js';
import { translateFeedError } from './statusText.js';
import { AIM_AT_GROUND_MESSAGE } from '../layers/streetLevel/policy.js';

const NO_IMAGERY = 'No street-level imagery within 50 m of that point';

function snapshot(error) {
  return {
    enabled: true,
    keyRequired: false,
    filter: { pano: 'all', sinceDays: 0 },
    providers: [providerSnapshot()],
    coverage: { loading: false, count: 0, hint: '', error: null },
    legend: [],
    sequence: { providerId: null, selectedId: null, images: 0, loading: false },
    street: { open: false, loading: false, error, providerId: null },
    groundClickReady: true,
  };
}

for (const locale of ['es', 'ru']) {
  test(`${locale}: the nearest-image refusal is built in the language and kept by the panel`, () => {
    setLocale(locale);
    try {
      // What streetLevel/index.js openNearest writes into street.error.
      const refusal = t(
        'No street-level imagery within {radius} m of that point',
        { radius: 50 },
      );
      assert.notEqual(refusal, NO_IMAGERY, 'should be translated');
      assert.match(refusal, /50/, 'keeps the radius');
      assert.equal(presentStreetLevelPanel(snapshot(refusal)).error, refusal);
      // The screen-centre refusal is stored as English data and translated
      // by the panel.
      const aim = presentStreetLevelPanel(snapshot(AIM_AT_GROUND_MESSAGE));
      assert.notEqual(aim.error, AIM_AT_GROUND_MESSAGE, 'should be translated');
    } finally {
      setLocale('en');
    }
  });

  test(`${locale}: the route proxy's refusals are shown translated`, () => {
    setLocale(locale);
    try {
      // Directions stores these in English; the Layers panel shows them
      // through translateFeedError.
      const shown = translateFeedError('Routing failed: route leg too long');
      assert.equal(
        shown,
        t('Routing failed: {error}', { error: t('route leg too long') }),
      );
      assert.doesNotMatch(shown, /route leg too long/);
      const limited = presentRoutingFailure(
        Object.assign(new Error('rate limited — try again in a moment'), {
          status: 429,
          refusal: 'rate limited',
        }),
      );
      assert.equal(limited, 'rate limited — try again in a moment');
      assert.doesNotMatch(
        translateFeedError(limited),
        /rate limited|try again in a moment/,
      );
      const http = presentRoutingFailure(
        Object.assign(new Error('Routing unavailable (HTTP 503)'), {
          status: 503,
        }),
      );
      assert.equal(http, 'Routing unavailable (HTTP 503)');
      assert.notEqual(translateFeedError(http), http);
      assert.match(translateFeedError(http), /503/);
      // A text the proxy never sends is shown as given.
      assert.equal(
        translateFeedError('Routing failed: something else'),
        t('Routing failed: {error}', { error: 'something else' }),
      );
      // Every refusal the proxy sends (server/providers/places/routes.js),
      // and "rate limited" after "Routing failed:", which the feed pattern
      // "<source> rate limited" would otherwise take.
      for (const [english, shown] of [
        [
          'routing busy — too many routes at once — try again in a moment',
          t('{error} — try again in a moment', {
            error: t('routing busy — too many routes at once'),
          }),
        ],
        [
          'Routing failed: route proxy error',
          t('Routing failed: {error}', { error: t('route proxy error') }),
        ],
        [
          'Routing failed: rate limited',
          t('Routing failed: {error}', { error: t('rate limited') }),
        ],
      ]) {
        assert.equal(translateFeedError(english), shown);
        assert.doesNotMatch(shown, /routing busy|route proxy|rate limited/);
      }
    } finally {
      setLocale('en');
    }
  });

  test(`${locale}: a weather manifest timeout is shown translated`, async () => {
    const source = createWeatherSource({
      fetchImpl: (_url, { signal }) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason)),
        ),
      timeoutMs: 10,
    });
    let message = null;
    try {
      await source.getSnapshot({ product: 'radar' });
    } catch (error) {
      message = error.message;
    }
    assert.equal(message, 'Weather request timed out', 'stored in English');
    setLocale(locale);
    try {
      // The layer shows `t(problem)` (weather/index.js presentWeatherProblem).
      assert.notEqual(t(message), message, 'should be translated');
      assert.notEqual(translateKnown(message), message);
    } finally {
      setLocale('en');
    }
  });
}
