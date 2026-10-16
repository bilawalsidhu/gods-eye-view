// The AIS degradation chip and the traffic "SIMULATED — <reason>" text read in
// the UI language; English keeps its wording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLocale, translateKnown } from '../i18n/index.js';
import { deriveAisFeedError } from '../data/aisLiveVessels.js';
import { createModel } from './traffic/model.js';

test('AIS degraded-feed reasons are localized in es', () => {
  setLocale('es');
  try {
    const cases = [
      [
        { status: 'down', reconnectAttempt: 3 },
        'feed down — retrying slowly (attempt 3)',
      ],
      [{ status: 'missing-key' }, 'AISSTREAM_API_KEY not set'],
      [
        { status: 'stale', silentForMs: 90000 },
        'feed silent 90s — no AIS data',
      ],
      [{ status: 'auth-failed' }, 'API key rejected — check AISSTREAM_API_KEY'],
      [{ status: 'connecting' }, 'connecting to feed…'],
      [{ status: 'closed' }, 'feed disconnected'],
    ];
    for (const [payload, english] of cases) {
      // The layer panel runs stats.error through translateKnown(); emulate it.
      const shown = translateKnown(deriveAisFeedError(payload, 0));
      assert.notEqual(shown, english, `status ${payload.status} still English`);
    }
  } finally {
    setLocale('en');
  }
});

test('traffic "SIMULATED — <reason>" is localized in es', () => {
  setLocale('es');
  try {
    const { trafficFeedPresentation } = createModel({
      state: {},
      services: {},
      parts: {},
      source: {},
    });
    const degraded = trafficFeedPresentation({
      liveMode: true,
      flowError: 'TomTom daily budget reached',
    });
    const shown = translateKnown(degraded.error);
    assert.notEqual(shown, 'SIMULATED — TomTom daily budget reached');
    assert.ok(!shown.startsWith('SIMULATED'), `still English: ${shown}`);
  } finally {
    setLocale('en');
  }
});

test('English degraded-feed wording is unchanged', () => {
  setLocale('en');
  assert.equal(
    deriveAisFeedError({ status: 'down', reconnectAttempt: 3 }, 0),
    'feed down — retrying slowly (attempt 3)',
  );
  assert.equal(
    deriveAisFeedError({ status: 'reconnecting' }, 0),
    'reconnecting to feed…',
  );
  assert.equal(
    deriveAisFeedError({ status: 'missing-key' }, 0),
    'AISSTREAM_API_KEY not set',
  );
  const { trafficFeedPresentation } = createModel({
    state: {},
    services: {},
    parts: {},
    source: {},
  });
  assert.equal(
    trafficFeedPresentation({
      liveMode: true,
      flowError: 'TomTom daily budget reached',
    }).error,
    'SIMULATED — TomTom daily budget reached',
  );
});
