import test from 'node:test';
import assert from 'node:assert/strict';
import { createPanel } from './panel.js';

test('a Contacts row names its provider as the Layers panel does, with its feed state', () => {
  const cohort = (id, source, sourceStatus) => ({
    id,
    label: id,
    source,
    sourceStatus,
    summary: { relationship: 'OBSERVED', count: 1, nearest: [], reason: 'observed' },
  });
  const state = {
    enabled: true,
    results: {
      subject: { label: 'AFR38JF' },
      cohorts: [
        cohort('flights', 'adsb.lol', 'fallback'),
        cohort('military', 'adsb.lol', null),
        cohort('ais-live-vessels', 'Datalastic', 'stale'),
      ],
    },
    cohortPages: new Map(),
    panelListeners: new Set(),
    panelSignature: '',
    navigationIndex: 0,
  };
  const parts = {
    navigation: { canNavigateNext: () => false },
    rendering: { hideDirectionOverlay() {} },
  };
  createPanel({ state, parts }).renderResults();
  assert.deepEqual(
    state.panelView.rows.map((row) => row.detail),
    ['adsb.lol · FALLBACK · observed', 'adsb.lol · observed', 'Datalastic · STALE · observed'],
  );
  state.offPanelLocale?.();
});
