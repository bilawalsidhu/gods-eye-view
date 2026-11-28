/**
 * Compatibility API for layers, scene playback and voice commands.
 * State and behavior live in the named owners; this class only delegates.
 * New logic belongs with an owner, not in this forwarding surface.
 */
export class ShellFacade {
  /** Observe camera ownership transfers through the navigation owner. */
  subscribeCameraHandoff(listener) {
    return this._navigation?.subscribeCameraHandoff(listener);
  }

  get _models3dEnabled() {
    return this._aircraftDisplay._models3dEnabled;
  }

  set _models3dEnabled(value) {
    this._aircraftDisplay._models3dEnabled = value;
  }

  get _models3dMode() {
    return this._aircraftDisplay._models3dMode;
  }

  set _models3dMode(value) {
    this._aircraftDisplay._models3dMode = value;
  }

  get _dataManager() {
    return this._layerBindings?._dataManager;
  }

  set _dataManager(value) {
    this._layerBindings._dataManager = value;
  }

  get _dataManagerUnsubscribe() {
    return this._layerBindings?._dataManagerUnsubscribe;
  }

  set _dataManagerUnsubscribe(value) {
    this._layerBindings._dataManagerUnsubscribe = value;
  }

  get _applicationShortcuts() {
    return this._displayBindings?._applicationShortcuts;
  }

  set _applicationShortcuts(value) {
    this._displayBindings._applicationShortcuts = value;
  }

  get _locationLookup() {
    return this._locationNavigation._locationLookup;
  }

  set _locationLookup(value) {
    this._locationNavigation._locationLookup = value;
  }

  get _locationControls() {
    return this._locationNavigation._locationControls;
  }

  set _locationControls(value) {
    this._locationNavigation._locationControls = value;
  }

  get orbitController() {
    return this._locationNavigation.orbitController;
  }

  set orbitController(value) {
    this._locationNavigation.orbitController = value;
  }

  get cockpitView() {
    return this._cockpitCoordinator?.cockpitView;
  }

  get _cockpitDisplayPortal() {
    return this._cockpitCoordinator?._cockpitDisplayPortal;
  }

  set _cockpitDisplayPortal(value) {
    this._cockpitCoordinator._cockpitDisplayPortal = value;
  }

  get _navigationGeneration() {
    return this._navigation._navigationGeneration;
  }

  set _navigationGeneration(value) {
    this._navigation._navigationGeneration = value;
  }

  get _activeLocationSearchGeneration() {
    return this._navigation._activeLocationSearchGeneration;
  }

  set _activeLocationSearchGeneration(value) {
    this._navigation._activeLocationSearchGeneration = value;
  }

  get _initialShareState() {
    return this._shareRestoration._initialShareState;
  }

  set _initialShareState(value) {
    this._shareRestoration._initialShareState = value;
  }

  get _initialShareRestorePromise() {
    return this._shareRestoration._initialShareRestorePromise;
  }

  set _initialShareRestorePromise(value) {
    this._shareRestoration._initialShareRestorePromise = value;
  }

  get _hasShareState() {
    return this._shareRestoration._hasShareState;
  }

  set _hasShareState(value) {
    this._shareRestoration._hasShareState = value;
  }

  get _visualEffects() {
    return this._visualSettings._visualEffects;
  }

  set _visualEffects(value) {
    this._visualSettings._visualEffects = value;
  }

  get activeStyle() {
    return this._visualSettings.activeStyle;
  }

  set activeStyle(value) {
    this._visualSettings.activeStyle = value;
  }

  get _detectionUserOverridden() {
    return this._visualSettings._detectionUserOverridden;
  }

  set _detectionUserOverridden(value) {
    this._visualSettings._detectionUserOverridden = value;
  }

  get _detectionAllocationPreference() {
    return this._visualSettings._detectionAllocationPreference;
  }

  set _detectionAllocationPreference(value) {
    this._visualSettings._detectionAllocationPreference = value;
  }

  get _panelLayout() {
    return this._panelChrome._panelLayout;
  }

  set _panelLayout(value) {
    this._panelChrome._panelLayout = value;
  }

  get stages() {
    return this._visualSettings.stages;
  }

  get transitions() {
    return this._visualSettings.transitions;
  }

