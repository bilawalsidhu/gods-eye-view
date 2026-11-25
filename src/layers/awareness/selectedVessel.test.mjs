// src/layers/awareness/selectedVessel.test.mjs — Contacts turned on while an
// AIS vessel is selected takes that vessel as its subject.
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeAwarenessCohort } from '../../data/militaryAwarenessEngine.js';
import { createState } from './state.js';
import { createModel } from './model.js';
import { createQueries } from './queries.js';
import { createSubject } from './subject.js';
import { createHistory } from './history.js';
import { createDependencies } from './dependencies.js';

const VESSEL_ID = '367000001';

/** Contacts parts over fake sources; focus records each nearest-flight pick. */
function contacts(selection) {
  globalThis.document ??= { body: null };
  const noAircraft = {
    getAllPositions: () => [],
    getNearby: () => [],
    getTrackedSubject: () => null,
  };
  const services = {
    flights: noAircraft,
    military: noAircraft,
    vessels: {
      getNearby: () => [],
      getAllPositions: () => [],
      getSelectedInfo: () => selection.vessel,
    },
    installations: {
      getNearby: () => [],
      getStats: () => ({}),
      setContextAnchor() {},
    },
  };
  const state = createState({ services });
  state.enabled = true;
  state.passive = false;
  state.dataManager = {
    isEnabled: () => true,
    isEffectivelyEnabled: () => true,
    setEnabled: async () => true,
    getLayerLifecycleState: () => ({
      enabled: true,
      lifecycleState: 'enabled',
    }),
    layers: new Map(),
  };
  const focused = [];
  const parts = {
    navigation: {
      summarizeAwarenessCohortForNavigation: (items, source) =>
        summarizeAwarenessCohort(items, source),
      isFlightLayer: (id) => id === 'flights' || id === 'military',
    },
    rendering: { renderVisual() {}, scheduleDirectionOverlayUpdate() {} },
    panel: { renderResults() {}, startAwarenessPageRotation() {} },
    focus: {
      focusAttentionTarget() {
        focused.push('nearest');
        return true;
      },
    },
  };
  const context = { state, services, parts };
  parts.model = createModel(context);
  parts.queries = createQueries(context);
  parts.subject = createSubject(context);
  parts.history = createHistory(context);
  parts.dependencies = createDependencies(context);
  return { state, parts, focused };
}

/** The vessel layer's answer for a selected Royal Prince. */
const ROYAL_PRINCE = Object.freeze({
  id: VESSEL_ID,
  mmsi: VESSEL_ID,
  name: 'ROYAL PRINCE',
  latitude: 37.8,
  longitude: -122.4,
});

test('Contacts turned on with a vessel selected takes it as the subject', async () => {
  const { state, parts, focused } = contacts({ vessel: ROYAL_PRINCE });
  await parts.dependencies.activateOperationalContext();
  assert.deepEqual(focused, [], 'no nearest flight is picked or followed');
  assert.equal(state.subject?.layerId, 'ais-live-vessels');
  assert.equal(state.subject?.id, VESSEL_ID);
  assert.match(state.subject.label, /ROYAL PRINCE/);
});

test('a late source settling keeps the selected vessel, not a nearest flight', () => {
  const selection = { vessel: null };
  const { state, parts, focused } = contacts(selection);
  state.autoFocusRetryPending = true;
  selection.vessel = ROYAL_PRINCE;
  parts.dependencies.refreshAfterDeferredDependency(state.activationId);
  assert.deepEqual(focused, []);
  assert.equal(state.subject?.id, VESSEL_ID);
});

test('with no vessel selected, Contacts still picks the nearest flight', async () => {
  const { state, parts, focused } = contacts({ vessel: null });
  await parts.dependencies.activateOperationalContext();
  assert.deepEqual(focused, ['nearest']);
  assert.equal(state.subject, null);
});
