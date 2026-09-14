// panelStoragePurge.test.mjs — pins the legacy panel-storage purge (PR #190):
// only the VERSIONED panel families (panelPos / panelCollapsed /
// layoutResetNotified) are ever removed, only when their vN is superseded,
// and everything else in the bucket survives. A source anchor pins ui.js's
// call so the purge cannot silently detach from the live key templates.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { purgeStalePanelStorage, stalePanelStorageKeys } from './panelStoragePurge.js';
import { readSource } from '../testSupport/readSource.js';

const V8 = { positionVersion: 'v8', layoutVersion: 'v6' };

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    length: map.size,
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

test('stale selection: superseded generations of every panel family are stale', () => {
  assert.deepEqual(stalePanelStorageKeys([
    'godsEyeView.v5.panelPos.location-bar',        // older position
    'godsEyeView.v6.panelPos.control-panel',       // the version the toast greps
    'godsEyeView.v7.panelPos.data-panel',          // the immediately previous position
    'godsEyeView.v2.panelCollapsed.radio-panel',   // older collapse
    'godsEyeView.v7.layoutResetNotified',          // older one-shot marker
  ], V8), [
    'godsEyeView.v5.panelPos.location-bar',
    'godsEyeView.v6.panelPos.control-panel',
    'godsEyeView.v7.panelPos.data-panel',
    'godsEyeView.v2.panelCollapsed.radio-panel',
    'godsEyeView.v7.layoutResetNotified',
  ]);
});

test('stale selection: current generations and ALL other families are kept', () => {
  const kept = [
    'godsEyeView.v8.panelPos.location-bar',        // current position
    'godsEyeView.v8.layoutResetNotified',          // current marker
    'godsEyeView.v6.panelCollapsed.radio-panel',   // current collapse
    'godsEyeView.cctv.calibration.v1',             // versioned but a different family
    'godsEyeView.cctv.calibration.v2',
    'godsEyeView.sceneProject.v2',
    'godsEyeView.voiceCost.limits',
    'godsEyeView.cockpitWeatherEffects.enabled',
    'godsEyeView.v8.panelPos',                     // family root itself, no id
    'gev:detection-allocation:v1',                 // non-namespaced GEV keys
    'gev:view-state:v1',
    'gev-realtime-errors',
    'tle:ISS (ZARYA)',                             // non-GEV keys
    'theme-preference',
  ];
  assert.deepEqual(stalePanelStorageKeys(kept, V8), [], 'nothing outside superseded panel generations');
  assert.deepEqual(stalePanelStorageKeys([], V8), []);
});

test('purge removes exactly the stale keys and returns them', () => {
  const storage = memoryStorage({
    'godsEyeView.v7.panelPos.data-panel': '{"left":-192,"top":40}',
    'godsEyeView.v8.panelPos.data-panel': '{"left":30,"top":40}',
    'godsEyeView.v6.panelPos.control-panel': '{"left":10,"top":10}',
    'godsEyeView.sceneProject.v2': '{}',
  });
  const removed = purgeStalePanelStorage(storage, V8);
  assert.deepEqual(removed.sort(), [
    'godsEyeView.v6.panelPos.control-panel',
    'godsEyeView.v7.panelPos.data-panel',
  ]);
  assert.deepEqual([...storage._map.keys()], [
    'godsEyeView.v8.panelPos.data-panel',
    'godsEyeView.sceneProject.v2',
  ]);
  // Idempotent: a second pass removes nothing.
  assert.deepEqual(purgeStalePanelStorage(storage, V8), []);
});

test('a throwing storage is tolerated: purge returns empty, never throws', () => {
  assert.deepEqual(purgeStalePanelStorage({
    get length() { throw new Error('quota'); },
    key: () => null,
    removeItem: () => { throw new Error('denied'); },
  }, V8), []);
});

test('the purge stays attached to ui.js live key templates and versions', () => {
  const ui = readSource('../ui.js', import.meta.url);
  // The live key templates, verbatim from ui.js:
  assert.match(ui, /godsEyeView\.\$\{PANEL_POSITION_STORAGE_VERSION\}\.panelPos\./);
  assert.match(ui, /godsEyeView\.\$\{PANEL_POSITION_STORAGE_VERSION\}\.layoutResetNotified/);
  assert.match(ui, /godsEyeView\.\$\{PANEL_LAYOUT_STORAGE_VERSION\}\.panelCollapsed\./);
  // The purge runs during panel init with those same constants:
  assert.match(ui, /purgeStalePanelStorage\(localStorage, \{\s*positionVersion: PANEL_POSITION_STORAGE_VERSION,\s*layoutVersion: PANEL_LAYOUT_STORAGE_VERSION,\s*\}\)/);
  // The purge must run AFTER the toast check: _maybeNotifyLayoutReset greps
  // the OLD v6.panelPos generation to decide whether to tell the user their
  // layout was reset, so the purge must not delete the evidence first.
  assert.ok(
    ui.indexOf('this._purgeStalePanelStorage()') > ui.indexOf('this._maybeNotifyLayoutReset()'),
    'purge follows the layout-reset toast check',
  );
});