  get bloomEnabled() {
    return this._visualSettings.bloomEnabled;
  }

  get sharpenEnabled() {
    return this._visualSettings.sharpenEnabled;
  }

  /** Settle only the search generation that still owns the shared input UI. */
  _settleLocationSearchUi(generation, options) {
    return this._navigation._settleLocationSearchUi(...arguments);
  }

  /** Run one immediate destination through the shared ownership policy. */
  _runExplicitNavigation(noun, navigate, releaseOptions = undefined) {
    return this._navigation._runExplicitNavigation(...arguments);
  }

  /** Final authority check and release immediately before a delayed flight. */
  _reassertNavigationHandoff(generation) {
    return this._navigation._reassertNavigationHandoff(...arguments);
  }

  /**
   * Creates one CesiumJS PostProcessStage per visual style and registers
   * it with the scene. Each stage starts with intensity 0 (invisible)
   * so crossfade transitions can animate it in later.
   * @returns {void}
   */
  _initStages() {
    return this._visualSettings._initStages(...arguments);
  }

  /**
   * Entering Contacts turns detection on. Cockpit entry, exit and third-person tracking
   * are moves within the Contacts session and leave detection on.
   *
   * Called from `_syncContextModeButtons`, the single funnel every
   * `_contextMode` mutation routes through, and gated on the transaction having
   * SETTLED (`!_contextModeChanging`) so a failed activation can never strand
   * detection on.
   * @returns {void}
   */
  _syncContactsDetection() {
    return this._visualSettings._syncContactsDetection(...arguments);
  }

  /**
   * Configures Cesium's built-in bloom stage and adds a custom unsharp-mask
   * sharpen stage to the post-process pipeline. Both start disabled.
   * @returns {void}
   */
  _initBloomSharpen() {
    return this._visualSettings._initBloomSharpen(...arguments);
  }

  /**
   * Toggles bloom on/off, syncs button state, and reveals/hides the intensity slider row.
   * @param {boolean} enabled - Whether bloom should be active.
   * @returns {void}
   */
  _setBloomEnabled(enabled) {
    return this._visualSettings._setBloomEnabled(...arguments);
  }

  /**
   * Sets the sharpen amount the Display slider shows and applies it.
   * @param {number} pct - Sharpen intensity, 0 to 100.
   * @param {{syncShare?: boolean}} [options]
   * @returns {void}
   */
  _setSharpenIntensity(pct, { syncShare = true } = {}) {
    return this._visualSettings._setSharpenIntensity(...arguments);
  }

  /**
   * Toggles sharpening on/off, syncs button state, and reveals/hides the intensity slider row.
   * @param {boolean} enabled - Whether sharpening should be active.
   * @returns {void}
   */
  _setSharpenEnabled(enabled) {
    return this._visualSettings._setSharpenEnabled(...arguments);
  }

  /**
   * Sets the five-stop density control, canonicalized; the engine derives
   * Sparse/Balanced/Dense from the same stop. Without a value it reapplies
   * the current stop.
   * @param {number} [pct]
   * @returns {void}
   */
  _setDetectionDensity(pct) {
    return this._visualSettings._setDetectionDensity(...arguments);
  }

  /**
   * Sets the keyhole fade distance and outside opacity, in percent; either
   * one left out keeps its current value.
   * @param {{fadePct?: number, outsideOpacityPct?: number}} [tuning]
   * @returns {void}
   */
  _setDetectionFade(tuning) {
    return this._visualSettings._setDetectionFade(...arguments);
  }

  _syncDetectionUiFromEngine() {
    return this._visualSettings._syncDetectionUiFromEngine(...arguments);
  }

  /**
   * Activates a detection overlay mode by label (e.g. 'OFF', 'SPARSE', 'PANOPTIC').
   * @param {string} modeLabel - Detection mode label to set.
   * @returns {void}
   */
  _setDetectionMode(modeLabel) {
    return this._visualSettings._setDetectionMode(...arguments);
  }

  /**
   * Switches the HUD layout variant (e.g. 'tactical', 'minimal') and syncs
   * the layout dropdown if present.
   * @param {string} variantName - HUD variant identifier.
   * @returns {void}
   */
  _setHudVariant(variantName) {
    return this._visualSettings._setHudVariant(...arguments);
  }

