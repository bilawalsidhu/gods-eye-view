// The Data Layers row's previous/next mission controls, and the Satellites
// restore an explicit Satellites action takes over.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createControls } from './controls.js';
import { createIngestion } from './ingestion.js';
import { createSatelliteIntents } from './satelliteIntents.js';

const roster = (...ids) => ({
  entries: ids.map((id, index) => ({ id, index, label: `Mission ${id}` })),
});

function rig({ ids = ['A', 'B', 'C'], selected = null, enabled = true } = {}) {
  const panelListeners = new Set();
  const state = {
    _enabled: enabled,
    _selectedLaunchId: selected,
    _missionRosterView: ids ? roster(...ids) : null,
  };
  const parts = {
    panel: {
      selectMissionAt(index) {
        state._selectedLaunchId = state._missionRosterView.entries[index].id;
      },
      subscribePanel(listener) {
        panelListeners.add(listener);
        return () => panelListeners.delete(listener);
      },
    },
  };
  const { methods } = createControls({ state, services: {}, parts });
  return {
    state,
    methods,
    chip: (id) => methods.getRowControls().chips.find((c) => c.id === id),
    publish: (view) => {
      for (const listener of [...panelListeners]) listener(view);
    },
    listenerCount: () => panelListeners.size,
  };
}

test('next and previous wrap around the roster', () => {
  const r = rig({ selected: 'C' });
  r.chip('next-mission').onClick();
  assert.equal(
    r.state._selectedLaunchId,
    'A',
    'next after the last is the first',
  );
  r.chip('previous-mission').onClick();
  assert.equal(
    r.state._selectedLaunchId,
    'C',
    'previous before the first is the last',
  );
  r.chip('previous-mission').onClick();
  assert.equal(r.state._selectedLaunchId, 'B');
  assert.match(r.methods.getRowControls().info, /^2 \/ 3 · Mission B$/);
});

test('with nothing selected, next picks the first mission and previous the last', () => {
  const next = rig();
  next.chip('next-mission').onClick();
  assert.equal(next.state._selectedLaunchId, 'A');
  const previous = rig();
  previous.chip('previous-mission').onClick();
  assert.equal(previous.state._selectedLaunchId, 'C');
});

test('the controls disable only when the one mission is already selected', () => {
  const only = rig({ ids: ['A'], selected: 'A' });
  assert.equal(only.chip('next-mission').disabled, true);
  assert.equal(only.chip('previous-mission').disabled, true);
  // One mission, not yet picked: the controls can still select it.
  const unpicked = rig({ ids: ['A'] });
  assert.equal(unpicked.chip('next-mission').disabled, false);
  unpicked.chip('next-mission').onClick();
  assert.equal(unpicked.state._selectedLaunchId, 'A');
  assert.equal(rig({ selected: 'B' }).chip('next-mission').disabled, false);
});

test('there are no controls while the layer is off or the roster is empty', () => {
  assert.equal(rig({ enabled: false }).methods.getRowControls(), null);
  assert.equal(rig({ ids: [] }).methods.getRowControls(), null);
  assert.equal(rig({ ids: null }).methods.getRowControls(), null);
  // A stale click after the layer stops selects nothing.
  const r = rig({ selected: 'A' });
  const next = r.chip('next-mission');
  r.state._enabled = false;
  next.onClick();
  assert.equal(r.state._selectedLaunchId, 'A');
});

test('the row listener fires only when the roster or the selection changes', () => {
  const r = rig();
  let calls = 0;
  r.methods.setRowControlsListener(() => calls++);
  const view = r.state._missionRosterView;
  r.publish({ roster: view });
  assert.equal(calls, 1, 'the first view is a change');
  r.publish({ roster: view });
  assert.equal(calls, 1, 'a replay or telemetry update is not');
  r.state._selectedLaunchId = 'B';
  r.publish({ roster: view });
  assert.equal(calls, 2, 'a new selection is');
  r.publish({ roster: roster('A', 'B') });
  assert.equal(calls, 3, 'a new roster is');

  // A new listener replaces the old one; null removes it.
  let replaced = 0;
  r.methods.setRowControlsListener(() => replaced++);
  assert.equal(r.listenerCount(), 1);
  r.methods.setRowControlsListener(null);
  assert.equal(r.listenerCount(), 0);
  r.publish({ roster: roster('C') });
  assert.equal(calls, 3);
  assert.equal(replaced, 0);
});

