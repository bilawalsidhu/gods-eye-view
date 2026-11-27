import { _initGlobalContextPanel } from './contextBindings.js';
import {
  _syncContextModeButtons,
  _presentContext,
} from './contextPresentation.js';
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

/**
 * Own Context transactions and controls through explicit layer and
 * presentation ports. The mode switch is presented through `publish`
 * (the app hands it the `gev-context` store) and rendered by the view.
 */
export class ContextControls {
  constructor({ elements, installations, actions, publish = () => {} }) {
    Object.assign(this, elements);
    this.installations = installations;
    this.actions = actions;
    this.publish = publish;
    this._installationsSearchBusy = false;
    this.listeners = new AbortController();
    this.destroyed = false;
    this._dataManager = null;
    this._contextMode = null;
    this._contextModeChanging = false;
    this._contextModeGeneration = 0;
    this._contextModeEntering = null;
    this._contextSessionSnapshot = null;
    this._contextRestoreState = null;
    this._contextLayerReactionPromises = new Set();
    this._preservePanelStateDuringLayerClear = false;
    /** Layers Context isolation is switching off right now. */
    this._isolatingLayerIds = new Set();
    this._userFacingContextNotificationTokens = new Set();
    this._clearSelectedLayersPromise = null;
    this._clearSelectedLayersManagerPromise = null;
    this._initGlobalContextPanel();
  }
  showToast(...args) {
    if (!this.destroyed) this.actions.showToast(...args);
  }
  /**
   * Whether Context isolation is switching this layer off right now: it is
   * suspended, and leaving the mode restores it. A switch-off by the user,
   * inside the mode or out of it, is not.
   * @param {string} layerId Layer id.
   * @returns {boolean}
   */
  suspendsLayer(layerId) {
    return this._isolatingLayerIds.has(layerId);
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
}

Object.assign(ContextControls.prototype, {
  _initGlobalContextPanel,
  _syncContextModeButtons,
  _presentContext,
  _trackContextLayerReaction,
  _waitForContextLayerSettlement,
  _captureContextSessionSnapshot,
  _restoreContextSession,
  _restoreContextSessionAfterLayerSettles,
  _selectContextMode,
  _deactivateContextForLayerChange,
  _clearLayersOutsideContextMode,
  _handleContextLayerChange,
  _runUserFacingContextAction,
  _claimContextVisualAuthority,
  getContextModeState,
  setContextMode,
  clearSelectedLayers,
});