  _setCyberSonarEnabled(enabled) {
    return this._visualSettings._setCyberSonarEnabled(...arguments);
  }

  _setCyberSonarSetting(name, value) {
    return this._visualSettings._setCyberSonarSetting(...arguments);
  }

  /**
   * Keeps both responsive panel lanes and Cockpit's utility strip on the same
   * measured layout commit. HUD visibility transitions can outlive the first
   * animation frame, so variant changes receive one bounded settling pass.
   * @param {{settle?: boolean}} [options] Whether to remeasure after transitions.
   * @returns {void}
   */
  _scheduleAdaptivePanelLayout(options0) {
    return this._panelLayout._scheduleAdaptivePanelLayout(options0);
  }

  /**
   * Applies the global post-processing baseline (GLOBAL_POST_DEFAULTS) at
   * startup before any share-link restore runs. Sets bloom, sharpen, HUD,
   * and detection to their factory defaults.
   * @returns {void}
   */
  _applyGlobalPostDefaults() {
    return this._visualSettings._applyGlobalPostDefaults(...arguments);
  }

  /** Current shareable visual preferences; subscriptions include an initial snapshot. */
  subscribeShareState(listener, options) {
    return this._shareState.subscribe(listener, options);
  }

  _readShareState() {
    return this._visualSettings._readShareState(...arguments);
  }

  /**
   * Updates the traffic sync status chip with loading phase label and progress.
   * Auto-hides after 1.5s when loading completes; stays visible while busy.
   * @param {boolean} [forceShow=false] - Force the chip visible regardless of busy state.
   * @returns {void}
   */
  _updateTrafficSyncChip(forceShow, now) {
    return this._feedback._updateTrafficSyncChip(forceShow, now);
  }

  /**
   * Initializes panel collapse buttons and restores persisted collapsed state.
   * @returns {void}
   */
  _initPanelChrome() {
    return this._panelChrome._initPanelChrome(...arguments);
  }

  /**
   * One-time toast when stored v6 panel positions are superseded by the v7
   * layout defaults (positions reset; collapsed states are preserved).
   * @returns {void}
   */
  _maybeNotifyLayoutReset() {
    return this._panelChrome._maybeNotifyLayoutReset(...arguments);
  }

  /**
   * Connects the layer data manager for traffic sync, CCTV state subscription,
   * and layer enable/disable operations.
   * @param {object|null} dataManager - The DataManager instance, or null to detach.
   * @returns {void}
   */
  attachDataManager(...args) {
    return this._layerBindings.attachDataManager(...args);
  }

  get _contextMode() {
    return this._contextControls?._contextMode ?? null;
  }

  get _contextModeChanging() {
    return this._contextControls?._contextModeChanging ?? false;
  }

  get _preservePanelStateDuringLayerClear() {
    return this._contextControls?._preservePanelStateDuringLayerClear ?? false;
  }

  _contextSuspendsLayer(layerId) {
    return this._contextControls?.suspendsLayer(layerId) ?? false;
  }

  _runUserFacingContextAction(...args) {
    return this._contextControls?._runUserFacingContextAction(...args);
  }

  _waitForContextLayerSettlement(...args) {
    return this._contextControls?._waitForContextLayerSettlement(...args);
  }

  _syncContextModeButtons(...args) {
    return this._contextControls?._syncContextModeButtons(...args);
  }

  _setCockpitDisclosure(...args) {
    return this._radioControls?._setCockpitDisclosure?.(...args);
  }

  _cockpitDisclosureOpen(kind) {
    return Boolean(this._radioControls?._cockpitDisclosureOpen?.(kind));
  }

  _renderRadioState(...args) {
    return this._radioControls?._renderRadioState?.(...args);
  }

  /**
   * Restores a panel's collapsed/expanded state from localStorage.
   * Falls back to the CSS class default if no saved state exists.
   * @param {string} panelId - DOM id of the panel.
   * @returns {void}
   */
  _restorePanelCollapsedState(panelId, options1) {
    return this._panelChrome._restorePanelCollapsedState(...arguments);
  }

