import { _handleContextLayerChange } from './ui/contextLayerChanges.js';
import { connectContextManager } from './ui/contextSubscriptions.js';
import { _restoreContextSession, _restoreContextSessionAfterLayerSettles } from './ui/contextSession.js';
import { _selectContextMode, _clearLayersOutsideContextMode } from './ui/contextTransactions.js';
import { _initGlobalContextPanel } from './ui/contextBindings.js';
import { setContextMode as contextModeAction } from './ui/contextActions.js';
import { ContextControls } from './ui/contextControls.js';
import { readFileSync as readRadioSource } from 'node:fs';
const radioBindings = readRadioSource(new URL('./ui/radioBindings.js', import.meta.url), 'utf8');
const radioPresentation = readRadioSource(new URL('./ui/radioPresentation.js', import.meta.url), 'utf8');
const radioControlsSource = readRadioSource(new URL('./ui/radioControls.js', import.meta.url), 'utf8');
// Source-contract pins read the actual Context owners and root disposal wiring. Each pin guards a bug that shipped or nearly shipped:
//  - session bookkeeping ran AFTER the exit early-return, so the compensating
//    userAdded.delete never ran on the left-panel chip exit and restoration
//    resurrected the mission layer the user just disabled;
//  - the effective mode was read AFTER the entering flag was cleared, so the
//    entry layer's own enable event was judged against a null mode;
//  - a failed Space Missions START from the chip route cleared siblings with
//    no rollback;
//  - the right-rail entry ignored the activation result entirely.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('./ui.js', import.meta.url)), 'utf8');

const handler = _handleContextLayerChange.toString();

test('context handler: session bookkeeping runs before the exit early-return', () => {
  const record = handler.indexOf('recordContextSessionUserChange(');
  const exit = handler.indexOf('shouldExitContextForLayerChange(');
  assert.ok(record > 0, 'bookkeeping call present');
  assert.ok(exit > 0, 'exit predicate present');
  assert.ok(record < exit, 'bookkeeping must precede the exit check');
});

test('context handler: effective mode is read before the entering flag is cleared', () => {
  const effective = handler.indexOf('this._contextModeEntering || this._contextMode');
  const clear = handler.indexOf('this._contextModeEntering = null');
  assert.ok(effective > 0, 'effective-mode read present');
  assert.ok(clear > 0, 'entering-flag clear present');
  assert.ok(effective < clear, 'effective mode must be captured first');
});