function satelliteRig({ enabledBefore }) {
  const calls = [];
  let satellitesOn = true;
  const manager = {
    layers: new Map([['satellites', { toggleChain: null }]]),
    waitForLayerIdle: async () => true,
    isEnabled: () => satellitesOn,
    isEffectivelyEnabled: (id) =>
      id === 'satellites' ? satellitesOn : id === 'rocket-launches',
    setLayerParams: (id, params) => calls.push(['params', id, params]),
    async setEnabled(id, enabled) {
      calls.push(['enabled', id, enabled]);
      satellitesOn = enabled;
      return true;
    },
  };
  const state = {
    _dataManager: manager,
    _satelliteStateBeforeMission: {
      enabled: enabledBefore,
      params: { mode: 'before' },
    },
    _satelliteActivationPromise: null,
  };
  const parts = {
    policyHelpers: { satelliteParamsAfterSpaceMissions: (params) => params },
  };
  const ingestion = createIngestion({ state, services: {}, parts, source: {} });
  parts.satelliteIntents = createSatelliteIntents({ state });
  const { methods } = createControls({ state, services: {}, parts });
  return { state, calls, ingestion, methods, intents: parts.satelliteIntents };
}

test('an accepted Satellites action keeps its visibility through mission exit', async () => {
  const r = satelliteRig({ enabledBefore: false });
  // The person turns Satellites on themselves while the missions are on.
  r.intents.handleVisibility({
    type: 'visibility',
    layerId: 'satellites',
    enabled: true,
    origin: 'user',
  });
  await r.ingestion.restoreSatelliteDependency();
  assert.deepEqual(
    r.calls,
    [['params', 'satellites', { mode: 'before' }]],
    'the parameters come back, the visibility is left alone',
  );
  assert.equal(r.state._satelliteStateBeforeMission, null);
});

test('without a Satellites action the exit restores the pre-mission visibility', async () => {
  const r = satelliteRig({ enabledBefore: false });
  await r.ingestion.restoreSatelliteDependency();
  assert.deepEqual(r.calls, [
    ['params', 'satellites', { mode: 'before' }],
    ['enabled', 'satellites', false],
  ]);
});

test('a Satellites layer that does not settle keeps the saved state for the next exit', async () => {
  const r = satelliteRig({ enabledBefore: false });
  let idle = false;
  r.state._dataManager.waitForLayerIdle = async () => idle;
  await assert.rejects(
    r.ingestion.restoreSatelliteDependency(),
    /did not settle/,
  );
  assert.deepEqual(r.calls, [], 'nothing changes while Satellites is busy');
  assert.deepEqual(r.state._satelliteStateBeforeMission, {
    enabled: false,
    params: { mode: 'before' },
  });

  // Turning Space Missions off again once Satellites settles finishes it.
  idle = true;
  await r.ingestion.restoreSatelliteDependency();
  assert.deepEqual(r.calls, [
    ['params', 'satellites', { mode: 'before' }],
    ['enabled', 'satellites', false],
  ]);
  assert.equal(r.state._satelliteStateBeforeMission, null);
});

test('a Satellites action the person took still gets its parameters back when Satellites is busy', async () => {
  const r = satelliteRig({ enabledBefore: false });
  r.state._dataManager.waitForLayerIdle = async () => false;
  r.state._satelliteStateBeforeMission.restoreVisibility = false;
  await r.ingestion.restoreSatelliteDependency();
  assert.deepEqual(r.calls, [['params', 'satellites', { mode: 'before' }]]);
  assert.equal(r.state._satelliteStateBeforeMission, null);
});