  /**
   * Persists a panel's collapsed state ('1' or '0') to localStorage.
   * @param {string} panelId - DOM id of the panel.
   * @param {boolean} collapsed - Whether the panel is collapsed.
   * @returns {void}
   */
  _savePanelCollapsedState(panelId, collapsed) {
    return this._panelChrome._savePanelCollapsedState(...arguments);
  }

  /**
   * Builds one fixed right-side rail from Display, CCTV, its parameter
   * controls, and Global Context (which owns the nested Radio companion).
   * The rail then measures the live HUD chrome at runtime so it can stay
   * aligned and within the available vertical corridor.
   * @returns {void}
   */
  _initRightPanelAdaptiveLayout() {
    return this._panelLayout._initRightPanelAdaptiveLayout();
  }

  _scheduleRightPanelLayout(options0) {
    return this._panelChrome._scheduleRightPanelLayout(...arguments);
  }

  /**
   * Places the right rail inside the visible HUD-safe corridor. When the
   * corridor is too short, the expanded panel receives the remaining height
   * with internal scrolling. Tactical HUD hides collapsed sibling launchers
   * while a panel is expanded; other HUD layouts keep them visible.
   * @returns {void}
   */
  _syncRightPanelAdaptiveLayout() {
    return this._panelLayout._syncRightPanelAdaptiveLayout();
  }

  /**
   * Initializes the adaptive left accordion. The layout engine measures the
   * actual HUD/chrome rectangles that intersect the left lane, then decides
   * whether collapsed sibling labels can remain visible beside the expanded
   * panel. No decision is keyed to a specific panel or HUD variant.
   * @returns {void}
   */
  _initLeftPanelAdaptiveLayout() {
    return this._panelLayout._initLeftPanelAdaptiveLayout();
  }

  /**
   * Batches adaptive accordion work into one animation frame.
   * @returns {void}
   */
  _scheduleLeftPanelLayout(options0) {
    return this._panelChrome._scheduleLeftPanelLayout(...arguments);
  }

  /**
   * Measures a live obstacle-free corridor for the left accordion and toggles
   * focus mode only when the expanded panel plus sibling labels cannot fit.
   * Safe boundaries are written as viewport-relative CSS values.
   * @returns {void}
   */
  _syncLeftPanelAdaptiveLayout() {
    return this._panelLayout._syncLeftPanelAdaptiveLayout();
  }

  /**
   * Presents a panel's state, merged over what it shows now; its root and
   * buttons draw it from the panel chrome store.
   * @param {HTMLElement|string} panelOrId - The panel or its id.
   * @param {object} [patch] - The state that changes.
   * @returns {void}
   */
  _presentPanel(panelOrId, patch) {
    return this._panelChrome._presentPanel(...arguments);
  }

  _buildSharePanelState() {
    return this._panelChrome._buildSharePanelState(...arguments);
  }

  _restorePanelState(panelState) {
    return this._panelChrome._restorePanelState(...arguments);
  }

  /**
   * Reads current detection overlay state (engine mode + UI density percent).
   * @returns {{detectionMode: string, densityPct: number|null, allocationStrategy:string, fadePct:number, outsideOpacityPct:number}}
   */
  getDetectionState() {
    return this._visualSettings.getDetectionState(...arguments);
  }

  /** Read-only overlay diagnostics used by browser QA and regression harnesses. */
  getDetectionDiagnostics() {
    return this._visualSettings.getDetectionDiagnostics(...arguments);
  }

  /** Whether the full-globe celestial overlay is enabled by user preference. */
  get celestialRingEnabled() {
    return this._visualSettings.celestialRingEnabled;
  }

  /**
   * Reads global context mode state for voice/state-sync consumers.
   * @returns {{mode: 'flights'|null, active: boolean, changing: boolean, entering: 'flights'|null, snapshotCaptured: boolean}}
   */
  getContextModeState(...args) {
    return this._contextControls?.getContextModeState(...args);
  }

