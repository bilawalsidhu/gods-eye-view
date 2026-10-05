import { _initGlobalContextPanel } from './contextBindings.js';
import { _syncContextModeButtons } from './contextPresentation.js';
import {
  _trackContextLayerReaction,
  _waitForContextLayerSettlement,
  _captureContextSessionSnapshot,
  _restoreContextSession,
  _restoreContextSessionAfterLayerSettles,
} from './contextSession.js';
import {
  _selectContextMode,
  _deactivateContextForLayerChange,
  _clearLayersOutsideContextMode,
} from './contextTransactions.js';
import { _handleContextLayerChange } from './contextLayerChanges.js';
import {
  _runUserFacingContextAction,
  _claimContextVisualAuthority,
  getContextModeState,
  setContextMode,
  clearSelectedLayers,
} from './contextActions.js';
import { connectContextManager } from './contextSubscriptions.js';

/** Own Context transactions and controls through explicit layer and presentation ports. */
export class ContextControls {
  constructor({ elements, installations, actions }) {
    Object.assign(this, elements);
    this.installations = installations;
    this.actions = actions;
    this.listeners = new AbortController();
    this.destroyed = false;
    this._dataManager = null;
    this._contextMode = null;
    this._contextModeChanging = false;
    this._contextModeGeneration = 0;
    this._contextModeEntering = null;
    this._contextModeEntryIntent = null;
    this._contextModeReplacementIntent = null;
    this._contextModeDeferredEntryIntent = null;
    this._contextSessionSnapshot = null;
    this._contextRestoreState = null;
    this._contextLayerReactionPromises = new Set();
    this._preservePanelStateDuringLayerClear = false;
    this._userFacingContextNotificationTokens = new Set();
    this._clearSelectedLayersPromise = null;
    this._clearSelectedLayersManagerPromise = null;
    this._initGlobalContextPanel();
  }
  showToast(...args) {
    if (!this.destroyed) this.actions.showToast(...args);
  }
  setClearBusy(...args) {
    if (!this.destroyed) this.actions.setClearBusy(...args);
  }
  get cockpitView() {
    return this.actions.getCockpit();
  }
  listen(target, type, callback, options = {}) {
    target?.addEventListener(type, callback, {
      ...options,
      signal: this.listeners.signal,
    });
  }
  connect(manager) {
    return connectContextManager.call(this, manager);
  }
  disconnect() {
    for (const field of [
      '_contextManagerUnsubscribe',
      '_dataManagerBeforeDestroyUnsubscribe',
      '_dataManagerVisibilityGuardUnsubscribe',
      '_dataManagerVisibilityRequestUnsubscribe',
    ]) {
      this[field]?.();
      this[field] = null;
    }
  }
  stop() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._contextModeGeneration++;
    this.listeners.abort();
  }
  async restoreForDisposal() {
    this._contextModeChanging = true;
    this._contextMode = null;
    await this._restoreContextSession();
  }
  _initGlobalContextPanel(...args) {
    return _initGlobalContextPanel.call(this, ...args);
  }
  _syncContextModeButtons(...args) {
    return _syncContextModeButtons.call(this, ...args);
  }
  _trackContextLayerReaction(...args) {
    return _trackContextLayerReaction.call(this, ...args);
  }
  _waitForContextLayerSettlement(...args) {
    return _waitForContextLayerSettlement.call(this, ...args);
  }
  _captureContextSessionSnapshot(...args) {
    return _captureContextSessionSnapshot.call(this, ...args);
  }
  _restoreContextSession(...args) {
    return _restoreContextSession.call(this, ...args);
  }
  _restoreContextSessionAfterLayerSettles(...args) {
    return _restoreContextSessionAfterLayerSettles.call(this, ...args);
  }
  _selectContextMode(...args) {
    return _selectContextMode.call(this, ...args);
  }
  _deactivateContextForLayerChange(...args) {
    return _deactivateContextForLayerChange.call(this, ...args);
  }
  _clearLayersOutsideContextMode(...args) {
    return _clearLayersOutsideContextMode.call(this, ...args);
  }
  _handleContextLayerChange(...args) {
    return _handleContextLayerChange.call(this, ...args);
  }
  _runUserFacingContextAction(...args) {
    return _runUserFacingContextAction.call(this, ...args);
  }
  _claimContextVisualAuthority(...args) {
    return _claimContextVisualAuthority.call(this, ...args);
  }
  getContextModeState(...args) {
    return getContextModeState.call(this, ...args);
  }
  setContextMode(...args) {
    return setContextMode.call(this, ...args);
  }
  clearSelectedLayers(...args) {
    return clearSelectedLayers.call(this, ...args);
  }
}
