// The traffic "SIMULATED — <reason>" text reads in the UI language.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLocale, translateKnown } from '../../i18n/index.js';
import { createModel } from './model.js';

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