  /**
   * Sets global context mode (Contacts / off) for voice. Space Missions is
   * an ordinary layer, not a Context mode.
   * @param {'contacts'|'off'|null} mode - Requested context target.
   * @param {object} [options]
   * @param {string|Symbol|null} [options.notificationToken]
   * @param {AbortSignal|null} [options.signal]
   * @param {Function|null} [options.isCurrent]
   * @param {boolean} [options.claimVisualAuthority] Whether this request is a
   *   genuine operator/voice Context intent that should take the visual restore
   *   lane. Cockpit choreography calls this facade INTERNALLY for its own
   *   enter/rollback steps; those transitions are not a Context request by the
   *   operator and must stay inert, so they pass `false`.
   * @returns {Promise<{ok:boolean, mode:'flights'|null, active:boolean, action:string, error?:string}>}
   */
  setContextMode(...args) {
    return this._contextControls?.setContextMode(...args);
  }

  /**
   * Returns cockpit status for voice/state sync and navigation operations.
   * @returns {{active:boolean, entryAllowed:boolean, visionMode:string, subject:{id:string,layerId:string}|null, navigation:{canPrevious:boolean,canNext:boolean,canFocus:boolean}|null, awareness?: object}|null}
   */
  getCockpitState(...args) {
    return this._cockpitCoordinator.getCockpitState(...args);
  }

  /**
   * Controls cockpit entry/exit and context navigation.
   * @param {'enter'|'exit'|'next'|'previous'|'status'} action - Cockpit action.
   * @param {object} [options]
   * @param {string|Symbol|null} [options.notificationToken]
   * @param {'flights'|'military'|'ais-live-vessels'|'military-installations'|null} [options.targetLayer]
   * @param {string|null} [options.aircraftClass]
   * @param {{layerId:'flights'|'military',id:string}|null} [options.selectedTarget]
   * @param {{layerId:'flights'|'military',id:string}|null} [options.rollbackTarget]
   * @returns {{ok:boolean, action:string, error?:string, state?:object}}
   */
  controlCockpit(...args) {
    return this._cockpitCoordinator.controlCockpit(...args);
  }

  /**
   * Snapshots the full visual state (active style, bloom, sharpen, HUD, detection,
   * per-style shader uniform values) for serialization or scene recipe capture.
   * @returns {object} Serializable visual state object.
   */
  getVisualState() {
    return this._visualSettings.getVisualState(...arguments);
  }

  /**
   * Resets the safe-frame overlay to its inactive state on init.
   * @returns {void}
   */
  _initRecordingOverlay() {
    return this._recording._initRecordingOverlay();
  }

  /**
   * Enters or exits recording mode. When active, hides UI chrome via a body class,
   * displays a safe-frame composition overlay (16:9 or 9:16), and switches
   * the HUD to the specified mode. Exiting restores the HUD mode and layout
   * variant that were active before recording started.
   * @param {boolean} enabled - Whether to enable recording mode.
   * @param {object} [options]
   * @param {boolean} [options.hidePanels=true] - Hide all panel chrome.
   * @param {string} [options.hudMode='minimal'] - HUD mode while recording ('off'|'minimal'|'full'|'auto').
   * @param {string} [options.safeFrame='16:9'] - Aspect ratio for the safe-frame overlay.
   * @returns {void}
   */
  setRecordingMode(enabled, options) {
    return this._recording.setRecordingMode(enabled, options);
  }

  /**
   * Sample the manager's layer set and paint the global loading chip.
   * Driven by manager events AND by a ticker, because the underlying state
   * machine is TIME-driven (reveal delay, long-load threshold, terminal
   * dwell) — see _armLoadingFeedbackTicker.
   * @param {number} [now] - performance.now() sample.
   * @returns {void}
   */
  _updateGlobalLoadingFeedback(now) {
    return this._feedback._updateGlobalLoadingFeedback(now);
  }

  /** Show a message in the universal top-center status banner. */
  _showGlobalStatusNotice(message, options) {
    return this._feedback._showGlobalStatusNotice(message, options);
  }

  /**
   * 500 ms DOM ticker for the traffic sync chip. It also
   * polls the loading chip as a safety net: a camera-driven layer can flip
   * its own `stats.loading` without emitting a manager event, and that is
   * the one loading start the event path cannot see.
   */
  _startTrafficChipTicker() {
    return this._feedback._startTrafficChipTicker();
  }

  subscribeLocationSearch(...args) {
    return this._locationNavigation.subscribeLocationSearch(...args);
  }

  _initLocationControls(...args) {
    return this._locationNavigation._initLocationControls(...args);
  }

