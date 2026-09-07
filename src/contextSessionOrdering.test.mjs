// Source-contract pins for StyleManager's Context-session handler ordering.
// ui.js cannot be imported headlessly (it touches the DOM at module scope), so
// these read the shipped source. Each pin guards a bug that shipped or nearly shipped:
//  - session bookkeeping ran AFTER the exit early-return, so the compensating
//    userAdded.delete never ran on the left-panel chip exit and restoration
//    resurrected the mission layer the user just disabled;
//  - the effective mode was read AFTER the entering flag was cleared, so the
//    entry layer's own enable event was judged against a null mode;
//  - a failed Context start could clear siblings with no rollback;
//  - the right-rail entry ignored the activation result entirely.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('./ui.js', import.meta.url)), 'utf8');

const handlerStart = src.indexOf('_handleContextLayerChange(change) {');
assert.ok(handlerStart > 0, 'handler found');
const handlerEnd = src.indexOf('_syncContextModeButtons() {', handlerStart);
const handler = src.slice(handlerStart, handlerEnd);

test('context handler: session bookkeeping runs before the exit early-return', () => {
  const record = handler.indexOf('recordContextSessionUserChange(');
  const exit = handler.indexOf('shouldExitContextForLayerChange(');
  assert.ok(record > 0, 'bookkeeping call present');
  assert.ok(exit > 0, 'exit predicate present');
  assert.ok(record < exit, 'bookkeeping must precede the exit check');
});


test('direct Context entry captures on the synchronous request boundary', () => {
  const attachStart = src.indexOf('attachDataManager(dataManager) {');
  const attachEnd = src.indexOf('_syncContextModeButtons()', attachStart);
  const attach = src.slice(attachStart, attachEnd);
  assert.match(
    attach,
    /subscribeVisibilityRequests\(\(change\) => \{[\s\S]*?shouldCaptureContextSession\(change\)/,
  );
  assert.match(
    attach,
    /_captureContextSessionSnapshot\(\{ excludeLayerIds: \[change\.layerId\] \}\)/,
  );
});


test('context restore settles the Contacts coordinator before dependency fanout', () => {
  const restore = src.slice(
    src.indexOf('async _restoreContextSession('),
    src.indexOf('async _selectContextMode('),
  );
  const settle = restore.indexOf("const contactsCoordinatorId = 'military-awareness'");
  const coordinatorOff = restore.indexOf('const coordinatorSettled = await this._dataManager.setEnabled(', settle);
  const fanout = restore.indexOf('await this._dataManager.restoreEnabledLayerIds(', settle);
  assert.ok(settle > 0, 'Contacts coordinator settlement is present');
  assert.ok(coordinatorOff > settle, 'Contacts OFF is awaited');
  assert.ok(fanout > coordinatorOff, 'snapshot fanout starts after Contacts settles');
  assert.match(restore, /excludeLayerIds: settleContactsCoordinator[\s\S]*?contactsCoordinatorId/);
});

test('context restore preserves its exact pending target after a failed transition', () => {
  const restore = src.slice(
    src.indexOf('async _restoreContextSession('),
    src.indexOf('async _selectContextMode('),
  );
  assert.match(restore, /const replayError = await settleContextIntentReplay\(\{/);
  assert.match(restore, /if \(restoreError && !this\._contextSessionSnapshot\)/);
  assert.match(restore, /enabledLayerIds: new Set\(restoreState\.enabledLayerIds\)/);
  assert.match(restore, /this\._contextSessionSnapshot = \{/);
});



test('Context cancellation reaches isolation and restore lifecycle mutations', () => {
  const clearStart = src.indexOf('async _clearLayersOutsideContextMode(');
  const clear = src.slice(clearStart, src.indexOf('_handleContextLayerChange(', clearStart));
  assert.match(clear, /setEnabled\(layerId, false, \{[\s\S]*?signal/);

  const restore = src.slice(
    src.indexOf('async _restoreContextSession('),
    src.indexOf('async _restoreContextSessionAfterLayerSettles('),
  );
  assert.match(restore, /restoreEnabledLayerIds\([\s\S]*?signal/);
  assert.match(restore, /setEnabled: \(layerId, enabled, options = \{\}\)[\s\S]*?signal/);
  assert.match(restore, /error\.failedLayerIds = \[contactsCoordinatorId\]/);
  assert.match(restore, /const restoreSnapshot = async \(restoreSignal = null\)/);
  assert.match(restore, /signal\?\.aborted[\s\S]*?await restoreSnapshot\(null\)/);
  assert.match(restore, /const replaySignal = signal\?\.aborted \? null : signal/);
  assert.match(restore, /replaySignal \? \{ signal: replaySignal \} : \{\}/);
});

test('Context facade preserves success when cancellation arrives after commit', () => {
  const setContextMode = src.slice(
    src.indexOf('async setContextMode('),
    src.indexOf('getControlState()', src.indexOf('async setContextMode(')),
  );
  assert.match(
    setContextMode,
    /transitioned === null \|\| \(!requestIsCurrent\(\) && transitioned !== true\)/,
  );
  assert.match(
    setContextMode,
    /result === null \|\| \(!requestIsCurrent\(\) && result !== true\)/,
  );
});

test('Context production rollback paths merge primary and restore failed-layer identities', () => {
  const select = src.slice(
    src.indexOf('async _selectContextMode('),
    src.indexOf('async _deactivateContextForLayerChange('),
  );
  assert.equal(
    (select.match(/mergeContextTransitionErrors\(transitionError, restoreError\)/g) || []).length,
    1,
  );
  assert.match(select, /this\._contextTransitionFailedLayerIds = \[\.\.\.\(transitionError\.failedLayerIds \|\| \[\]\)\]/);
});

test('stale Context cancellation preserves rollback failed-layer identities', () => {
  const setContextMode = src.slice(
    src.indexOf('async setContextMode('),
    src.indexOf('getControlState()', src.indexOf('async setContextMode(')),
  );
  assert.match(
    setContextMode,
    /if \(!requestIsCurrent\(\)\) \{[\s\S]*?\.\.\.cancellationResult\(\),[\s\S]*?failedLayerIds: \[\.\.\.error\.failedLayerIds\]/,
  );
  assert.match(
    setContextMode,
    /const cancellationResult = \(\) => \(\{[\s\S]*?_contextTransitionFailedLayerIds\?\.length[\s\S]*?failedLayerIds: \[\.\.\.this\._contextTransitionFailedLayerIds\]/,
  );
});
