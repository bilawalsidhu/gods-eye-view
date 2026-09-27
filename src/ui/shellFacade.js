/**
 * Compatibility API for layers, scene playback and voice commands.
 * State and behavior live in the named owners; this class only delegates.
 * New logic belongs with an owner, not in this forwarding surface.
 */
export class ShellFacade {
  /** Observe camera ownership transfers through the navigation owner. */
  subscribeCameraHandoff(listener) {
    return this._navigation.subscribeCameraHandoff(listener);
  }

  get _models3dModeBtns() {
    return this._aircraftDisplay._models3dModeBtns;
  }

  set _models3dModeBtns(value) {
    this._aircraftDisplay._models3dModeBtns = value;
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

  get _directionsShellModule() {
    return this._layerBindings?._directionsShellModule;
  }

  set _directionsShellModule(value) {
    this._layerBindings._directionsShellModule = value;
  }

  get _cctvRequestFocusHandler() {
    return this._layerBindings?._cctvRequestFocusHandler;
  }

  set _cctvRequestFocusHandler(value) {
    this._layerBindings._cctvRequestFocusHandler = value;
  }

  get _removeCctvRequestFocusListener() {
    return this._layerBindings?._removeCctvRequestFocusListener;
  }

  set _removeCctvRequestFocusListener(value) {
    this._layerBindings._removeCctvRequestFocusListener = value;
  }

  get _worldRequestFocusHandler() {
    return this._layerBindings?._worldRequestFocusHandler;
  }

  set _worldRequestFocusHandler(value) {
    this._layerBindings._worldRequestFocusHandler = value;
  }

  get _removeWorldRequestFocusListener() {
    return this._layerBindings?._removeWorldRequestFocusListener;
  }

  set _removeWorldRequestFocusListener(value) {
    this._layerBindings._removeWorldRequestFocusListener = value;
  }

  get _removeNavigationAuthorityListener() {
    return this._layerBindings?._removeNavigationAuthorityListener;
  }

  set _removeNavigationAuthorityListener(value) {
    this._layerBindings._removeNavigationAuthorityListener = value;
  }

  get _navigationOwnerChangedRemover() {
    return this._layerBindings?._navigationOwnerChangedRemover;
  }

  set _navigationOwnerChangedRemover(value) {
    this._layerBindings._navigationOwnerChangedRemover = value;
  }

  get _awarenessSelectedHandler() {
    return this._layerBindings?._awarenessSelectedHandler;
  }

  set _awarenessSelectedHandler(value) {
    this._layerBindings._awarenessSelectedHandler = value;
  }

  get _awarenessClearedHandler() {
    return this._layerBindings?._awarenessClearedHandler;
  }

  set _awarenessClearedHandler(value) {
    this._layerBindings._awarenessClearedHandler = value;
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

  get _frameRateMonitor() {
    return this._displayBindings?._frameRateMonitor;
  }

  set _frameRateMonitor(value) {
    this._displayBindings._frameRateMonitor = value;
  }

  get _displayControls() {
    return this._displayBindings?._displayControls;
  }

  set _displayControls(value) {
    this._displayBindings._displayControls = value;
  }

  get _activeLocationId() {
    return this._locationNavigation._activeLocationId;
  }

  set _activeLocationId(value) {
    this._locationNavigation._activeLocationId = value;
  }

  get _expandedCityId() {
    return this._locationNavigation._expandedCityId;
  }

  set _expandedCityId(value) {
    this._locationNavigation._expandedCityId = value;
  }

  get _activePoiIndex() {
    return this._locationNavigation._activePoiIndex;
  }

  set _activePoiIndex(value) {
    this._locationNavigation._activePoiIndex = value;
  }

  get _currentTarget() {
    return this._locationNavigation._currentTarget;
  }

  set _currentTarget(value) {
    this._locationNavigation._currentTarget = value;
  }

  get _currentPoi() {
    return this._locationNavigation._currentPoi;
  }

  set _currentPoi(value) {
    this._locationNavigation._currentPoi = value;
  }

  get _searchedLocationLabel() {
    return this._locationNavigation._searchedLocationLabel;
  }

  set _searchedLocationLabel(value) {
    this._locationNavigation._searchedLocationLabel = value;
  }

  get _trafficTransitionTimer() {
    return this._locationNavigation._trafficTransitionTimer;
  }

  set _trafficTransitionTimer(value) {
    this._locationNavigation._trafficTransitionTimer = value;
  }

  get _locationLookup() {
    return this._locationNavigation._locationLookup;
  }

  set _locationLookup(value) {
    this._locationNavigation._locationLookup = value;
  }

  get _locationLookupUnsubscribe() {
    return this._locationNavigation._locationLookupUnsubscribe;
  }

  set _locationLookupUnsubscribe(value) {
    this._locationNavigation._locationLookupUnsubscribe = value;
  }

  get _locationControls() {
    return this._locationNavigation._locationControls;
  }

  set _locationControls(value) {
    this._locationNavigation._locationControls = value;
  }

  get _locationState() {
    return this._locationNavigation._locationState;
  }

  set _locationState(value) {
    this._locationNavigation._locationState = value;
  }

  get _globeResetPromise() {
    return this._locationNavigation._globeResetPromise;
  }

  set _globeResetPromise(value) {
    this._locationNavigation._globeResetPromise = value;
  }

  get orbitController() {
    return this._locationNavigation.orbitController;
  }

  set orbitController(value) {
    this._locationNavigation.orbitController = value;
  }

  get _orbitIndicator() {
    return this._locationNavigation._orbitIndicator;
  }

  set _orbitIndicator(value) {
    this._locationNavigation._orbitIndicator = value;
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

  get _shareTrackingAcquiringKey() {
    return this._shareRestoration._shareTrackingAcquiringKey;
  }

  set _shareTrackingAcquiringKey(value) {
    this._shareRestoration._shareTrackingAcquiringKey = value;
  }

  get _shareTrackingNoticeGeneration() {
    return this._shareRestoration._shareTrackingNoticeGeneration;
  }

  set _shareTrackingNoticeGeneration(value) {
    this._shareRestoration._shareTrackingNoticeGeneration = value;
  }

  get _initialShareState() {
    return this._shareRestoration._initialShareState;
  }

  set _initialShareState(value) {
    this._shareRestoration._initialShareState = value;
  }

  get _initialShareNavigationGeneration() {
    return this._shareRestoration._initialShareNavigationGeneration;
  }

  set _initialShareNavigationGeneration(value) {
    this._shareRestoration._initialShareNavigationGeneration = value;
  }

  get _initialShareRestoreTimeout() {
    return this._shareRestoration._initialShareRestoreTimeout;
  }

  set _initialShareRestoreTimeout(value) {
    this._shareRestoration._initialShareRestoreTimeout = value;
  }

  get _layerStateCoordinator() {
    return this._shareRestoration._layerStateCoordinator;
  }

  set _layerStateCoordinator(value) {
    this._shareRestoration._layerStateCoordinator = value;
  }

  get _layerStateRestorePromise() {
    return this._shareRestoration._layerStateRestorePromise;
  }

  set _layerStateRestorePromise(value) {
    this._shareRestoration._layerStateRestorePromise = value;
  }

  get _initialShareRestorePromise() {
    return this._shareRestoration._initialShareRestorePromise;
  }

  set _initialShareRestorePromise(value) {
    this._shareRestoration._initialShareRestorePromise = value;
  }

  get _resolveInitialShareRestore() {
    return this._shareRestoration._resolveInitialShareRestore;
  }

  set _resolveInitialShareRestore(value) {
    this._shareRestoration._resolveInitialShareRestore = value;
  }

  get _hasShareState() {
    return this._shareRestoration._hasShareState;
  }

  set _hasShareState(value) {
    this._shareRestoration._hasShareState = value;
  }

  get _initialShareSelectionSuperseded() {
    return this._shareRestoration._initialShareSelectionSuperseded;
  }

  set _initialShareSelectionSuperseded(value) {
    this._shareRestoration._initialShareSelectionSuperseded = value;
  }

  get _initialShareGestureHandler() {
    return this._shareRestoration._initialShareGestureHandler;
  }

  set _initialShareGestureHandler(value) {
    this._shareRestoration._initialShareGestureHandler = value;
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

  get _cockpitVisionMode() {
    return this._visualSettings._cockpitVisionMode;
  }

  set _cockpitVisionMode(value) {
    this._visualSettings._cockpitVisionMode = value;
  }

  get _cockpitVisionRestore() {
    return this._visualSettings._cockpitVisionRestore;
  }

  set _cockpitVisionRestore(value) {
    this._visualSettings._cockpitVisionRestore = value;
  }

  get _contactsDetectionRestore() {
    return this._visualSettings._contactsDetectionRestore;
  }

  set _contactsDetectionRestore(value) {
    this._visualSettings._contactsDetectionRestore = value;
  }

  get _detectionAllocationBtns() {
    return this._visualSettings._detectionAllocationBtns;
  }

  set _detectionAllocationBtns(value) {
    this._visualSettings._detectionAllocationBtns = value;
  }

  get _detectionAllocationPreference() {
    return this._visualSettings._detectionAllocationPreference;
  }

  set _detectionAllocationPreference(value) {
    this._visualSettings._detectionAllocationPreference = value;
  }

  get _styleParameters() {
    return this._visualSettings._styleParameters;
  }

  set _styleParameters(value) {
    this._visualSettings._styleParameters = value;
  }

  get _irBoostActive() {
    return this._visualSettings._irBoostActive;
  }

  set _irBoostActive(value) {
    this._visualSettings._irBoostActive = value;
  }

  get _irFogWasEnabled() {
    return this._visualSettings._irFogWasEnabled;
  }

  set _irFogWasEnabled(value) {
    this._visualSettings._irFogWasEnabled = value;
  }

  get _panelDisclosureControls() {
    return this._panelChrome._panelDisclosureControls;
  }

  set _panelDisclosureControls(value) {
    this._panelChrome._panelDisclosureControls = value;
  }

  get _hoverPanelControls() {
    return this._panelChrome._hoverPanelControls;
  }

  set _hoverPanelControls(value) {
    this._panelChrome._hoverPanelControls = value;
  }

  get _cancelMapSourceFocus() {
    return this._panelChrome._cancelMapSourceFocus;
  }

  set _cancelMapSourceFocus(value) {
    this._panelChrome._cancelMapSourceFocus = value;
  }

  get _cockpitContextCollapsedForDataPanel() {
    return this._panelChrome._cockpitContextCollapsedForDataPanel;
  }

  set _cockpitContextCollapsedForDataPanel(value) {
    this._panelChrome._cockpitContextCollapsedForDataPanel = value;
  }

  get _cockpitPanelRestore() {
    return this._panelChrome._cockpitPanelRestore;
  }

  set _cockpitPanelRestore(value) {
    this._panelChrome._cockpitPanelRestore = value;
  }

  get _panelPosition() {
    return this._panelChrome._panelPosition;
  }

  set _panelPosition(value) {
    this._panelChrome._panelPosition = value;
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

  get _bloomStage() {
    return this._visualEffects.bloomStage;
  }

  get _sharpenStage() {
    return this._visualEffects.sharpenStage;
  }

  /** Settle only the search generation that still owns the shared input UI. */
  _settleLocationSearchUi(generation) {
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
   * Hand the Directions layer the camera seams its FLY chip needs: the same
   * immediate-navigation facade voice route flights go through, so there is
   * one camera owner rather than a second one inside a data layer, the shared
   * ground-floor read/warm the route dolly flies over, and the app's own toast
   * so the layer can speak where the rest of the UI speaks.
   * @returns {void}
   */
  _connectDirectionsCamera(...args) {
    return this._layerBindings._connectDirectionsCamera(...args);
  }

  /**
   * On window resize, keep the draggable panel on-screen — a panel positioned near an edge can fall
   * outside a now-smaller viewport (audit U2). pp-toggles is right-pinned, so re-pin (horizontal) and
   * clamp its top. No-op until the panel has been positioned (explicit inline top).
   * @returns {void}
   */
  _reclampDraggablePanels() {
    return this._panelPosition._reclampDraggablePanels();
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
   * Single write path for style-stage intensity: keeps `enabled` in
   * lockstep so zero-intensity stages cost nothing (safe now that the
   * scope is explicit — see _initStages). The stage enables on the same
   * frame the first non-zero intensity lands, so crossfades never pop.
   * @param {Cesium.PostProcessStage} stage - Style post-process stage.
   * @param {number} value - Intensity in [0, 1].
   * @returns {void}
   */
  _setStageIntensity(stage, value) {
    return this._visualSettings._setStageIntensity(...arguments);
  }

  /**
   * Re-sync every stage's `enabled` flag from its CURRENT intensity.
   *
   * The cockpit-vision policy helpers (src/cockpitVisionPolicy.js) are pure
   * intensity math — they write `uniforms.intensity` directly and know
   * nothing about the enabled/intensity lockstep _setStageIntensity owns.
   * Without this sweep a stage the policy raised to 1 would stay DISABLED
   * and cockpit NVG/FLIR/CRT would render nothing at all. (Inert while the
   * chain is permanently enabled; load-bearing again once the explicit
   * scope frees the zero-intensity stages — see _initStages.)
   * @returns {void}
   */
  _syncStagesEnabledFromIntensity() {
    return this._visualSettings._syncStagesEnabledFromIntensity(...arguments);
  }

  /**
   * Contacts-scoped detection (owner playtest 2026-08-18: "when you click on
   * Contacts, detections should just turn on, and they should stay on in
   * Cockpit or in third-person tracking inside Contacts").
   *
   * The scope is the CONTACTS SESSION, not Cockpit. Cockpit enter/exit and
   * third-person tracking are moves WITHIN that session and deliberately do not
   * touch detection — an earlier build hooked this to cockpit enter/exit, which
   * is exactly what turned detections off when the owner left the cockpit.
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

  /** IR hot-target boost (owner playtest 2026-08-16): under the luminance-
   *  mapped NVG/FLIR looks the 3D fleets flip to flat white so contacts read
   *  HOT instead of vanishing mid-gray; restored when the look exits. The
   *  EFFECTIVE look is Cockpit's vision override while Cockpit is active
   *  ('nvg'/'thermal', which can differ from the map preset in BOTH
   *  directions), otherwise the map preset ('surveillance'/'thermal'). */
  _syncIrBoost() {
    return this._visualSettings._syncIrBoost(...arguments);
  }

  /** Keep Cockpit's inherited label and restore target aligned with the active map preset. */
  _syncCockpitInheritedStyle() {
    return this._visualSettings._syncCockpitInheritedStyle(...arguments);
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
   * Reads the current bloom intensity percentage from the effects controller.
   * @returns {number} Clamped bloom intensity (0-200).
   */
  _getBloomIntensity() {
    return this._visualSettings._getBloomIntensity(...arguments);
  }

  /**
   * Enables or disables the Cesium bloom stage based on both the user toggle
   * and whether the computed strength exceeds the perceptual threshold (0.06).
   * @returns {void}
   */
  _syncBloomStageEnabled() {
    return this._visualSettings._syncBloomStageEnabled(...arguments);
  }

  /**
   * Maps a bloom intensity percentage to Cesium bloom stage uniforms.
   * Uses smoothstep easing (Hermite interpolation: 3t^2 - 2t^3) to
   * produce a perceptually linear glow ramp from zero to full strength.
   * @param {number} intensity - Bloom intensity percentage (0-200).
   * @returns {void}
   */
  _applyBloomIntensity(intensity) {
    return this._visualSettings._applyBloomIntensity(...arguments);
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
   * Maps a normalized sharpen value (0-1) to the unsharp-mask `amount` uniform.
   * Range: 0.1 (subtle) to 2.1 (aggressive edge enhancement).
   * @param {number} val - Normalized sharpen intensity (0.0 to 1.0).
   * @returns {void}
   */
  _applySharpenIntensity(val) {
    return this._visualSettings._applySharpenIntensity(...arguments);
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
   * Reads and canonicalizes the five-stop density control. The engine derives
   * Sparse/Balanced/Dense from the same stop.
   * @returns {void}
   */
  _applyDetectionDensityFromUi() {
    return this._visualSettings._applyDetectionDensityFromUi(...arguments);
  }

  /** Apply responsive keyhole fade controls from normalized UI percentages. */
  _applyDetectionFadeFromUi() {
    return this._visualSettings._applyDetectionFadeFromUi(...arguments);
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
   * Applies preset defaults (bloom, sharpen, shader uniforms, HUD variant)
   * when a military-class style (CRT, NVG, FLIR) is selected. Does nothing
   * for styles without entries in STYLE_PRESET_DEFAULTS.
   * @param {string} styleName - The style whose defaults to apply.
   * @returns {void}
   */
  _applyStylePresetDefaults(styleName) {
    return this._visualSettings._applyStylePresetDefaults(...arguments);
  }

  /**
   * Apply a detection preset's density and mode through the real UI path.
   *
   * Deliberately does NOT consult `_detectionUserOverridden` — the CALLER owns
   * that decision. The style path checks it (an explicit Sparse/Off must
   * survive a style switch); Cockpit entry does not (owner: detection is on in
   * the cockpit "regardless").
   * @param {{mode?: string, densityPct?: number}} det Preset detection config.
   * @returns {void}
   */
  _applyDetectionPreset(det) {
    return this._visualSettings._applyDetectionPreset(...arguments);
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

  /**
   * Detection as a DURABLE preference, for serialization into a share link.
   *
   * While Contacts is active it OWNS detection and forces Dense @ 75%. That is
   * a session-scoped override, not something the operator chose: it is undone
   * verbatim on deactivation. Serializing the forced values shipped a link that
   * pinned Dense @ 75% on the recipient — as a durable preference, with no
   * Contacts mode present to explain or undo it — even though the author's own
   * setting was (say) OFF @ 50%. Publish what deactivation would restore.
   *
   * `_contactsDetectionRestore` is exactly that snapshot and is null whenever
   * Contacts does not own detection, so the live values are used normally.
   */
  _shareableDetectionState() {
    return this._visualSettings._shareableDetectionState(...arguments);
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
   * Also sets up hover-expand behavior for the style presets and location bar panels.
   * @returns {void}
   */
  _initPanelChrome() {
    return this._panelChrome._initPanelChrome(...arguments);
  }

  /**
   * Collapses the nearest expanded panel that owns keyboard focus on Escape.
   * Nested panels consume the event first, so one key closes one level and
   * returns focus to that level's disclosure. If Escape was pressed on the
   * disclosure itself, remove focus after closing so the collapsed button does
   * not keep a stale keyboard ring.
   * @param {KeyboardEvent} event - Candidate Escape key event.
   * @param {string} panelId - Collapsible panel containing the listener.
   * @returns {boolean} Whether this panel handled the key.
   */
  _collapsePanelOnEscape(event, panelId) {
    return this._panelChrome._collapsePanelOnEscape(...arguments);
  }

  /**
   * Allows either command-dock tray to remain open until explicitly unpinned.
   * Both trays may be pinned; transient and error trays stack above them.
   * @returns {void}
   */
  _initCommandDockPins() {
    return this._panelChrome._initCommandDockPins(...arguments);
  }

  /**
   * Tracks the live pinned-tray height so a hovered sibling can stack above it
   * without hardcoded content dimensions.
   * @returns {void}
   */
  _initCommandDockTrayMetrics() {
    return this._panelChrome._initCommandDockTrayMetrics(...arguments);
  }

  /**
   * Writes each pinned tray height and their combined stack height as CSS
   * variables. The most recently pinned tray forms the upper level.
   * @returns {void}
   */
  _updateCommandDockTrayStack() {
    return this._panelChrome._updateCommandDockTrayStack(...arguments);
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
   * Sets up drag-to-reposition for legacy floating controls. The right rail
   * and left accordion remain fixed so their HUD alignment is deterministic.
   * @returns {void}
   */
  _initPanelDrag() {
    return this._panelPosition._initPanelDrag();
  }

  _persistAwarenessSelection(...args) {
    return this._layerBindings._persistAwarenessSelection(...args);
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

  _handleShareTrackingRestoreStatus(result) {
    return this._shareRestoration._handleShareTrackingRestoreStatus(
      ...arguments,
    );
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

  _setRadioDisclosure(...args) {
    return this._radioControls?._setRadioDisclosure?.(...args);
  }

  _syncContextRadioLauncherState(...args) {
    return this._radioControls?._syncContextRadioLauncherState?.(...args);
  }

  _renderRadioState(...args) {
    return this._radioControls?._renderRadioState?.(...args);
  }

  /**
   * Returns the versioned localStorage key for a panel's saved position.
   * @param {string} panelId - DOM id of the panel.
   * @returns {string} localStorage key.
   */
  _panelStorageKey(panelId) {
    return this._panelPosition._panelStorageKey(panelId);
  }

  /**
   * Returns the versioned localStorage key for a panel's collapsed state.
   * @param {string} panelId - DOM id of the panel.
   * @returns {string} localStorage key.
   */
  _panelCollapseStorageKey(panelId) {
    return this._panelPosition._panelCollapseStorageKey(panelId);
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
   * Updates collapse button glyphs based on panel state. Right-rail panels
   * use directional arrows; left-stack panels use +/- symbols.
   * @param {HTMLElement} panelEl - The panel DOM element.
   * @returns {void}
   */
  _syncPanelCollapseButton(panelEl) {
    return this._panelChrome._syncPanelCollapseButton(...arguments);
  }

  /**
   * Converts a panel from left-positioned to right-anchored so it expands
   * leftward on resize. Used for the right-rail parameter panel.
   * @param {HTMLElement} panelEl - The panel to re-anchor.
   * @returns {void}
   */
  _pinPanelToRight(panelEl) {
    return this._panelPosition._pinPanelToRight(panelEl);
  }

  /**
   * Restores a panel's top/left position from localStorage.
   * Right-rail panels are additionally pinned to the right edge.
   * @param {string} panelId - DOM id of the panel.
   * @param {HTMLElement} panelEl - The panel DOM element.
   * @returns {void}
   */
  _restorePanelPosition(panelId, panelEl) {
    return this._panelPosition._restorePanelPosition(panelId, panelEl);
  }

  /**
   * Clamp a desired left/top so the panel stays fully on-screen (6px inset), matching the drag
   * clamp (ui.js ~1822). Width/height are position-independent, so reading the rect first is safe.
   * @param {number} left - desired left (px)
   * @param {number} top - desired top (px)
   * @param {HTMLElement} panelEl - the panel element
   * @returns {{left:number, top:number}}
   */
  _clampToViewport(left, top, panelEl) {
    return this._panelPosition._clampToViewport(left, top, panelEl);
  }

  /**
   * Persists a panel's current bounding-rect position to localStorage.
   * @param {string} panelId - DOM id of the panel.
   * @param {HTMLElement} panelEl - The panel DOM element.
   * @returns {void}
   */
  _savePanelPosition(panelId, panelEl) {
    return this._panelPosition._savePanelPosition(panelId, panelEl);
  }

  /**
   * Promotes a panel to the top of the panel z band [PANEL_Z_BASE, PANEL_Z_MAX].
   * Renormalizes all promoted panels when the band is exhausted so panels can
   * never climb above the voice pill (150), toasts (200), or clean-view exit (300).
   * @param {HTMLElement} panelEl - Panel to bring to front.
   * @returns {void}
   */
  _promotePanelZ(panelEl) {
    return this._panelPosition._promotePanelZ(panelEl);
  }

  _makePanelDraggable(panelId, panelEl, handleEl) {
    return this._panelPosition._makePanelDraggable(panelId, panelEl, handleEl);
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

  setOrbit(...args) {
    return this._locationNavigation.setOrbit(...args);
  }

  /**
   * Reads global context mode state for voice/state-sync consumers.
   * @returns {{mode: 'flights'|'space-missions'|null, active: boolean, changing: boolean, entering: 'flights'|'space-missions'|null, snapshotCaptured: boolean}}
   */
  getContextModeState(...args) {
    return this._contextControls?.getContextModeState(...args);
  }

  /**
   * Sets global context mode (Contacts / Space Missions / off) for voice.
   * @param {'contacts'|'space-missions'|'off'|null} mode - Requested context target.
   * @param {object} [options]
   * @param {string|Symbol|null} [options.notificationToken]
   * @param {AbortSignal|null} [options.signal]
   * @param {Function|null} [options.isCurrent]
   * @param {boolean} [options.claimVisualAuthority] Whether this request is a
   *   genuine operator/voice Context intent that should take the visual restore
   *   lane. Cockpit choreography calls this facade INTERNALLY for its own
   *   enter/rollback steps; those transitions are not a Context request by the
   *   operator and must stay inert, so they pass `false`.
   * @returns {Promise<{ok:boolean, mode:'flights'|'space-missions'|null, active:boolean, action:string, error?:string}>}
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
   * Point Cockpit entry at a requested contact layer before it enters.
   *
   * Reuses the filtered Context navigation NEXT already uses, so "cockpit in
   * that military helicopter" lands on the same contact "next military
   * helicopter" would. Cockpit flies aircraft only; vessel and installation
   * layers are refused by name rather than silently ignored.
   * @param {object} options Retarget request.
   * @param {string} options.targetLayer Requested contact layer.
   * @param {string|null} options.aircraftClass Optional class filter.
   * @param {{layerId: string}|null} options.currentTarget Current tracker.
   * @param {{layerId: string}|null} options.selectedTarget Pending selection.
   * @returns {{ok: boolean, retargeted?: boolean, error?: string}} Outcome.
   */
  _retargetCockpitEntryLayer(...args) {
    return this._cockpitCoordinator._retargetCockpitEntryLayer(...args);
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

  /** Reveal the map-only parameter surface in the standard Display scroll owner. */
  _revealStyleParameters() {
    return this._visualSettings._revealStyleParameters(...arguments);
  }

  /**
   * Enqueues a smooth intensity transition for a shader stage. The animation
   * loop interpolates from `fromValue` to `toValue` over TRANSITION_DURATION_MS.
   * @param {string} styleName - Name of the shader stage to transition.
   * @param {number} fromValue - Starting intensity (typically current value).
   * @param {number} toValue - Target intensity (0.0 to fade out, 1.0 to fade in).
   * @returns {void}
   */
  _startTransition(styleName, fromValue, toValue) {
    return this._visualSettings._startTransition(...arguments);
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
   * 500 ms DOM ticker for the traffic sync chip (was per-frame). It also
   * polls the loading chip as a safety net: a camera-driven layer can flip
   * its own `stats.loading` without emitting a manager event, and that is
   * the one loading start the event path cannot see.
   */
  _startTrafficChipTicker() {
    return this._feedback._startTrafficChipTicker();
  }

  /**
   * Self-stopping 60 ms ticker for the global loading chip.
   *
   * The chip used to ride the style rAF loop, which perf wave 2 made
   * self-stopping — leaving the chip frozen mid-state whenever no crossfade
   * or animated shader was running (it would never reveal, never cross the
   * long-load threshold, and never dwell out). Its reducer
   * (src/loadingFeedback.js) is time-driven, so it needs real ticks; it is
   * also pure DOM, so it takes NO governor hold and requests no render.
   * Armed by _updateGlobalLoadingFeedback whenever loading leaves idle or a
   * universal notice begins, and stops once both have settled.
   * (rebase 2026-08-16: main's loading chip vs wave 2's stopped loop)
   * @returns {void}
   */
  _armLoadingFeedbackTicker() {
    return this._feedback._armLoadingFeedbackTicker();
  }

  /** Stop the loading-chip ticker if it is running. Idempotent. */
  _stopLoadingFeedbackTicker() {
    return this._feedback._stopLoadingFeedbackTicker();
  }

  subscribeLocationSearch(...args) {
    return this._locationNavigation.subscribeLocationSearch(...args);
  }

  _handleLocationSearchState(...args) {
    return this._locationNavigation._handleLocationSearchState(...args);
  }

  _initLocationBar(...args) {
    return this._locationNavigation._initLocationBar(...args);
  }

  _beginWorldJumpTransition(...args) {
    return this._locationNavigation._beginWorldJumpTransition(...args);
  }

  _endWorldJumpTransition(...args) {
    return this._locationNavigation._endWorldJumpTransition(...args);
  }

  _flyWithTransition(...args) {
    return this._locationNavigation._flyWithTransition(...args);
  }

  _onCityPillClick(...args) {
    return this._locationNavigation._onCityPillClick(...args);
  }

  _onPoiClick(...args) {
    return this._locationNavigation._onPoiClick(...args);
  }

  _expandPOIRow(...args) {
    return this._locationNavigation._expandPOIRow(...args);
  }

  _collapsePOIRow(...args) {
    return this._locationNavigation._collapsePOIRow(...args);
  }

  _updatePoiHighlight(...args) {
    return this._locationNavigation._updatePoiHighlight(...args);
  }

  clearSearchedLocation(...args) {
    return this._locationNavigation.clearSearchedLocation(...args);
  }

  _setActiveLocation(...args) {
    return this._locationNavigation._setActiveLocation(...args);
  }

  _updateLocationMiniStatus(...args) {
    return this._locationNavigation._updateLocationMiniStatus(...args);
  }

  /**
   * Updates the collapsed mini-status readout with the active style label.
   * @param {string} [styleName=this.activeStyle] - Style name to display.
   * @returns {void}
   */
  _updateStyleMiniStatus(styleName = this.activeStyle) {
    return this._visualSettings._updateStyleMiniStatus(...arguments);
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

  /**
   * Displays a temporary toast notification for 2 seconds.
   * @param {string} message - Text to show in the toast.
   * @returns {void}
   */
  _showToast(message) {
    return this._feedback._showToast(message);
  }

  /** One 3D toggle drives BOTH aircraft layers (commercial + military) so all planes flip together. */
  _setModels3dParams(...args) {
    return this._aircraftDisplay._setModels3dParams(...args);
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

  _syncModels3dButtonState(...args) {
    return this._aircraftDisplay._syncModels3dButtonState(...args);
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

  _settleInitialShareRestore(result) {
    return this._shareRestoration._settleInitialShareRestore(...arguments);
  }
}