  /**
   * Publishes the active style, which the scene chrome and Visual show.
   * @param {string} [styleName=this.activeStyle] - Style name to display.
   * @returns {void}
   */
  _publishActiveStyle(styleName = this.activeStyle) {
    return this._visualSettings._publishActiveStyle(...arguments);
  }

  _initOrbit(...args) {
    return this._locationNavigation._initOrbit(...args);
  }

  _toggleOrbit(...args) {
    return this._locationNavigation._toggleOrbit(...args);
  }

  _stopOrbit(...args) {
    return this._locationNavigation._stopOrbit(...args);
  }

  /**
   * Clear every selected data layer without resetting visual, map, HUD, or
   * camera state. A layer may still release camera work it owns as part of its
   * established disable lifecycle.
   * @returns {Promise<object>} Aggregate manager lifecycle truth for the batch.
   */
  clearSelectedLayers(...args) {
    return this._contextControls?.clearSelectedLayers(...args);
  }

  resetToGlobeView(...args) {
    return this._locationNavigation.resetToGlobeView(...args);
  }

  /** Back to live, at the view the app started from (the title's logo). */
  returnToStart() {
    return this._locationNavigation.returnToStart();
  }

  /**
   * Displays a temporary toast notification for 2 seconds.
   * @param {string} message - Text to show in the toast.
   * @returns {void}
   */
  _showToast(message) {
    return this._feedback._showToast(message);
  }

  _syncModels3dFromLayerState(...args) {
    return this._aircraftDisplay._syncModels3dFromLayerState(...args);
  }

  _syncModels3dModeRow(...args) {
    return this._aircraftDisplay._syncModels3dModeRow(...args);
  }

  _initModels3dToggle(...args) {
    return this._aircraftDisplay._initModels3dToggle(...args);
  }

  _setModels3dEnabled(...args) {
    return this._aircraftDisplay._setModels3dEnabled(...args);
  }

  _setModels3dMode(...args) {
    return this._aircraftDisplay._setModels3dMode(...args);
  }

  /**
   * Reuses the production Display controls inside Cockpit without cloning
   * stateful inputs or event listeners. Comment anchors preserve each group's
   * exact home in the standard Display panel for exit and teardown.
   * @returns {void}
   */
  _initCockpitDisplayPortal(...args) {
    return this._cockpitCoordinator._initCockpitDisplayPortal(...args);
  }

  /**
   * Moves the shared HUD, Detection, Parameters, and 3D controls into or out
   * of Cockpit.
   * @param {boolean} active Whether Cockpit owns the Display control groups.
   * @returns {void}
   */
  _setCockpitDisplayPortalActive(...args) {
    return this._cockpitCoordinator._setCockpitDisplayPortalActive(...args);
  }

  get _cockpitDisplayPortalActive() {
    return this._cockpitCoordinator._cockpitDisplayPortalActive;
  }

  get _displayPortalScrollRestoreOwner() {
    return this._cockpitCoordinator._displayPortalScrollRestoreOwner;
  }

  get _standardDisplayScrollTop() {
    return this._cockpitCoordinator._standardDisplayScrollTop;
  }

  /**
   * Syncs the HUD toggle button active class and HUD layout row visibility
   * with the current HUD visible state.
   * @returns {void}
   */
  _updateHudButtonState() {
    return this._visualSettings._updateHudButtonState(...arguments);
  }

  /**
   * Updates the detection toggle button label and CSS classes to reflect
   * the current density-derived profile. Also toggles the density and
   * allocation controls together.
   * @param {string} modeLabel - Current detection mode label.
   * @returns {void}
   */
  _updateDetectionButton(modeLabel) {
    return this._visualSettings._updateDetectionButton(...arguments);
  }

  /**
   * Positions the parameter slider panel directly below the right-rail toggle
   * panel, right-aligned to it. Clamps to viewport bounds to prevent overflow.
   * Runs inside a rAF to batch with other layout reads.
   * @returns {void}
   */
  _layoutRightPanels() {
    return this._panelChrome._layoutRightPanels(...arguments);
  }

  /** Whether a share link was used to load the page */
  get hasShareState() {
    return !!this._hasShareState;
  }
}