test('cancelled Space Missions entry resolves ownership before settled bookkeeping', () => {
  const cancelled = handler.indexOf("change?.type === 'visibility-cancelled'");
  const bookkeeping = handler.indexOf('recordContextSessionUserChange(');
  assert.ok(cancelled > 0, 'cancellation branch present');
  assert.ok(cancelled < bookkeeping, 'cancellation returns before settled session bookkeeping');
  const branch = handler.slice(cancelled, handler.indexOf("change?.type === 'visibility-blocked'"));
  assert.match(branch, /spaceMissionEntryCancellationDisposition\(\{/);
  assert.match(branch, /cancellationDisposition === 'replacement'[\s\S]*?_contextModeEntering = 'space-missions'[\s\S]*?entryIntent\.intentEpoch === change\.intentEpoch[\s\S]*?_contextModeReplacementIntent = \{[\s\S]*?intentEpoch: change\.successorIntentEpoch/);
  assert.match(branch, /cancellationDisposition === 'restore'[\s\S]*?_contextModeEntering = null/);
  assert.match(branch, /_restoreContextSessionAfterLayerSettles\(/);
  assert.match(branch, /return;/);
});

test('direct Context entry captures on the synchronous request boundary', () => {
  const attach = connectContextManager.toString();
  assert.match(
    attach,
    /subscribeVisibilityRequests\(\(change\) => \{[\s\S]*?shouldCaptureContextSession\(change\)/,
  );
  assert.match(
    attach,
    /_captureContextSessionSnapshot\(\{\s*excludeLayerIds:\s*\[change\.layerId\],?\s*\}\)/,
  );
});

test('Clear All defers a newer explicit mission guard until its batch settles', () => {
  const attach = connectContextManager.toString();
  assert.match(attach, /shouldDeferContextEntryDuringClear\(\{/);
  assert.match(attach, /_contextModeDeferredEntryIntent = \{/);
  assert.match(attach, /await this\._clearSelectedLayersManagerPromise/);
  assert.match(attach, /await this\._clearLayersOutsideContextMode\(entryMode/);
});

test('context restore replays explicit companion intent after the stale restore queue drains', () => {
  const restore = _restoreContextSession.toString();
  const restoreAwait = restore.indexOf('await this._dataManager.restoreEnabledLayerIds(');
  const replay = restore.indexOf('await settleContextIntentReplay(');
  assert.ok(restoreAwait > 0, 'restore queue is awaited');
  assert.ok(replay > restoreAwait, 'newer explicit intent is replayed after the stale restore');
  assert.match(handler, /recordContextRestoreExplicitChange\(\{/);
});

test('context restore settles the Contacts coordinator before dependency fanout', () => {
  const restore = _restoreContextSession.toString();
  const settle = restore.indexOf("const contactsCoordinatorId = 'military-awareness'");
  const coordinatorOff = restore.indexOf('const coordinatorSettled = await this._dataManager.setEnabled(', settle);
  const fanout = restore.indexOf('await this._dataManager.restoreEnabledLayerIds(', settle);
  assert.ok(settle > 0, 'Contacts coordinator settlement is present');
  assert.ok(coordinatorOff > settle, 'Contacts OFF is awaited');
  assert.ok(fanout > coordinatorOff, 'snapshot fanout starts after Contacts settles');
  assert.match(restore, /excludeLayerIds: settleContactsCoordinator[\s\S]*?contactsCoordinatorId/);
});

test('context restore preserves its exact pending target after a failed transition', () => {
  const restore = _restoreContextSession.toString();
  assert.match(restore, /const replayError = await settleContextIntentReplay\(\{/);
  assert.match(restore, /if \(restoreError && !this\._contextSessionSnapshot\)/);
  assert.match(restore, /enabledLayerIds: new Set\(restoreState\.enabledLayerIds\)/);
  assert.match(restore, /this\._contextSessionSnapshot = \{/);
});

test('context handler: either failed direct Context-shell start rolls the session back', () => {
  const failedBranch = handler.slice(
    handler.indexOf("change?.type === 'visibility-failed'"),
    handler.indexOf("change?.type === 'visibility-will-change'"),
  );
  assert.match(failedBranch, /\['military-awareness', 'rocket-launches'\]\.includes\(change\.layerId\)/);
  assert.match(
    failedBranch,
    /_restoreContextSessionAfterLayerSettles\(\s*change\.layerId,\s*\{\s*notificationToken,?\s*\},?\s*\)/,
  );
  assert.match(failedBranch, /_runUserFacingContextAction/);
  assert.match(failedBranch, /const failureMessage =/);
  assert.match(
    failedBranch,
    /await this\._restoreContextSessionAfterLayerSettles\([\s\S]*?this\.showToast\(failureMessage\);\s*return true;/,
  );
  assert.match(failedBranch, /\},\s*failureMessage,?\s*\),?\s*\);/);
  assert.match(failedBranch, /_trackContextLayerReaction\(/);
  assert.match(
    failedBranch,
    /else if \(\s*!this\._userFacingContextNotificationTokens\.has\(change\.notificationToken\)\s*\)/,
  );

  const deferredRestore = _restoreContextSessionAfterLayerSettles.toString();
  assert.match(deferredRestore, /await this\._dataManager\?\.waitForLayerSettled\?\.\(layerId\)/);
  assert.match(deferredRestore, /return this\._restoreContextSession\(\{ notificationToken \}\)/);
  assert.doesNotMatch(failedBranch, /excludeLayerIds/);
});

test('wrapped visibility blocks leave the accessible toast to the wrapper token owner', () => {
  const blockedBranch = handler.slice(
    handler.indexOf("change?.type === 'visibility-blocked'"),
    handler.indexOf("change?.type === 'visibility-failed'"),
  );
  assert.match(
    blockedBranch,
    /!this\._userFacingContextNotificationTokens\.has\(change\.notificationToken\)/,
  );
  assert.match(blockedBranch, /this\.showToast\(/);
});

test('every user-facing Context exit route settles through the failure surface', () => {
  const initPanel = _initGlobalContextPanel.toString();
  assert.equal((initPanel.match(/void this\._runUserFacingContextAction/g) || []).length, 3);
  assert.doesNotMatch(initPanel, /falseIsFailure:\s*false/);
  assert.doesNotMatch(initPanel, /void this\._selectContextMode/);

  const deactivationCalls = [...handler.matchAll(
    /void this\._trackContextLayerReaction\(\s*this\._runUserFacingContextAction\(\(notificationToken\) =>\s*this\._deactivateContextForLayerChange\(\{ notificationToken \}\),?\s*\),?\s*\)/g,
  )];
  assert.equal(deactivationCalls.length, 4, 'dependency and primary layer exits share the caught restore path');
  assert.doesNotMatch(handler, /void this\._deactivateContextForLayerChange\(\)/);
});

test('the Radio chip catches lifecycle rejection and semantic false through the toast wrapper', () => {
  const radioControls = radioBindings.slice(
    radioBindings.indexOf('const toggleRadio = async (trigger) => {'),
    radioBindings.indexOf("this.listen(this._radioFilter, 'change'"),
  );
  assert.match(radioControls, /await this\.actions\.runUserAction\(/);
  assert.match(radioControls, /Radio could not \$\{enabling \? 'start' : 'stop'\} cleanly/);
  assert.match(radioControls, /if \(this\.destroyed \|\| toggled === false\) return/);
});

test('only the expanded Radio Enable gesture requests the contained post-enable reveal', () => {
  const radioControls = radioBindings.slice(
    radioBindings.indexOf('const toggleRadio = async (trigger) => {'),
    radioBindings.indexOf("this.listen(this._radioFilter, 'change'"),
  );
  assert.match(radioControls, /revealAfterEnable = enabling && trigger === this\._radioEnableBtn/);
  assert.match(radioControls, /if \(revealAfterEnable\)\s*await this\._revealRadioControlsAfterExplicitEnable\(trigger\)/);
  assert.equal((radioBindings.match(/_revealRadioControlsAfterExplicitEnable\(trigger\)/g) || []).length, 1);
  assert.match(radioControlsSource, /async _revealRadioControlsAfterExplicitEnable\(trigger\)/);
});

test('right-rail context entry is transactional: activation result gates the mode', () => {
  const select = _selectContextMode.toString();
  const activation = select.indexOf('activationIntent = this._dataManager._setEnabledWithIntent(');
  assert.ok(activation > 0, 'activation result captured');
  const failureBlock = select.slice(activation);
  assert.match(failureBlock, /activated = await activationIntent\.promise/);
  assert.match(failureBlock, /catch \(error\) \{\s*activationError = error;/);
  assert.match(failureBlock, /_contextModeReplacementIntent\?\.generation === generation/);
  assert.match(failureBlock, /await this\._dataManager\._waitForVisibilityIntent\?\.\(/);
  assert.match(failureBlock, /outcome\?\.intentEpoch === replacementIntent\.intentEpoch[\s\S]*?outcome\.succeeded === true/);
  assert.match(failureBlock, /outcome\?\.cancellationReason === 'superseded'[\s\S]*?outcome\.successorEnabled === true[\s\S]*?outcome\.successorIntentEpoch > replacementIntent\.intentEpoch/);
  assert.match(failureBlock, /activationError\s*\|\|\s*activated === false\s*\|\|\s*!this\._dataManager\.isEnabled\(entryLayerId\)/);
  assert.match(failureBlock, /cancelledAndSettled\s*=\s*terminalIntentOutcome\?\.succeeded === false/);
  assert.match(failureBlock, /\['caller-abort', 'resource-abort', 'superseded'\]/);
  assert.match(failureBlock, /this\._contextMode = null/);
  assert.match(failureBlock, /await this\._restoreContextSession\(\{[\s\S]*?excludeLayerIds: \[entryLayerId\],[\s\S]*?notificationToken/);
  assert.match(failureBlock, /return cancelledAndSettled \? null : false/);
});

test('Context entry awaits isolation and direct shell routes isolate in the visibility guard', () => {
  const select = _selectContextMode.toString();
  assert.match(select, /await this\._clearLayersOutsideContextMode\(mode,\s*\{\s*notificationToken,\s*signal,?\s*\}\)/);
  assert.match(select, /await this\._restoreContextSession\(\{ notificationToken, signal \}\)/);
  assert.doesNotMatch(select, /void this\._clearLayersOutsideContextMode\(mode\)/);

  // The cross-mode teardown restores UNCONDITIONALLY — an aborted caller must
  // never skip it — and then stops. A cancelled or failed cross-mode switch
  // rests on Context OFF; the honesty lives in the REPORT, not in a racy
  // attempt to put the prior mode back (see the note above
  // _restoreContextSessionAfterLayerSettles).
  const crossMode = select.slice(
    select.indexOf('const crossModeSwitch = Boolean('),
    select.indexOf('this._captureContextSessionSnapshot();'),
  );
  assert.ok(crossMode, 'cross-mode teardown block is missing');
  assert.doesNotMatch(crossMode, /if \(signal\?\.aborted\)[\s\S]*?await this\._restoreContextSession/);
  assert.match(
    crossMode,
    /await this\._restoreContextSession\(\{ notificationToken, signal \}\);\s*if \(!isCurrent\(\)\) return false;\s*if \(signal\?\.aborted\) return false;/,
    'an aborted cross-mode switch restores the baseline, then stops',
  );

  // No reinstatement anywhere: the transaction was removed deliberately, and a
  // reintroduction has to come with its own interleaving story rather than
  // reappearing quietly.
  assert.doesNotMatch(src, /_reinstatePriorContextMode/);
  assert.doesNotMatch(src, /reinstateContextMode/);

  // The generation discipline that outlived the reinstatement: dispose still
  // invalidates in-flight Context transactions so teardown cannot be raced into
  // publishing a mode.
  const dispose = src.slice(src.indexOf('  async dispose() {'), src.indexOf('this._stampNavigation();', src.indexOf('  async dispose() {')));
  assert.match(dispose, /this\._contextControls\.stop\(\)/);
  assert.match(ContextControls.prototype.stop.toString(), /this\._contextModeGeneration\+\+/);

  const guard = connectContextManager.toString();
  assert.match(guard, /\['military-awareness', 'rocket-launches'\]\.includes\(change\.layerId\)/);
  assert.match(guard, /const notificationToken\s*=\s*change\.notificationToken\s*\|\|\s*Symbol\('direct-context-shell-entry'\)/);
  assert.match(guard, /this\._userFacingContextNotificationTokens\.add\(notificationToken\)/);
  assert.match(guard, /await this\._clearLayersOutsideContextMode\(entryMode,\s*\{\s*notificationToken,?\s*\}\)/);
  assert.match(
    guard,
    /await this\._restoreContextSession\(\{\s*excludeLayerIds: \[change\.layerId\],\s*notificationToken,\s*\}\)/,
  );
  assert.match(guard, /this\._userFacingContextNotificationTokens\.delete\(\s*notificationToken,?\s*\)/);
});

test('a lost cross-mode switch says Context is off, and the state agrees', () => {
  // The defect this replaced was the LIE, not the OFF: the transition reported
  // a bare "did not complete" while the operator's Context was silently gone.
  // Text and state are derived from the same verdict so they cannot disagree,
  // and the failed layer ids survive (Manjunath's honesty requirement).
  const setter = contextModeAction.toString();
  assert.match(setter, /const priorMode = this\._contextMode;/, 'the report knows what was lost');
  assert.match(
    setter,
    /const crossModeSwitchLost\s*=\s*transitioned !== true\s*&&\s*Boolean\(priorMode\)\s*&&\s*priorMode !== canonical\s*&&\s*!state\.mode;/,
    'the verdict requires a real cross-mode switch that ended with no mode',
  );
  assert.match(
    setter,
    /error: crossModeSwitchLost\s*\? `Switch to \$\{contextModeWord\(canonical\)\} did not complete — Context is now off`/,
    'a lost switch is reported in plain words, in the vocabulary the reader uses',
  );
  assert.match(setter, /\{ contextOff: true, priorMode \}/, 'and machine-readably');
  assert.match(
    setter,
    /failedLayerIds: \[\.\.\.this\._contextTransitionFailedLayerIds\]/,
    'failed layer ids are still exposed',
  );
});

test('Context cancellation reaches isolation and restore lifecycle mutations', () => {
  const clear = _clearLayersOutsideContextMode.toString();
  assert.match(clear, /setEnabled\(layerId, false, \{[\s\S]*?signal/);

  const restore = _restoreContextSession.toString();
  assert.match(restore, /restoreEnabledLayerIds\([\s\S]*?signal/);
  assert.match(restore, /setEnabled: \(layerId, enabled, options = \{\}\)[\s\S]*?signal/);
  assert.match(restore, /error\.failedLayerIds = \[contactsCoordinatorId\]/);
  assert.match(restore, /const restoreSnapshot = async \(restoreSignal = null\)/);
  assert.match(restore, /signal\?\.aborted[\s\S]*?await restoreSnapshot\(null\)/);
  assert.match(restore, /const replaySignal = signal\?\.aborted \? null : signal/);
  assert.match(restore, /replaySignal \? \{ signal: replaySignal \} : \{\}/);
});

test('Context facade preserves success when cancellation arrives after commit', () => {
  const setContextMode = contextModeAction.toString();
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
  const select = _selectContextMode.toString();
  assert.equal(
    (select.match(/mergeContextTransitionErrors\(\s*transitionError,\s*restoreError,?\s*\)/g) || []).length,
    2,
  );
  assert.match(select, /transitionError\.failedLayerIds = \[\s*\.\.\.new Set\(\[/);
  assert.match(select, /this\._contextTransitionFailedLayerIds = \[\s*\.\.\.\(transitionError\.failedLayerIds \|\| \[\]\),?\s*\]/);
});

test('stale Context cancellation preserves rollback failed-layer identities', () => {
  const setContextMode = contextModeAction.toString();
  assert.match(
    setContextMode,
    /if \(!requestIsCurrent\(\)\) \{[\s\S]*?\.\.\.cancellationResult\(\),[\s\S]*?failedLayerIds: \[\.\.\.error\.failedLayerIds\]/,
  );
  assert.match(
    setContextMode,
    /const cancellationResult = \(\) => \(\{[\s\S]*?_contextTransitionFailedLayerIds\?\.length[\s\S]*?failedLayerIds: \[\.\.\.this\._contextTransitionFailedLayerIds\]/,
  );
});
