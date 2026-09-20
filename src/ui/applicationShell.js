import { STYLE_STATUS_LABELS } from './visualPresets.js';
import { PanelChrome } from './panelChrome.js';
import { VisualSettings } from './visualSettings.js';
import { NavigationController } from './navigationController.js';
import { ShareRestoration } from './shareRestoration.js';
import { createFrameRateMonitor } from './frameRateMonitor.js';
import { createStateChannel } from '../app/stateChannel.js';
import { setSplitFlapText } from '../splitFlap.js';
import { UiLifetime } from './uiLifetime.js';
import { RecordingControls } from './recordingControls.js';
import { readShellElements } from './shellElements.js';
import { CockpitViewController, CockpitDisplayPortal } from './cockpit.js';
import { ContextControls } from './context.js';
import { CctvControls } from './cctv.js';
import { RadioControls } from './radio.js';
import { LocationControls } from './location.js';
import { bindClearLayersControl } from './layers.js';
import { bindCameraOrientationControls } from './cameraOrientationControls.js';
import { createMapSourceControls } from './mapSource.js';
import { STYLES } from './effects.js';
import { bindDisplayControls } from './displayControls.js';
import { bindApplicationShortcuts } from './visualInput.js';
import { getTacticalAudio } from '../audio/tacticalAudio.js';
import { CockpitAmbiance } from '../audio/cockpitAmbiance.js';
import { AudioControls } from './audioControls.js';
import { RadialMenu } from './radialMenu.js';
import { TrajectoryOverlay } from '../overlays/trajectoryOverlay.js';
import { GeofenceEngine } from '../layers/geofenceEngine.js';
import { GeofenceRenderer } from '../layers/geofenceRenderer.js';
import { GeofenceControls } from './geofenceControls.js';
import { TimelineCache } from '../data/timelineCache.js';
import { TimelineScrubber } from './timelineScrubber.js';
import { GestureControls } from './gestureControls.js';
import { TouchGestureController } from '../gestures/touchGestures.js';
import { WeatherParticles } from '../effects/weatherParticles.js';
import { ExportControls } from './exportControls.js';

import * as Cesium from 'cesium';
import { decodeBloomIntensity } from '../bloom.js';

import {
  aircraftTrackingTarget,
  enterCockpitWithTracking,
} from '../cockpitTracking.js';

import { isExplicitLayerStateOrigin } from '../data/layerState.js';

import { canonicalizeDensity } from '../data/detectionPolicy.js';

import { ShellFeedback } from './shellFeedback.js';

import { cockpitEntryAllowed } from '../contextModePolicy.js';

import { formatAwarenessLabel } from '../data/militaryAwarenessEngine.js';
import { runCctvLayerEnableTransition } from '../cctvFocusPolicy.js';
import {
  registerCctvFocusRequestListener,
  routeCctvFocusRequest,
} from '../cctvFocusRequest.js';
import {
  flyToWorldTarget,
  registerWorldFocusRequestListener,
  routeWorldFocusRequest,
} from '../worldFocus.js';
import { registerNavigationAuthorityListener } from '../navigationPolicy.js';

/** Display labels shown in the mini-status readout for each active style. */

/**
 * Central UI orchestrator for the God's Eye View application.
 *
 * Responsibilities:
 * - Visual controls and presets backed by the VisualEffects controller.
 * - Bloom and sharpen post-processing toggle/intensity control.
 * - Draggable/collapsible panel system with localStorage persistence,
 *   z-order stacking, and viewport-clamped positioning.
 * - CCTV panel: camera selection, coverage toggle, projection, calibration
 *   sliders, auto-hop, and summary typewriter effect.
 * - Location bar with city/POI preset pills, QWERTY key navigation,
 *   geocoding search, and inter-city world-jump transitions.
 * - Orbit controller integration for POI fly-around.
 * - Recording mode with safe-frame overlay and HUD mode switching.
 * - Share link encoding/decoding (delegates to ShareLinkManager).
 * - Detection overlay mode cycling and density tuning.
 * - Toast notification system.
 * - Intel HUD lifecycle and variant switching.
 */

export class StyleManager {
  /**
   * @param {Cesium.Viewer} viewer - The CesiumJS viewer instance.
   * @param {object} [options]
   */
  constructor(
    viewer,
    { mapStackController = null, placeSearch, services, requestServices } = {},
  ) {
    const {
      IntelHUD,
      ShareLinkManager,
      OrbitController,
      CelestialRing,
      initTrackedReadout,
      initWorldOverlay,
      initDetection,
      setDetectionStyle,
      trafficLayer,
      flightsLayer,
      militaryFlightsLayer,
      isTr3b,
      toggleTr3b,
      satellitesLayer,
      cctvLayer,
      bikeshareLayer,
      transitLayer,
      aisLiveVesselsLayer,
      militaryAwarenessLayer,
      cachedGroundFloor,
      cachedMeshFloor,
      GROUND_FLOOR_LIFT_M,
      meshFloorPreferred,
      warmGroundFloor,
      sampleMeshFloorCells,
      holdContinuousRender,
      releaseContinuousRender,
      governorRequestRender,
      setScopeMaskEnabled,
      setScopeMaskFeather,
      setScopeTerminusOverride,
      clampScopeTerminusPct,
      fetchRegionalBrief,
      regionalDistanceM,
      weatherCodeLabel,
    } = services;
    this.services = services;
    this._lifetime = new UiLifetime();
    this._recording = new RecordingControls({
      syncShareState: () => this._syncShareState(),
    });
    Object.assign(this, readShellElements());
    this._panelChrome = new PanelChrome({
      elements: {
        _contextRadioDetailsBtn: this._contextRadioDetailsBtn,
        _contextRadioDock: this._contextRadioDock,
        _leftPanelStack: this._leftPanelStack,
        _locationSearch: this._locationSearch,
        _ppToggles: this._ppToggles,
        _rightPanelStack: this._rightPanelStack,
      },
      operations: {
        _setRadioDisclosure: (...args) => this._setRadioDisclosure(...args),
        _syncCctvPanelViewport: (...args) =>
          this._syncCctvPanelViewport(...args),
        _syncContextRadioLauncherState: (...args) =>
          this._syncContextRadioLauncherState(...args),
        _showToast: (...args) => this._showToast(...args),
      },
      readHud: () => this.hud,
      readCockpit: () => this.cockpitView,
      readShareLinks: () => this.shareLinkManager,
      readInitialShare: () => this._initialShareState,
      readScrollRestoreOwner: () => this._displayPortalScrollRestoreOwner,
      readDisplayScrollTop: () => this._standardDisplayScrollTop,
    });
    this._feedback = new ShellFeedback({
      readLayers: () => this._dataManager?.getAll?.() || [],
    });
    this.viewer = viewer;
    this.mapStackController = mapStackController;
    this.placeSearch = placeSearch;

    this._navigation = new NavigationController({
      viewer,
      tracking: {
        flightsLayer,
        militaryFlightsLayer,
        satellitesLayer,
        aisLiveVesselsLayer,
        militaryAwarenessLayer,
        rocketLaunchesLayer: services.rocketLaunchesLayer,
      },
      searchInput: this._locationSearch,
      interruptCameraMotion: services.interruptCameraMotion,
      isCockpitActive: () => !!this.cockpitView?.active,
      clearLocation: () => this.clearSearchedLocation(),
      cancelShareSelection: () => this._shareRestoration.cancelSelection(),
      getDataManager: () => this._dataManager,
      stopOrbit: () => this._stopOrbit(),
      cancelOrientation: () => this._cameraOrientationControls?.cancel(),
      showToast: (text) => this._showToast(text),
    });
    this._shareRestoration = new ShareRestoration({
      viewer,
      navigation: this._navigation,
      syncShareState: () => this._syncShareState(),
      syncModels3d: (state) => this._syncModels3dFromLayerState(state),
      showStatus: (message, options) =>
        this._showGlobalStatusNotice(message, options),
      feedback: this._feedback,
      updateFeedback: () => this._updateGlobalLoadingFeedback(),
    });

    this._visualSettings = new VisualSettings({
      viewer,
      mapStackController,
      services: {
        getDetectionMode: services.getDetectionMode,
        getDetectionTuning: services.getDetectionTuning,
        getKeyholeFadeTuning: services.getKeyholeFadeTuning,
        getScopeMaskFeather: services.getScopeMaskFeather,
        getScopeTerminusOverride: services.getScopeTerminusOverride,
        governorRequestRender: services.governorRequestRender,
        holdContinuousRender: services.holdContinuousRender,
        isCelestialRingStyleSupported: services.isCelestialRingStyleSupported,
        isScopeMaskEnabled: services.isScopeMaskEnabled,
        readDetectionDiagnostics: services.readDetectionDiagnostics,
        releaseContinuousRender: services.releaseContinuousRender,
        setDetectionModeByLabel: services.setDetectionModeByLabel,
        setDetectionStyle: services.setDetectionStyle,
        setDetectionTuning: services.setDetectionTuning,
        setKeyholeFadeTuning: services.setKeyholeFadeTuning,
        setScopeMaskEnabled: services.setScopeMaskEnabled,
        setScopeMaskFeather: services.setScopeMaskFeather,
      },
      elements: {
        _bloomBtn: this._bloomBtn,
        _bloomSlider: this._bloomSlider,
        _bloomSliderRow: this._bloomSliderRow,
        _bloomSliderValue: this._bloomSliderValue,
        _celestialBtn: this._celestialBtn,
        _cockpitDisplayToggleBtn: this._cockpitDisplayToggleBtn,
        _detectionAllocationRow: this._detectionAllocationRow,
        _detectionBtn: this._detectionBtn,
        _detectionDensitySlider: this._detectionDensitySlider,
        _detectionDensityValue: this._detectionDensityValue,
        _detectionFadeRow: this._detectionFadeRow,
        _detectionFadeSlider: this._detectionFadeSlider,
        _detectionFadeValue: this._detectionFadeValue,
        _detectionOpacityRow: this._detectionOpacityRow,
        _detectionOpacitySlider: this._detectionOpacitySlider,
        _detectionOpacityValue: this._detectionOpacityValue,
        _detectionSliderRow: this._detectionSliderRow,
        _hudBtn: this._hudBtn,
        _hudLayoutRow: this._hudLayoutRow,
        _hudLayoutSelect: this._hudLayoutSelect,
        _ppToggles: this._ppToggles,
        _scopeBtn: this._scopeBtn,
        _scopeFeatherSlider: this._scopeFeatherSlider,
        _scopeFeatherValue: this._scopeFeatherValue,
        _sharpenBtn: this._sharpenBtn,
        _sharpenSlider: this._sharpenSlider,
        _sharpenSliderRow: this._sharpenSliderRow,
        _sharpenSliderValue: this._sharpenSliderValue,
        _sliderContainer: this._sliderContainer,
        _sliderPanel: this._sliderPanel,
        _styleIndicator: this._styleIndicator,
        _styleMiniValue: this._styleMiniValue,
      },
      operations: {
        _layoutRightPanels: (...args) => this._layoutRightPanels(...args),
        _scheduleAdaptivePanelLayout: (...args) =>
          this._scheduleAdaptivePanelLayout(...args),
        _scheduleRightPanelLayout: (...args) =>
          this._scheduleRightPanelLayout(...args),
        _setCockpitDisclosure: (...args) => this._setCockpitDisclosure(...args),
        _setMapStack: (...args) => this._setMapStack(...args),
        _syncPanelCollapseButton: (...args) =>
          this._syncPanelCollapseButton(...args),
        _syncShareState: (...args) => this._syncShareState(...args),
        setPanelCollapsed: (...args) => this.setPanelCollapsed(...args),
      },
      readHud: () => this.hud,
      readCockpit: () => this.cockpitView,
      readDataManager: () => this._dataManager,
      readShareLinks: () => this.shareLinkManager,
      readCelestialRing: () => this.celestialRing,
      readContextMode: () => this._contextMode,
      readContextChanging: () => this._contextModeChanging,
      readDisplayPortalActive: () => this._cockpitDisplayPortalActive,
    });

    // Bloom/sharpen state
    this._globeResetPromise = null;
    this._dataManager = null;
    this._directionsShellModule = null;

    this._windowResizeHandler = null;
    this._cctvRequestFocusHandler = null;
    this._removeCctvRequestFocusListener = null;
    this._worldRequestFocusHandler = null;
    this._removeWorldRequestFocusListener = null;
    this._removeNavigationAuthorityListener = null;
    this._navigationOwnerChangedRemover = null;
    this._awarenessSelectedHandler = null;
    this._awarenessClearedHandler = null;
    this._disposed = false;

    // DOM refs

    this._mapStackChangeHandler = null;

    this._cockpitDisplayPortal = null;
    this._cockpitDisplayModeHandler = null;

    this._activeLocationId = null;
    this._expandedCityId = null;
    this._activePoiIndex = null;
    this._currentTarget = null; // Cesium.Cartesian3 of current POI target
    this._currentPoi = null; // Current POI data object
    // Formatted address of the last free-text geocode search. Preset pills set
    // _activeLocationId instead; a search has no preset record, so this is the
    // only thing the mini-status can report for it.
    this._searchedLocationLabel = null;
    this._trafficTransitionTimer = null;
    this._lastTrafficChipUpdateAt = 0;

    // Orbit controller
    this.orbitController = new OrbitController(viewer);
    this._orbitIndicator = null;

    // Intel HUD
    this.hud = new IntelHUD(viewer, {
      placeSearch,
      summaryService: requestServices?.summary,
    });
    this._recording.hud = this.hud;
    // True only while the open Data Layers panel is the reason Cockpit's
    // Contact panel is collapsed. A user-collapsed Contact panel must remain
    // collapsed when Data Layers closes.
    /** Pre-Contacts detection state, restored on deactivation (see _syncContactsDetection). */
    this.cockpitView = new CockpitViewController(viewer, {
      services: {
        flightsLayer,
        militaryFlightsLayer,
        isTr3b,
        toggleTr3b,
        militaryAwarenessLayer,
        formatAwarenessLabel,
        cachedGroundFloor,
        cachedMeshFloor,
        GROUND_FLOOR_LIFT_M,
        meshFloorPreferred,
        warmGroundFloor,
        sampleMeshFloorCells,
        holdContinuousRender,
        releaseContinuousRender,
        fetchRegionalBrief,
        regionalDistanceM,
        weatherCodeLabel,
      },
      onVisionChange: (mode, active, options) =>
        this._setCockpitVision(mode, active, options),
      onCameraTakeover: () =>
        this._stampNavigation({ cancelPendingSelection: false }),
      getInheritedVisionLabel: () =>
        STYLE_STATUS_LABELS[this.activeStyle] ||
        String(this.activeStyle || 'normal').toUpperCase(),
      isEntryAllowed: () =>
        cockpitEntryAllowed({
          contextMode: this._contextMode,
          contextModeChanging: this._contextModeChanging,
          flightsEnabled: !!this._dataManager?.isEnabled('flights'),
          militaryEnabled: !!this._dataManager?.isEnabled('military'),
        }),
      onEntered: () => this._panelChrome.enterCockpit(),
      onExited: () => this._panelChrome.exitCockpit(),
      restoreTrackingFrame: (entity) => {
        const [layerId, ...idParts] = String(entity?.gevTrackedId || '').split(
          ':',
        );
        const trackedId = idParts.join(':');
        if (!trackedId) return false;
        if (layerId === 'flights')
          return flightsLayer.refocusTrackedById?.(trackedId) === true;
        if (layerId === 'military')
          return militaryFlightsLayer.refocusTrackedById?.(trackedId) === true;
        return false;
      },
    });

    // Full-globe sun/moon ring. It is a crisp screen-space overlay above the
    // Cesium canvas but below the HUD/detection/readout z ladder.
    this.celestialRing = new CelestialRing(viewer, {
      enabled: false,
      onAutoDisable: () =>
        this.setCelestialRingEnabled(false, {
          syncShare: !!this.shareLinkManager,
          focus: false,
        }),
    });

    // Share Link Manager
    this.shareLinkManager = new ShareLinkManager(viewer, {
      onRestore: async (state) => {
        const {
          style,
          bloom,
          sharpen,
          bloomIntensity,
          bloomVersion,
          sharpenIntensity,
          hudVariant,
          hudVisible,
          detectionMode,
          detectionDensity,
          detectionAllocation,
          detectionFadePct,
          detectionOutsideOpacityPct,
          celestialRing,
          scopeEnabled,
          scopeFeatherPct,
          scopeTerminusPct,
          mapStack,
          panelState,
          styleParams,
        } = state || {};
        // Ignore the retired 'ai-edit' style from older share links.
        if (style && style !== 'normal' && style !== 'ai-edit') {
          this.setStyle(style, {
            applyPreset: true,
            revealParameters: false,
            restore: true,
          });
        }
        if (
          styleParams &&
          style &&
          this.stages[style] &&
          STYLES[style]?.uniforms
        ) {
          for (const [uniformName, uniformValue] of Object.entries(
            styleParams,
          )) {
            if (!Object.hasOwn(STYLES[style].uniforms, uniformName)) continue;
            this.stages[style].uniforms[uniformName] = uniformValue;
          }
          this._updateSliderPanel(style, { reveal: false });
        }
        if (typeof bloomIntensity === 'number' && this._bloomSlider) {
          const intensity = decodeBloomIntensity(bloomIntensity, bloomVersion);
          this._setBloomIntensity(intensity, { syncShare: false });
        }
        if (typeof sharpenIntensity === 'number' && this._sharpenSlider) {
          const pct = Math.max(0, Math.min(100, Math.round(sharpenIntensity)));
          this._sharpenSlider.value = String(pct);
          this._sharpenSliderValue.textContent = `${pct}%`;
          this._applySharpenIntensity(pct / 100);
        }
        if (typeof bloom === 'boolean') this._setBloomEnabled(bloom);
        if (typeof sharpen === 'boolean') this._setSharpenEnabled(sharpen);
        if (hudVariant) this._setHudVariant(hudVariant);
        if (typeof hudVisible === 'boolean') {
          this.hud.setMode(hudVisible ? 'on' : 'off');
          this._updateHudButtonState();
        }
        if (
          typeof detectionDensity === 'number' &&
          this._detectionDensitySlider
        ) {
          const pct = canonicalizeDensity(detectionDensity);
          this._detectionDensitySlider.value = String(pct);
          this._detectionDensityValue.textContent = `${pct}%`;
          this._applyDetectionDensityFromUi();
        }
        if (detectionAllocation) {
          this._setDetectionAllocation(detectionAllocation, {
            syncShare: false,
            persist: false,
          });
        }
        if (typeof detectionFadePct === 'number' && this._detectionFadeSlider) {
          this._detectionFadeSlider.value = String(detectionFadePct);
        }
        if (
          typeof detectionOutsideOpacityPct === 'number' &&
          this._detectionOpacitySlider
        ) {
          this._detectionOpacitySlider.value = String(
            detectionOutsideOpacityPct,
          );
        }
        this._applyDetectionFadeFromUi();
        if (detectionMode) this._setDetectionMode(detectionMode);
        if (typeof celestialRing === 'boolean') {
          this.setCelestialRingEnabled(celestialRing, {
            syncShare: false,
            focus: false,
          });
        }
        if (typeof scopeEnabled === 'boolean') {
          setScopeMaskEnabled(scopeEnabled);
          this._scopeBtn?.classList.toggle('active', scopeEnabled);
          this._scopeBtn?.setAttribute('aria-pressed', String(scopeEnabled));
        }
        if (typeof scopeFeatherPct === 'number' && this._scopeFeatherSlider) {
          const pct = Math.max(0, Math.min(100, Math.round(scopeFeatherPct)));
          this._scopeFeatherSlider.value = String(pct);
          if (this._scopeFeatherValue)
            this._scopeFeatherValue.textContent = `${pct}%`;
          setScopeMaskFeather(pct / 100);
        }
        // null restores the altitude-adaptive ramp; a number pins the terminus
        // (clamped to the supported 94..100 band, same as the `sce` hash key).
        if (scopeTerminusPct === null) setScopeTerminusOverride(null);
        else if (typeof scopeTerminusPct === 'number') {
          const pinned = clampScopeTerminusPct(scopeTerminusPct);
          setScopeTerminusOverride(pinned == null ? null : pinned / 100);
        }
        const mapStackRestore = mapStack
          ? this._setMapStack(mapStack, { syncShare: false })
          : Promise.resolve();
        if (panelState) this._restorePanelState(panelState);
        await mapStackRestore;
        this._syncShareState();
      },
      isNavigationCurrent: (generation) =>
        generation === this._navigationGeneration,
      cancelOwnedNavigation: () => this.viewer.camera.cancelFlight(),
    });
    this.shareLinkManager.setPanelStateProvider(() =>
      this._buildSharePanelState(),
    );
    this.shareLinkManager.setStyleParamStateProvider((styleName) => {
      const shader = STYLES[styleName];
      const stage = this.stages[styleName];
      if (!shader?.uniforms || !stage) return null;
      return Object.fromEntries(
        Object.keys(shader.uniforms).map((uniformName) => [
          uniformName,
          stage.uniforms[uniformName],
        ]),
      );
    });
    this._shareState = createStateChannel(() => this._readShareState());
    this._shareState.subscribe(
      ({ state }) => {
        this.shareLinkManager.onToggleChange(
          state.bloomEnabled,
          state.sharpenEnabled,
          state.options,
        );
      },
      { emitCurrent: false },
    );
    this._locationState = createStateChannel(
      () => this._locationLookup?.getState() || null,
    );
    this._locationState.subscribe(
      ({ state, change }) => {
        this._handleLocationSearchState(state, change);
      },
      { emitCurrent: false },
    );
    // Parse before panel chrome initializes so every valid share URL starts
    // from deterministic markup defaults instead of recipient-local panel
    // preferences. Encoded panel fields are applied after all panels exist.
    this._shareRestoration.attachLinks(this.shareLinkManager);

    this._models3dModeBtns = [
      document.getElementById('models3d-mode-proximity'),
      document.getElementById('models3d-mode-all'),
    ];
    // DISPLAY-rail 3D-aircraft toggle (flights layer param). DEFAULT-ON in
    // PROXIMITY (owner directive 2026-08-22) — mirrors the `models3d` default in
    // layerState.js and `_models3dEnabled` in both flight layers, and the `active`
    // class the button carries in index.html. A fresh boot skips layer-state
    // restoration, so these initializers are the only thing keeping the lit
    // button and the armed layer in agreement.
    this._models3dEnabled = true;
    this._models3dMode = 'proximity'; // 'proximity' (nearest in view) | 'all' (every in-view plane)

    // The shared world-overlay host must own its one postRender lane before
    // detection and tracked-readout initialize. It stays transparent until a
    // production source explicitly registers entries.
    initWorldOverlay(viewer);

    // Initialize detection overlay BEFORE style stages so the composite
    // stage is first in the post-process pipeline
    initDetection(
      viewer,
      [
        trafficLayer,
        flightsLayer,
        militaryFlightsLayer,
        satellitesLayer,
        cctvLayer,
        bikeshareLayer,
        transitLayer,
        aisLiveVesselsLayer,
      ],
      (modeLabel) => {
        this._updateDetectionButton(modeLabel);
      },
    );
    initTrackedReadout(viewer);
    setDetectionStyle(this.activeStyle);
    this._applyDetectionDensityFromUi();

    this._initStages();
    this._initBloomSharpen();
    this._initUI();
    this._initMapStackControl();
    this._initPanelChrome();
    this._initLeftPanelAdaptiveLayout();
    this._initRightPanelAdaptiveLayout();
    this._initRadioPanel();
    this._initCctvPanel();
    this._initGlobalContextPanel();
    this._initLocationBar();
    this._initShareButton();
    this._initCameraOrientationControls();
    this._initClearSelectedLayersButton();
    this._initHUDToggle();
    this._initModels3dToggle();
    this._applyGlobalPostDefaults();
    this._initOrbit();
    this._initRecordingOverlay();
    this._startAnimationLoop();
    this._startTrafficChipTicker();
    this._updateStyleMiniStatus();
    this._updateLocationMiniStatus();

    this._shareRestoration.start();

    // Keep the parameter panel from overlapping toggle controls.
    this._layoutRightPanels();
    this._syncCctvPanelViewport();
    this._windowResizeHandler = () => {
      this._scheduleRightPanelLayout({ reconsiderAutoCollapse: true });
      this._syncCctvPanelViewport();
      this._scheduleLeftPanelLayout({ reconsiderAutoCollapse: true });
    };
    window.addEventListener('resize', this._windowResizeHandler);
    // The loading-chip ticker is stopped while the tab is hidden (it can do no
    // useful work off-screen and must not hold a 60ms timer there). Resample on
    // return so the time-driven reducer catches up on real elapsed time — and
    // re-arms its own ticker if the batch is still running.
    this._feedback.observeVisibility();
    this._cctvRequestFocusHandler = (event) =>
      routeCctvFocusRequest(
        event,
        (activate, focus) => this._runExplicitCctvFocus(activate, focus),
        (cameraId, durationSec) => cctvLayer.focusCamera(cameraId, durationSec),
      );
    this._removeCctvRequestFocusListener = registerCctvFocusRequestListener(
      window,
      this._cctvRequestFocusHandler,
    );
    this._worldRequestFocusHandler = (event) =>
      routeWorldFocusRequest(
        event,
        (detail, fly) => this._runExplicitWorldFocus(detail, fly),
        (detail) => flyToWorldTarget(this.viewer, detail),
      );
    this._removeWorldRequestFocusListener = registerWorldFocusRequestListener(
      window,
      this._worldRequestFocusHandler,
    );
    this._navigationOwnerChangedRemover =
      viewer.trackedEntityChanged.addEventListener((entity) => {
        if (entity && !this._disposed)
          this._stampNavigation({
            cancelPendingSelection: false,
          });
      });
    viewer.trackedEntityChanged.addEventListener((entity) => {
      if (entity && !this._disposed) {
        this.audioEngine?.playLock();
        this.trajectoryOverlay?.showTrajectoryForEntity(entity);
      } else if (!this._disposed) {
        this.audioEngine?.playRelease();
        this.trajectoryOverlay?.clear();
      }
    });
    // Vessel/installation focus flies without ever assigning a tracked entity,
    // so it cannot reach the listener above. It announces instead.
    this._removeNavigationAuthorityListener =
      registerNavigationAuthorityListener(window, (event) => {
        if (this._disposed) return;
        this._stampNavigation({
          cancelPendingSelection:
            event?.detail?.cancelPendingSelection !== false,
        });
      });

    // ── Immersive Upgrade Systems ──────────────────────
    this.audioEngine = getTacticalAudio();
    this.cockpitAmbiance = new CockpitAmbiance({ audioEngine: this.audioEngine });

    this.radialMenu = new RadialMenu({
      viewer: this.viewer,
      audioEngine: this.audioEngine,
      onAction: (action, entity) => this._handleRadialAction(action, entity),
    });
    if (this.viewer?.container) {
      this.radialMenu.bind(this.viewer.container);
    }

    this.trajectoryOverlay = new TrajectoryOverlay(this.viewer);
    this.geofenceEngine = new GeofenceEngine({ audioEngine: this.audioEngine });
    this.geofenceRenderer = new GeofenceRenderer(this.viewer);
    this.timelineCache = new TimelineCache();
    this._historicalEntities = null;

    if (typeof document !== 'undefined') {
      this.weatherParticles = new WeatherParticles({
        container: this.viewer?.container || document.body,
      });

      this.audioControls = new AudioControls({
        container: null,
        audioEngine: this.audioEngine,
      });
      this.geofenceControls = new GeofenceControls({
        container: null,
        engine: this.geofenceEngine,
        renderer: this.geofenceRenderer,
        viewer: this.viewer,
      });
      this.timelineScrubber = new TimelineScrubber({
        container: null,
        cache: this.timelineCache,
        audioEngine: this.audioEngine,
        onScrub: (entities, timestamp, isLive) => {
          this._historicalEntities = isLive ? null : entities;
        },
      });
      this.gestureControls = new GestureControls({
        container: null,
        audioEngine: this.audioEngine,
        onAction: (action, payload) => this._handleGestureAction(action, payload),
        onError: (err) => {
          this._showToast(`Hand tracking notice: ${err?.message || 'Webcam unavailable'}`);
        },
        onStatusChange: (enabled) => {
          const gestureBtn = document.getElementById('tactical-gesture-btn');
          gestureBtn?.classList.toggle('active', enabled);
          const fab = document.getElementById('gesture-quick-toggle-fab');
          fab?.classList.toggle('active', enabled);
        },
      });
      this.touchGestures = new TouchGestureController({
        targetEl: this.viewer?.scene?.canvas || (typeof document !== 'undefined' ? document.body : null),
        viewer: this.viewer,
      });
      this.exportControls = new ExportControls({
        container: null,
        audioEngine: this.audioEngine,
        getData: () => this._collectDossierData(),
      });

      this._initTacticalSuiteControls();
    }
  }

  // Compatibility reads for existing controls, scene snapshots and Cockpit.

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

  /** Advance camera authority and settle any older search UI immediately. */
  _stampNavigation({
    cancelPendingSelection = true,
    clearSearchedLocation = true,
  } = {}) {
    return this._navigation._stampNavigation(...arguments);
  }

  /** Settle only the search generation that still owns the shared input UI. */
  _settleLocationSearchUi(generation) {
    return this._navigation._settleLocationSearchUi(...arguments);
  }

  /** Release every follow owner while preserving Contact and vessel selection. */
  _releaseFollowCamera({
    preserveVesselSelection = true,
    preserveCameraFlight = false,
    trackingOrigin = 'tool',
  } = {}) {
    return this._navigation._releaseFollowCamera(...arguments);
  }

  /** Run one immediate destination through the shared ownership policy. */
  _runExplicitNavigation(noun, navigate, releaseOptions = undefined) {
    return this._navigation._runExplicitNavigation(...arguments);
  }

  /** Accept a delayed lookup without releasing its current camera owner. */
  _beginDeferredNavigation(
    noun = 'location',
    { cancelPendingSelection = true } = {},
  ) {
    return this._navigation._beginDeferredNavigation(...arguments);
  }

  /** Final authority check and release immediately before a delayed flight. */
  _reassertNavigationHandoff(generation) {
    return this._navigation._reassertNavigationHandoff(...arguments);
  }

  /** Public lifecycle seam used by voice location navigation. */
  beginDeferredLocationNavigation() {
    return this._beginDeferredNavigation('location');
  }

  /** Public final-authority seam used by voice geocoding. */
  reassertDeferredLocationNavigation(generation) {
    return this._reassertNavigationHandoff(generation);
  }

  /** Public immediate route used by voice destinations. */
  runImmediateLocationNavigation(navigate) {
    return this.runImmediateNavigation('location', navigate);
  }

  /** Public authority facade used by validated voice camera destinations. */
  runImmediateNavigation(noun, navigate, releaseOptions = undefined) {
    return this._runExplicitNavigation(noun, navigate, releaseOptions);
  }

  /**
   * Hand the Directions layer the camera seams its FLY chip needs: the same
   * immediate-navigation facade voice route flights go through, so there is
   * one camera owner rather than a second one inside a data layer, the shared
   * ground-floor read/warm the route dolly flies over, and the app's own toast
   * so the layer can speak where the rest of the UI speaks.
   * @returns {void}
   */
  _connectDirectionsCamera() {
    if (!this._dataManager) {
      // Detaching: the layer outlives this shell, so it must not keep calling
      // a facade whose viewer is going away.
      this._directionsShellModule?.attachShellServices?.(null);
      this._directionsShellModule = null;
      return;
    }
    const directions = this._dataManager.layers?.get('directions')?.module;
    if (typeof directions?.attachShellServices !== 'function') return;
    this._directionsShellModule = directions;
    directions.attachShellServices({
      runNavigation: (navigate) =>
        this.runImmediateNavigation('route', navigate),
      floorFn: (lat, lon) => this.services.cachedGroundFloor(lat, lon),
      warmFn: (cells) => this.services.warmGroundFloor(cells),
      showToast: (message) => this._showToast(message),
    });
  }

  /** Supersede deferred work when an owner-specific route handles release. */
  supersedeDeferredNavigation() {
    return this._stampNavigation();
  }

  /** Route a valid vessel/fire request through the shared navigation policy. */
  _runExplicitWorldFocus(detail, fly) {
    return this._runExplicitNavigation(detail?.kind || 'target', fly);
  }

  /** Return the aircraft tracker owned before a multi-step Cockpit transaction. */
  getAircraftTrackingTarget() {
    return aircraftTrackingTarget(this.cockpitView?.readAircraftInfo?.());
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

  /** Apply a temporary cockpit-only CRT/NVG/FLIR/NOIR post-process override. */
  _setCockpitVision(mode, active, { revealParameters = false } = {}) {
    return this._visualSettings._setCockpitVision(...arguments);
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

  /** Reveal shared style parameters, optionally opening Cockpit Display first. */
  _revealCockpitStyleParameters({ openDisplay = false } = {}) {
    return this._visualSettings._revealCockpitStyleParameters(...arguments);
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
   * Sets the bloom intensity, updates the slider UI, and applies the value.
   * @param {number} intensity - Raw intensity percentage.
   * @param {object} [options]
   * @param {boolean} [options.syncShare=true] - Whether to push state to the share link.
   * @returns {void}
   */
  _setBloomIntensity(intensity, { syncShare = true } = {}) {
    return this._visualSettings._setBloomIntensity(...arguments);
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
   * Wires up all primary UI event listeners: style buttons, keyboard shortcuts
   * (1-8 style keys, H/O/V/F/D/C hotkeys, Escape), AI prompt input with
   * debounce, bloom/sharpen/HUD toggles, detection density slider, and
   * clean-view toggle.
   * @returns {void}
   */
  _initUI() {
    const {
      cycleDetectionMode,
      setScopeMaskEnabled,
      isScopeMaskEnabled,
      setScopeMaskFeather,
    } = this.services;
    this._applicationShortcuts?.destroy();
    this._frameRateMonitor?.destroy();
    this._frameRateMonitor = createFrameRateMonitor({
      viewer: this.viewer,
      documentRef: document,
    });
    this._applicationShortcuts = bindApplicationShortcuts({
      documentRef: document,
      searchInput: this._locationSearch,
      actions: {
        setStyle: (style) => this.setStyle(style),
        dismissSearch: () => {
          if (this._locationSearch.classList.contains('expanded')) {
            this._locationSearch.classList.remove('expanded');
            this._locationSearch.value = '';
            this._locationSearch.blur();
          }
        },
        toggleHud: () => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          this.hud.toggle();
          this._updateHudButtonState();
          this._syncShareState();
        },
        toggleOrbit: () => this._toggleOrbit(),
        toggleCleanView: () => this.toggleCleanView(),
        toggleLayers: () =>
          document.getElementById('data-panel').classList.toggle('active'),
        cycleDetection: () => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          this._detectionUserOverridden = true;
          cycleDetectionMode();
          this._syncShareState();
        },
        toggleCctv: () => this._toggleCctvEnabled(),
      },
    });

    this._displayControls?.destroy();
    this._displayControls = bindDisplayControls({
      elements: {
        styleButtons: document.querySelectorAll('.style-btn'),
        bloomButton: this._bloomBtn,
        bloomSlider: this._bloomSlider,
        sharpenButton: this._sharpenBtn,
        sharpenSlider: this._sharpenSlider,
        scopeButton: this._scopeBtn,
        scopeFeatherSlider: this._scopeFeatherSlider,
        hudLayout: this._hudLayoutSelect,
        hudButton: this._hudBtn,
        cleanViewButton: this._cleanViewBtn,
        cleanViewExitButton: this._cleanViewExitBtn,
        densitySlider: this._detectionDensitySlider,
        detectionButton: this._detectionBtn,
        allocationButtons: this._detectionAllocationBtns,
        fadeSliders: [this._detectionFadeSlider, this._detectionOpacitySlider],
        celestialButton: this._celestialBtn,
        modelsButton: this._models3dBtn,
        modelModeButtons: this._models3dBtn ? this._models3dModeBtns : [],
      },
      actions: {
        setStyle: (style) => this.setStyle(style),
        toggleBloom: () => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          this._setBloomEnabled(!this.bloomEnabled);
        },
        setBloomIntensity: (value) => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          this._setBloomIntensity(value);
        },
        toggleSharpen: () => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          this._setSharpenEnabled(!this.sharpenEnabled);
        },
        toggleScope: () => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          const next = !isScopeMaskEnabled();
          setScopeMaskEnabled(next);
          this._scopeBtn.classList.toggle('active', next);
          this._scopeBtn.setAttribute('aria-pressed', String(next));
          this._syncShareState();
        },
        setScopeFeather: (value) => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          const pct = Math.max(0, Math.min(100, value || 0));
          if (this._scopeFeatherValue)
            this._scopeFeatherValue.textContent = `${pct}%`;
          setScopeMaskFeather(pct / 100);
          this._syncShareState();
        },
        setSharpenIntensity: (pct) => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          if (this._sharpenSliderValue)
            this._sharpenSliderValue.textContent = `${pct}%`;
          this._applySharpenIntensity(pct / 100);
          this._syncShareState();
        },
        setHudLayout: (value) => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          this._setHudVariant(value);
        },
        toggleCleanView: () => this.toggleCleanView(),
        exitCleanView: () => this.toggleCleanView(false),
        setDensity: (value) => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          this._detectionUserOverridden = true;
          const pct = canonicalizeDensity(value);
          this._detectionDensitySlider.value = String(pct);
          if (this._detectionDensityValue)
            this._detectionDensityValue.textContent = `${pct}%`;
          this._applyDetectionDensityFromUi();
          this._syncShareState();
        },
        setAllocation: (value) => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          this._detectionUserOverridden = true;
          this._setDetectionAllocation(value);
        },
        setFade: () => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          this._applyDetectionFadeFromUi();
          this._syncShareState();
        },
        toggleCelestial: () => {
          const ringIsVisible = !!this.celestialRing?.visible;
          if (!this.celestialRingEnabled || !ringIsVisible) {
            this.setCelestialRingEnabled(true, { focus: true });
          } else {
            this.setCelestialRingEnabled(false);
          }
        },
        toggleHud: () => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          this.hud.toggle();
          this._updateHudButtonState();
          this._syncShareState();
        },
        cycleDetection: () => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          this._detectionUserOverridden = true;
          cycleDetectionMode();
          this._syncShareState();
        },
        toggleModels: () => {
          this._setModels3dEnabled(!this._models3dEnabled);
          this._syncModels3dModeRow();
        },
        setModelsMode: (mode) => this._setModels3dMode(mode),
      },
    });
  }

  /**
   * Renders the owner-approved map stack chip row from the matching controller
   * entries. Cesium ion/Bing chips remain keyboard-focusable but unavailable,
   * with an accessible explanation, until a CESIUM_ION_TOKEN is configured.
   * @returns {void}
   */
  _initMapStackControl() {
    if (!this.mapStackController) return;
    this._mapSourceControls?.destroy();
    this._mapSourceControls = createMapSourceControls({
      container: this._mapStackChips,
      statusElement: this._mapStackStatus,
      controller: this.mapStackController,
      subscribe: (onChange) => {
        window.addEventListener('gev:map-stack-changed', onChange);
        return () =>
          window.removeEventListener('gev:map-stack-changed', onChange);
      },
      claimSelection: () => this.shareLinkManager?.claimRestoreLane?.('map'),
      onStateChanged: () => this._syncShareState(),
      onError: (message) => this._showToast(message),
    });
  }

  /**
   * Switches the active map/globe source stack.
   * @param {string} stackId - Map stack id.
   * @param {object} [options]
   * @param {boolean} [options.syncShare=true] - Whether to update the share link.
   * @returns {Promise<void>}
   */
  async _setMapStack(stackId, { syncShare = true } = {}) {
    if (!this.mapStackController) return;
    return this._mapSourceControls.select(stackId, { syncShare });
  }

  /**
   * Syncs the map stack chip row and status chip with controller state. The
   * lit chip always follows `state.activeId`, never the click — a rejected or
   * superseded switch therefore leaves the genuinely active stack lit.
   * @param {object} state - Map stack controller state.
   * @returns {void}
   */
  _renderMapStackState(state) {
    this._mapSourceControls?.render(state);
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

  _setDetectionAllocation(strategy, { syncShare = true, persist = true } = {}) {
    return this._visualSettings._setDetectionAllocation(...arguments);
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
   * Pushes the current visual state (bloom, sharpen, HUD, detection) to
   * the ShareLinkManager so the URL hash stays in sync.
   * @returns {void}
   */
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

  _syncShareState() {
    if (this._disposed) return;
    this._shareState.publish({ type: 'settings-changed' });
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

  _setCommandDockPanelPinState(
    panelId,
    pin,
    { restore = false, persist = true, syncShare = true } = {},
  ) {
    return this._panelChrome._setCommandDockPanelPinState(...arguments);
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
   * Configures intentional hover-expand / leave-collapse behavior on a panel.
   * Uses separate open/close timers to prevent accidental flicker from fast
   * mouse passes. Wheel events cancel pending opens to avoid surprise expansion
   * during scroll-through.
   * @param {string} panelId - DOM id of the panel element.
   * @param {object} [options]
   * @param {number} [options.openDelayMs=850] - Hover dwell time before auto-expanding.
   * @param {number} [options.closeDelayMs=1000] - Delay after pointer leaves before collapsing.
   * @returns {void}
   */
  _initAutoHoverPanel(
    panelId,
    { openDelayMs = 850, closeDelayMs = 1000 } = {},
  ) {
    return this._panelChrome._initAutoHoverPanel(...arguments);
  }

  /**
   * Sets up drag-to-reposition for legacy floating controls. The right rail
   * and left accordion remain fixed so their HUD alignment is deterministic.
   * @returns {void}
   */
  _initPanelDrag() {
    return this._panelPosition._initPanelDrag();
  }

  _persistAwarenessSelection(event, cleared = false) {
    if (!this._dataManager) return;
    const origin = String(event?.detail?.origin || 'programmatic');
    if (!isExplicitLayerStateOrigin(origin)) return;
    const layerId = String(event?.detail?.layerId || '');
    const config = {
      flights: {
        key: 'selectedFlightsTrackingId',
        normalize: (value) =>
          String(value ?? '')
            .trim()
            .toLowerCase() || null,
      },
      military: {
        key: 'selectedMilitaryTrackingId',
        normalize: (value) =>
          String(value ?? '')
            .trim()
            .toLowerCase() || null,
      },
      satellites: {
        key: 'selectedSatTrackingId',
        normalize: (value) => {
          const candidate = Number(value);
          return Number.isFinite(candidate) && candidate > 0
            ? Math.trunc(candidate)
            : null;
        },
      },
    }[layerId];
    if (!config) return;
    const selectedValue = cleared ? null : config.normalize(event?.detail?.id);
    if (cleared || selectedValue === null) {
      this._dataManager.adoptLayerParams?.(
        layerId,
        {
          [config.key]: selectedValue,
        },
        { origin },
      );
      return;
    }
    // A direct selection promotes a Context-owned tracker dependency into
    // durable visibility before its selected ID is normalized. Context exit
    // also keeps this adopted layer instead of tearing down the user's track.
    const visibilityAdopted = this._dataManager.adoptLayerVisibility?.(
      layerId,
      true,
      { origin, adoptedFromSelection: true },
    );
    if (visibilityAdopted === false) return;
    // Clear the prior family before publishing the replacement. Otherwise the
    // coordinator briefly sees two IDs and correctly treats them as an
    // ambiguous incoming state, which would discard the new durable target.
    for (const [otherLayerId, otherKey] of [
      ['flights', 'selectedFlightsTrackingId'],
      ['military', 'selectedMilitaryTrackingId'],
      ['satellites', 'selectedSatTrackingId'],
    ]) {
      if (otherLayerId === layerId) continue;
      this._dataManager.setLayerParams(
        otherLayerId,
        { [otherKey]: null },
        { origin },
      );
    }
    this._dataManager.adoptLayerParams?.(
      layerId,
      {
        [config.key]: selectedValue,
      },
      { origin },
    );
  }

  /**
   * Connects the layer data manager for traffic sync, CCTV state subscription,
   * and layer enable/disable operations.
   * @param {object|null} dataManager - The DataManager instance, or null to detach.
   * @returns {void}
   */
  attachDataManager(dataManager) {
    this._dataManager = dataManager || null;
    this.hud.attachDataManager(this._dataManager);
    this._updateTrafficSyncChip();
    if (this._dataManagerUnsubscribe) {
      this._dataManagerUnsubscribe();
      this._dataManagerUnsubscribe = null;
    }
    this._contextControls.connect(this._dataManager);
    if (typeof this._dataManager?.subscribe === 'function') {
      this._dataManagerUnsubscribe = this._dataManager.subscribe((change) => {
        this._feedback._loadingFeedbackEvent = change;
        this._updateGlobalLoadingFeedback(performance.now());
      });
    }
    this._updateGlobalLoadingFeedback(performance.now());
    this._syncContextModeButtons();
    this._cctvControls.connect();
    this._radioControls.connect();
    this._connectDirectionsCamera();
    if (!this._awarenessSelectedHandler) {
      this._awarenessSelectedHandler = (event) =>
        this._persistAwarenessSelection(event, false);
      this._awarenessClearedHandler = (event) =>
        this._persistAwarenessSelection(event, true);
      window.addEventListener(
        'gev:awareness-subject-selected',
        this._awarenessSelectedHandler,
      );
      window.addEventListener(
        'gev:awareness-subject-cleared',
        this._awarenessClearedHandler,
      );
    }
    this._shareRestoration.connect(this._dataManager);
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

  _initGlobalContextPanel() {
    const { radioLayer, militaryInstallationsLayer } = this.services;
    this._contextControls = new ContextControls({
      elements: {
        _globalContextPanel: document.getElementById('global-context-panel'),
        _globalContextFlightsBtn: this._globalContextFlightsBtn,
        _globalContextMissionsBtn: this._globalContextMissionsBtn,
        _contextModeStandby: this._contextModeStandby,
        _contextFlightsView: this._contextFlightsView,
        _contextMissionsView: this._contextMissionsView,
        _installationsSearchBtn: this._installationsSearchBtn,
      },
      installations: militaryInstallationsLayer,
      actions: {
        getCockpit: () => this.cockpitView,
        refreshRadio: () => this._renderRadioState(radioLayer.getUIState()),
        claimVisualAuthority: () =>
          this.shareLinkManager?.claimRestoreLane?.('visual'),
        syncDetection: () => this._syncContactsDetection(),
        scheduleLayout: () => this._scheduleRightPanelLayout(),
        setPanelCollapsed: (...args) => this.setPanelCollapsed(...args),
        showToast: (message) => {
          if (!this._disposed) this._showToast(message);
        },
        setClearBusy: (busy) => {
          if (!this._disposed) this._clearLayersControl?.setBusy(busy);
        },
      },
    });
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

  /** Wire the independent Radio companion controls. */
  _initRadioPanel() {
    const { radioLayer } = this.services;
    this._radioControls?.destroy();
    this._radioControls = new RadioControls({
      elements: {
        _cockpitDisplayPanel: this._cockpitDisplayPanel,
        _cockpitDisplayToggleBtn: this._cockpitDisplayToggleBtn,
        _cockpitRadioEnableBtn: this._cockpitRadioEnableBtn,
        _cockpitRadioNextBtn: this._cockpitRadioNextBtn,
        _cockpitRadioPanel: this._cockpitRadioPanel,
        _cockpitRadioPlayBtn: this._cockpitRadioPlayBtn,
        _cockpitRadioPrevBtn: this._cockpitRadioPrevBtn,
        _cockpitRadioStation: this._cockpitRadioStation,
        _cockpitRadioToggleBtn: this._cockpitRadioToggleBtn,
        _cockpitRadioVolume: this._cockpitRadioVolume,
        _cockpitRadioVolumeValue: this._cockpitRadioVolumeValue,
        _cockpitUtilityControls: this._cockpitUtilityControls,
        _contextRadioDetailsBtn: this._contextRadioDetailsBtn,
        _contextRadioDock: this._contextRadioDock,
        _contextRadioMini: this._contextRadioMini,
        _contextRadioMiniCloseBtn: this._contextRadioMiniCloseBtn,
        _contextRadioMiniEnableBtn: this._contextRadioMiniEnableBtn,
        _contextRadioMiniNextBtn: this._contextRadioMiniNextBtn,
        _contextRadioMiniPlayBtn: this._contextRadioMiniPlayBtn,
        _contextRadioMiniPrevBtn: this._contextRadioMiniPrevBtn,
        _contextRadioMiniStation: this._contextRadioMiniStation,
        _contextRadioMiniVolume: this._contextRadioMiniVolume,
        _contextRadioMiniVolumeValue: this._contextRadioMiniVolumeValue,
        _contextRadioToggleBtn: this._contextRadioToggleBtn,
        _radioEnableBtn: this._radioEnableBtn,
        _radioFilter: this._radioFilter,
        _radioLayerState: this._radioLayerState,
        _radioNextBtn: this._radioNextBtn,
        _radioPanel: this._radioPanel,
        _radioPlayBtn: this._radioPlayBtn,
        _radioPlaybackState: this._radioPlaybackState,
        _radioPrevBtn: this._radioPrevBtn,
        _radioStationHomepage: this._radioStationHomepage,
        _radioStationMeta: this._radioStationMeta,
        _radioStationName: this._radioStationName,
        _radioStationTags: this._radioStationTags,
        _radioStopBtn: this._radioStopBtn,
        _radioTuner: this._radioTuner,
        _radioTunerBandLabel: this._radioTunerBandLabel,
        _radioTunerNeedle: this._radioTunerNeedle,
        _radioTunerSlider: this._radioTunerSlider,
        _radioTunerStation: this._radioTunerStation,
        _radioTunerValue: this._radioTunerValue,
        _radioVolume: this._radioVolume,
        _radioVolumeValue: this._radioVolumeValue,
      },
      radio: radioLayer,
      canvas: this.viewer?.canvas,
      actions: {
        isRegistered: () => this._dataManager?.layers?.has('radio'),
        isEnabled: () => this._dataManager?.isEnabled('radio'),
        setEnabled: (enabled, options) =>
          this._dataManager.setEnabled('radio', enabled, options),
        setParams: (params, options) =>
          this._dataManager?.setLayerParams('radio', params, options),
        getLifecycle: () =>
          this._dataManager?.getLayerLifecycleState?.('radio'),
        runUserAction: (...args) => this._runUserFacingContextAction(...args),
        setPanelCollapsed: (...args) => this.setPanelCollapsed(...args),
        revealStyleParameters: () => this._revealCockpitStyleParameters(),
        setSignalCollapsed: (value) =>
          this.cockpitView?.setSignalCollapsed(value),
        isCockpitActive: () => this.cockpitView?.active,
        signalUserCollapsed: () => this.cockpitView?.signalUserCollapsed,
        layoutCockpit: () => this.cockpitView?.scheduleContextLayout(),
        preservePanelStateDuringClear: () =>
          this._preservePanelStateDuringLayerClear,
        scheduleLayout: () => this._scheduleRightPanelLayout(),
      },
    });
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
   * Activates an explicit CCTV target, then releases tracking before its camera
   * flight. Cockpit mode keeps tracking and suppresses only the flight.
   * @param {Function} activate CCTV target activation returning its camera ID.
   * @param {Function} focus CCTV camera flight receiving the activated ID.
   * @returns {*} Focus operation result.
   */
  _runExplicitCctvFocus(activate, focus) {
    if (this._disposed) return false;
    const cameraId = activate();
    if (!cameraId) return false;
    return this._runExplicitNavigation('camera', () => focus(cameraId));
  }

  /** Compose camera panel controls from the existing camera port and application actions. */
  _initCctvPanel() {
    const { cctvLayer } = this.services;
    this._cctvControls?.destroy();
    this._cctvControls = new CctvControls({
      elements: {
        _cctvAdjustBtn: this._cctvAdjustBtn,
        _cctvAutoHopBtn: this._cctvAutoHopBtn,
        _cctvCalReadout: this._cctvCalReadout,
        _cctvCalibResetBtn: this._cctvCalibResetBtn,
        _cctvCalibSaveBtn: this._cctvCalibSaveBtn,
        _cctvCoverageBtn: this._cctvCoverageBtn,
        _cctvEnableBtn: this._cctvEnableBtn,
        _cctvFocusBtn: this._cctvFocusBtn,
        _cctvFrame: this._cctvFrame,
        _cctvFrameWrap: this._cctvFrameWrap,
        _cctvMeta: this._cctvMeta,
        _cctvNearestBtn: this._cctvNearestBtn,
        _cctvNextBtn: this._cctvNextBtn,
        _cctvPanel: this._cctvPanel,
        _cctvPrevBtn: this._cctvPrevBtn,
        _cctvProjectionBtn: this._cctvProjectionBtn,
        _cctvQualityChip: this._cctvQualityChip,
        _cctvSelect: this._cctvSelect,
        _cctvSourceBadge: this._cctvSourceBadge,
        _cctvSummary: this._cctvSummary,
        _cctvSyncChip: this._cctvSyncChip,
        _cctvSyncLabel: this._cctvSyncLabel,
        _cctvSyncProgress: this._cctvSyncProgress,
      },
      cctv: cctvLayer,
      actions: {
        isEnabled: () => this._dataManager?.isEnabled('cctv'),
        setParams: (params, options) =>
          this._dataManager?.setLayerParams('cctv', params, options),
        toggleEnabled: (...args) => this._toggleCctvEnabled(...args),
        runExplicitFocus: (...args) => this._runExplicitCctvFocus(...args),
        setPanelCollapsed: (...args) => this.setPanelCollapsed(...args),
        showToast: (message) => this._showToast(message),
        syncViewport: () => this._syncCctvPanelViewport(),
        setSplitFlapText,
      },
    });
  }

  /**
   * Toggles the CCTV layer enabled state. When enabling and no camera is active,
   * auto-focuses on the nearest camera.
   * @param {boolean} [forceState] - Explicit on/off. Omit to toggle.
   * @returns {Promise<boolean>} True if the layer is now in the requested state.
   */
  async _toggleCctvEnabled(forceState) {
    const { cctvLayer } = this.services;
    if (this._disposed) return false;
    if (!this._dataManager || !this._dataManager.layers?.has('cctv')) {
      this._showToast('CCTV layer unavailable');
      return false;
    }
    const enabled = this._dataManager.isEnabled('cctv');
    const target = typeof forceState === 'boolean' ? forceState : !enabled;
    if (target === enabled) return true;
    await runCctvLayerEnableTransition({
      target,
      setEnabled: (next) =>
        this._dataManager.setEnabled('cctv', next, { origin: 'user' }),
      readOwnership: () => ({
        trackedEntity: this.viewer?.trackedEntity,
        cockpitActive: !!this.cockpitView?.active,
      }),
      shouldFocus: () =>
        !this._disposed &&
        this._dataManager.isEnabled('cctv') &&
        !this._cctvControls?.getState()?.activeCameraId,
      activate: () => cctvLayer.focusNearest({ focus: false }),
      fly: (cameraId) =>
        this._runExplicitCctvFocus(
          () => cameraId,
          (selectedId) => cctvLayer.focusCamera(selectedId, 1.6),
        ),
    });
    return true;
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
   * Makes a panel draggable via its handle element. Implements:
   * - Z-order promotion: each pointerdown increments the global z-counter
   *   so the clicked panel floats above siblings.
   * - Viewport clamping: drag moves are clamped to a 6px inset from all edges.
   * - Right-rail pinning: pp-toggles panel is re-anchored right after drag.
   * - CCTV viewport sync: cctv-panel recalculates scroll height after drag.
   * @param {string} panelId - DOM id of the panel.
   * @param {HTMLElement} panelEl - The panel DOM element.
   * @param {HTMLElement} handleEl - The drag handle element within the panel.
   * @returns {void}
   */
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
   * Programmatically collapses or expands a panel, persists the state,
   * and triggers layout recalculation for dependent panels.
   * @param {string} panelId - DOM id of the panel.
   * @param {boolean} collapsed - Whether to collapse the panel.
   * @param {object} [options] Disclosure ownership options.
   * @param {boolean} [options.explicit=false] Whether a direct user action owns the panel lane.
   * @returns {void}
   */
  setPanelCollapsed(
    panelId,
    collapsed,
    {
      explicit = false,
      restore = false,
      persist = true,
      syncShare = true,
    } = {},
  ) {
    return this._panelChrome.setPanelCollapsed(...arguments);
  }

  /**
   * Toggles "clean view" mode which hides all UI panels via a CSS body class.
   * @param {boolean} [forceEnabled] - Explicit on/off. Omit to toggle.
   * @returns {void}
   */
  toggleCleanView(forceEnabled) {
    const shouldEnable =
      typeof forceEnabled === 'boolean'
        ? forceEnabled
        : !document.body.classList.contains('ui-clean-view');
    document.body.classList.toggle('ui-clean-view', shouldEnable);
    if (this._cleanViewBtn) {
      this._cleanViewBtn.classList.toggle('active', shouldEnable);
    }
    this._scheduleLeftPanelLayout();
  }

  // ── Public control facade ──────────────────────────────────────────────
  // Deliberate API for voice tools and scripting. Every setter keeps the DOM
  // sliders, share-link state, and scene snapshots in sync, and returns
  // { ok, ...resultingState } so callers confirm only what actually happened.

  /**
   * Sets HUD visibility mode. 'auto' restores style-driven show/hide.
   * @param {'on'|'off'|'auto'} mode - Visibility mode.
   * @returns {{ok: boolean, visible?: boolean, layout?: string, error?: string}}
   */
  setHudVisible(mode) {
    const normalized = String(mode ?? '').toLowerCase();
    if (!['on', 'off', 'auto'].includes(normalized)) {
      return { ok: false, error: `Unknown HUD visibility mode: ${mode}` };
    }
    this.shareLinkManager?.claimRestoreLane?.('visual');
    this.hud.setMode(normalized);
    this._updateHudButtonState();
    this._syncShareState();
    return {
      ok: true,
      visible: !!this.hud.visible,
      mode: normalized,
      layout: this.hud.getVariant(),
    };
  }

  /**
   * Switches the HUD layout variant.
   * @param {'tactical'|'operator'|'minimal'} variantName - Layout variant.
   * @returns {{ok: boolean, layout?: string, visible?: boolean, error?: string}}
   */
  setHudLayout(variantName) {
    const variant = String(variantName ?? '').toLowerCase();
    if (!['tactical', 'operator', 'minimal'].includes(variant)) {
      return { ok: false, error: `Unknown HUD layout: ${variantName}` };
    }
    this.shareLinkManager?.claimRestoreLane?.('visual');
    this._setHudVariant(variant);
    return {
      ok: true,
      layout: this.hud.getVariant(),
      visible: !!this.hud.visible,
    };
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

  /**
   * Controls the detection overlay: on/off, mode, and density percent.
   * Density writes the slider AND the engine so share links and scene
   * snapshots stay truthful.
   * @param {object} [options]
   * @param {boolean} [options.enabled] - false forces OFF; true restores the current density profile.
   * @param {'sparse'|'balanced'|'dense'|'panoptic'} [options.mode] - Profile (legacy aliases accepted).
   * @param {number} [options.densityPct] - 0-100 density percent.
   * @param {'elastic'|'weighted'} [options.allocationStrategy] - Layer-capacity policy.
   * @param {number} [options.fadePct] - Fade distance as 0-40% of the keyhole radius.
   * @param {number} [options.outsideOpacityPct] - Opacity beyond the fade distance, 0-100%.
   * @returns {{ok: boolean, detectionMode?: string, densityPct?: number|null, error?: string}}
   */
  setDetection({
    enabled,
    mode,
    densityPct,
    allocationStrategy,
    fadePct,
    outsideOpacityPct,
  } = {}) {
    return this._visualSettings.setDetection(...arguments);
  }

  /**
   * Switches the basemap stack and reports whether the switch landed.
   * @param {string} stackId - One of mapStackController.getStacks() ids.
   * @returns {Promise<{ok: boolean, activeStack?: string, error?: string|null, available?: string[]}>}
   */
  async setMapStack(stackId) {
    if (!this.mapStackController) {
      return { ok: false, error: 'Map stack controller unavailable' };
    }
    const stacks = this.mapStackController.getStacks();
    const target = stacks.find((stack) => stack.id === stackId);
    if (!target) {
      return {
        ok: false,
        error: `Unknown map stack: ${stackId}`,
        available: stacks.map((s) => s.id),
      };
    }
    if (!target.available) {
      return {
        ok: false,
        error: `${target.label} requires a Cesium ion token`,
        activeStack: this.mapStackController.getActiveId(),
      };
    }
    await this._setMapStack(stackId);
    const state = this.mapStackController.getState();
    const landed = state.activeId === stackId;
    return {
      ok: landed,
      activeStack: state.activeId,
      error: landed ? null : state.lastError || 'Map stack did not switch',
    };
  }

  /**
   * Controls bloom post-processing. Intensity is the UI percent (0-200).
   * @param {object} [options]
   * @param {boolean} [options.enabled]
   * @param {number} [options.intensityPct] - 0-200.
   * @returns {{ok: boolean, bloom: {enabled: boolean, intensityPct: number|null}}}
   */
  setBloom({ enabled, intensityPct } = {}) {
    return this._visualSettings.setBloom(...arguments);
  }

  /**
   * Controls sharpen post-processing. Intensity is the UI percent (0-100).
   * @param {object} [options]
   * @param {boolean} [options.enabled]
   * @param {number} [options.intensityPct] - 0-100.
   * @returns {{ok: boolean, sharpen: {enabled: boolean, intensityPct: number|null}}}
   */
  setSharpen({ enabled, intensityPct } = {}) {
    return this._visualSettings.setSharpen(...arguments);
  }

  /** Whether the full-globe celestial overlay is enabled by user preference. */
  get celestialRingEnabled() {
    return this._visualSettings.celestialRingEnabled;
  }

  /**
   * Controls the celestial ring. The Display button uses `focus=true` when the
   * ring is disabled or unavailable at the current zoom, turning the control
   * into a reveal action instead of requiring a separate globe-navigation step.
   * @param {boolean} enabled
   * @param {object} [options]
   * @param {boolean} [options.syncShare=true]
   * @param {boolean} [options.focus=false]
   * @returns {{ok:boolean, celestialRing:{enabled:boolean,visible:boolean}, cameraFocused:boolean, error?:string}}
   */
  setCelestialRingEnabled(enabled, { syncShare = true, focus = false } = {}) {
    return this._visualSettings.setCelestialRingEnabled(...arguments);
  }

  /**
   * Starts or stops orbiting the active POI.
   * @param {boolean} [enabled] - Omit to toggle.
   * @returns {{ok: boolean, orbiting: boolean, error?: string}}
   */
  setOrbit(enabled) {
    const active = !!this.orbitController?.active;
    if (typeof enabled === 'boolean' && enabled === active) {
      return { ok: true, orbiting: active };
    }
    if (enabled === false) {
      this._stopOrbit();
      return { ok: true, orbiting: false };
    }
    if (!this._currentTarget) {
      return {
        ok: false,
        orbiting: false,
        error: 'No active landmark to orbit — fly to a landmark first',
      };
    }
    this._toggleOrbit();
    return { ok: true, orbiting: !!this.orbitController?.active };
  }

  /**
   * Enables/disables clean view (hides all UI chrome).
   * @param {boolean} [enabled] - Omit to toggle.
   * @returns {{ok: boolean, cleanView: boolean}}
   */
  setCleanView(enabled) {
    this.toggleCleanView(enabled);
    return {
      ok: true,
      cleanView: document.body.classList.contains('ui-clean-view'),
    };
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
  getCockpitState() {
    const { militaryAwarenessLayer } = this.services;
    const snapshot = militaryAwarenessLayer.getContextSnapshot?.();
    const info = this.cockpitView?.readAircraftInfo?.();
    const active = Boolean(this.cockpitView?.active);
    const gateOpen = Boolean(this.cockpitView?.isEntryAllowed?.());
    // "Could Cockpit be ENTERED right now" — so it is false while already
    // inside, unconditionally. Cockpit takes the entity off
    // `viewer.trackedEntity` on entry and NEXT puts one back, which made this
    // flip true/false between calls while `active` stayed true; readers
    // (including the voice model) read that as a broken half-entered state.
    const entryAllowed =
      !active &&
      Boolean(gateOpen && info && this.viewer?.trackedEntity?.position);
    return {
      active,
      entryAllowed,
      // Why entry is unavailable, so a refusal can be explained rather than
      // guessed at.
      entryBlockedReason:
        entryAllowed || active
          ? null
          : !gateOpen
            ? this._contextModeChanging
              ? 'contacts-starting'
              : 'contacts-inactive'
            : 'no-tracked-aircraft',
      visionMode: this.cockpitView?.visionMode || null,
      subject: info
        ? {
            id: info.icao24 || info.id || null,
            layerId: info.layerId || null,
            callsign: info.callsign || null,
          }
        : null,
      navigation: snapshot
        ? {
            canPrevious: Boolean(snapshot.navigation?.canPrevious),
            canNext: Boolean(snapshot.navigation?.canNext),
            canFocus: Boolean(snapshot.navigation?.canFocus),
          }
        : null,
      awareness: snapshot
        ? {
            radiusM: Number.isFinite(snapshot.radiusM)
              ? snapshot.radiusM
              : null,
            subject: snapshot.subject
              ? {
                  id: snapshot.subject.id || null,
                  layerId: snapshot.subject.layerId || null,
                }
              : null,
            cohorts: Array.isArray(snapshot.cohorts)
              ? snapshot.cohorts.map((cohort) => ({
                  id: cohort?.id || null,
                  source: cohort?.source || null,
                  count: Number.isFinite(cohort?.count) ? cohort.count : null,
                  relationship: cohort?.relationship || null,
                  reason: cohort?.reason || null,
                  coverage: cohort?.coverage || null,
                }))
              : [],
            navigation: snapshot.navigation
              ? {
                  canPrevious: Boolean(snapshot.navigation.canPrevious),
                  canNext: Boolean(snapshot.navigation.canNext),
                  canFocus: Boolean(snapshot.navigation.canFocus),
                }
              : null,
          }
        : null,
      activeTracked: this.cockpitView?.active
        ? Boolean(this.cockpitView?.trackedEntity)
        : false,
      activeMapView: !this.cockpitView?.active && entryAllowed,
    };
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
  _retargetCockpitEntryLayer({
    targetLayer,
    aircraftClass,
    currentTarget,
    selectedTarget,
  }) {
    const { militaryAwarenessLayer } = this.services;
    if (!['flights', 'military'].includes(targetLayer)) {
      return {
        ok: false,
        error: `Cockpit flies aircraft only — ${targetLayer} contacts cannot be entered`,
      };
    }
    const activeLayer =
      selectedTarget?.layerId || currentTarget?.layerId || null;
    const alreadyOnLayer = activeLayer === targetLayer;
    if (alreadyOnLayer && !aircraftClass)
      return { ok: true, retargeted: false };
    const moved = militaryAwarenessLayer?.navigateNext
      ? !!militaryAwarenessLayer.navigateNext({
          targetLayer,
          aircraftClass,
          origin: 'voice',
        })
      : false;
    if (moved) return { ok: true, retargeted: true };
    // A filter that matched nothing still enters, as long as the layer is
    // already right — the operator asked for that layer and is on it.
    if (alreadyOnLayer) return { ok: true, retargeted: false };
    const label = targetLayer === 'military' ? 'military' : 'civilian';
    const filtered = aircraftClass ? `${aircraftClass} ` : '';
    return {
      ok: false,
      error: `No ${filtered}${label} contact is available to enter — track one first, or say "next ${label}"`,
    };
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
  controlCockpit(
    action,
    {
      notificationToken = null,
      targetLayer = null,
      aircraftClass = null,
      selectedTarget = null,
      rollbackTarget = undefined,
    } = {},
  ) {
    const { flightsLayer, militaryFlightsLayer } = this.services;
    const normalized = String(action || '').toLowerCase();
    if (!this.cockpitView) {
      return {
        ok: false,
        action: 'control_cockpit',
        error: 'Cockpit controller unavailable',
        state: this.getCockpitState(),
      };
    }
    if (normalized === 'status') {
      return {
        ok: true,
        action: 'control_cockpit',
        state: this.getCockpitState(),
        notificationToken: notificationToken || null,
      };
    }
    if (normalized === 'enter') {
      // Entry is gated exactly as the manual entry chip is. Attempting it while
      // the gate is shut produced the half-entered look the operator reported
      // (a plane anchored under the camera with no cockpit around it), so
      // refuse with the reason instead of trying.
      if (!this.cockpitView.isEntryAllowed?.()) {
        return {
          ok: false,
          action: 'control_cockpit',
          error: this._contextModeChanging
            ? 'Contacts is still starting up — try Cockpit again in a moment'
            : 'Contacts must be active to enter Cockpit — say "open contacts" first',
          state: this.getCockpitState(),
        };
      }
      let currentTarget = this.getAircraftTrackingTarget();
      const layerForTarget = (target) =>
        target?.layerId === 'military'
          ? militaryFlightsLayer
          : target?.layerId === 'flights'
            ? flightsLayer
            : null;
      // A requested layer retargets BEFORE entry, through the same filtered
      // navigation NEXT uses. Ignoring it entered on whatever was already
      // tracked and reported success, so "cockpit in that military helicopter"
      // silently put the operator in an airliner.
      if (targetLayer) {
        const requested = this._retargetCockpitEntryLayer({
          targetLayer,
          aircraftClass,
          currentTarget,
          selectedTarget,
        });
        if (!requested.ok) {
          return {
            ok: false,
            action: 'control_cockpit',
            error: requested.error,
            state: this.getCockpitState(),
          };
        }
        if (requested.retargeted) {
          // The retarget is now the authority; a selection sampled before it
          // would drag entry back to the wrong layer.
          selectedTarget = null;
          rollbackTarget =
            rollbackTarget === undefined ? currentTarget : rollbackTarget;
          currentTarget = this.getAircraftTrackingTarget();
        }
      }
      const selectedLayer =
        selectedTarget?.layerId === 'military'
          ? militaryFlightsLayer
          : selectedTarget?.layerId === 'flights'
            ? flightsLayer
            : null;
      const entry = enterCockpitWithTracking({
        cockpitView: this.cockpitView,
        selectedLayer,
        selectedTarget,
        currentLayer: layerForTarget(currentTarget),
        rollbackLayer: layerForTarget(
          rollbackTarget === undefined ? currentTarget : rollbackTarget,
        ),
        rollbackTarget,
        selectionOrigin: 'voice',
      });
      return {
        ok: entry.entered,
        action: 'control_cockpit',
        state: this.getCockpitState(),
        error: entry.error,
      };
    }
    if (normalized === 'exit') {
      const exited = !!this.cockpitView.exit();
      return {
        ok: exited,
        action: 'control_cockpit',
        state: this.getCockpitState(),
        error: exited ? null : 'Cockpit was already inactive',
      };
    }
    if (normalized === 'next' || normalized === 'previous') {
      const changed = this.cockpitView.navigateContext(
        normalized === 'next' ? 1 : -1,
        {
          targetLayer,
          aircraftClass,
          origin: 'voice',
        },
      );
      return {
        ok: changed,
        action: 'control_cockpit',
        state: this.getCockpitState(),
        error: changed ? null : 'No further context target was available',
      };
    }
    return {
      ok: false,
      action: 'control_cockpit',
      error: `Unknown cockpit action: ${action}`,
      state: this.getCockpitState(),
    };
  }

  /**
   * Full control-state snapshot — single source for voice read-back so the
   * agent confirms from the same state it acted on.
   * @returns {object} Current style/stack/HUD/detection/post-processing state.
   */
  getControlState() {
    return {
      style: this.activeStyle || 'normal',
      mapStack: this.mapStackController?.getActiveId?.() || null,
      hud: {
        visible: !!this.hud?.visible,
        layout: this.hud?.getVariant?.() || null,
      },
      detection: this.getDetectionState(),
      bloom: {
        enabled: !!this.bloomEnabled,
        intensityPct: this._bloomSlider
          ? parseInt(this._bloomSlider.value, 10)
          : null,
      },
      sharpen: {
        enabled: !!this.sharpenEnabled,
        intensityPct: this._sharpenSlider
          ? parseInt(this._sharpenSlider.value, 10)
          : null,
      },
      celestialRing: {
        enabled: this.celestialRingEnabled,
        visible: !!this.celestialRing?.visible,
      },
      orbiting: !!this.orbitController?.active,
      models3d: {
        enabled: !!this._models3dEnabled,
        mode: this._models3dMode || 'proximity',
      },
      recording: !!this._recording._recordingMode,
      cleanView: document.body.classList.contains('ui-clean-view'),
    };
  }

  /**
   * Captures the current camera position and orientation as a serializable object.
   * @returns {{lat: number, lon: number, alt: number, heading: number, pitch: number, roll: number}|null}
   */
  getCameraState() {
    const carto = this.viewer.camera.positionCartographic;
    if (!carto) return null;
    return {
      lat: Cesium.Math.toDegrees(carto.latitude),
      lon: Cesium.Math.toDegrees(carto.longitude),
      alt: carto.height,
      heading: Cesium.Math.toDegrees(this.viewer.camera.heading),
      pitch: Cesium.Math.toDegrees(this.viewer.camera.pitch),
      roll: Cesium.Math.toDegrees(this.viewer.camera.roll),
    };
  }

  /**
   * Flies the camera to a previously captured camera state using cubic ease-in-out.
   * @param {{lat: number, lon: number, alt: number, heading?: number, pitch?: number, roll?: number}} cameraState
   * @param {number} [duration=2.8] - Flight duration in seconds.
   * @returns {void}
   */
  applyCameraState(cameraState, duration = 2.8) {
    if (!cameraState) return;
    this.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        cameraState.lon,
        cameraState.lat,
        cameraState.alt,
      ),
      orientation: {
        heading: Cesium.Math.toRadians(cameraState.heading || 0),
        pitch: Cesium.Math.toRadians(cameraState.pitch || -35),
        roll: Cesium.Math.toRadians(cameraState.roll || 0),
      },
      duration: Math.max(0.2, duration || 0),
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
    });
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
   * Restores a full visual state snapshot, applying style, bloom, sharpen,
   * HUD, detection, and per-style shader uniforms. Used by scene recipes
   * and share-link restore. Async so the map-stack switch resolves before
   * the share state is synced; callers may fire-and-forget.
   * @param {object} [state={}] - Visual state object (as returned by getVisualState).
   * @param {object} [options]
   * @param {(() => boolean)|null} [options.isCurrent] Caller liveness predicate.
   *   The map-stack switch is this method's ONLY suspension point, and the
   *   shader-uniform writes come after it — so a caller superseded while that
   *   switch is in flight would otherwise resume and commit the look of a
   *   state the operator has already moved past. Scene playback reproduced
   *   exactly that: a stale shot's uniforms landing on top of the live run.
   *   Omit it and the method behaves as it always has.
   * @returns {Promise<boolean>} Whether the state was committed.
   */
  async applyVisualState(state = {}, { isCurrent = null } = {}) {
    return this._visualSettings.applyVisualState(...arguments);
  }

  /**
   * Resets the safe-frame overlay to its inactive state on init.
   * @returns {void}
   */
  _initRecordingOverlay() {
    return this._recording._initRecordingOverlay();
  }

  /**
   * Applies recording-friendly post-processing and shader uniform overrides.
   * @param {object} preset
   */
  applyCinematicPreset(preset = {}) {
    return this._visualSettings.applyCinematicPreset(...arguments);
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

  // ── Parameter Sliders ─────────────────────────

  /**
   * Rebuilds the parameter slider panel for the given style's shader uniforms.
   * Creates a labeled range input for each tunable uniform. Hides the panel
   * for 'normal' mode which has no shader parameters.
   * @param {string} styleName - Style name whose uniforms to display.
   * @returns {void}
   */
  _updateSliderPanel(styleName, { reveal = false } = {}) {
    return this._visualSettings._updateSliderPanel(...arguments);
  }

  /** Reveal the map-only parameter surface in the standard Display scroll owner. */
  _revealStyleParameters() {
    return this._visualSettings._revealStyleParameters(...arguments);
  }

  // ── Style switching ───────────────────────────

  /**
   * Switches the active visual style. Handles full lifecycle:
   * 1. Crossfades the previous shader stage intensity to 0.
   * 2. Crossfades the new shader stage intensity to 1.
   * 3. Applies style preset defaults (bloom/sharpen/HUD) if applyPreset is true.
   * 4. Updates button highlights, style indicator, slider panel, HUD, and detection overlay.
   * @param {string} styleName - Target style ('normal'|'retro'|'surveillance'|'thermal'|'anime'|'noir'|'snow').
   * @param {object} [options]
   * @param {boolean} [options.applyPreset=true] - Whether to apply STYLE_PRESET_DEFAULTS for the new style.
   * @returns {void}
   */
  setStyle(
    styleName,
    {
      applyPreset = true,
      revealParameters = applyPreset,
      restore = false,
    } = {},
  ) {
    this.audioEngine?.playStyleChange();
    return this._visualSettings.setStyle(...arguments);
  }

  // ── Shader transitions ────────────────────────

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
   * Style animation loop — self-stopping (perf wave 2). Runs only while a
   * crossfade is in flight or an animated (time-uniform) stage is visible,
   * holding continuous scene render for exactly that long. Re-armed by
   * _startTransition and by _setStageIntensity enabling an animated stage.
   * The traffic sync chip no longer rides this loop — it has its own 500 ms
   * interval (see _startTrafficChipTicker).
   */
  _startAnimationLoop() {
    this._visualEffects.startAnimationLoop();
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

  // ── Location Bar ─────────────────────────────

  /** Subscribe to the current location lookup, including replacements of its control owner. */
  subscribeLocationSearch(listener, options) {
    return this._locationState.subscribe(listener, options);
  }

  _handleLocationSearchState(state, change) {
    if (this._disposed || !change) return;
    if (change.type === 'started')
      this._activeLocationSearchGeneration = change.generation;
    else if (change.type === 'found') {
      this._searchedLocationLabel = state.destination.label || state.query;
      this._setActiveLocation(null);
      this._currentPoi = null;
      this._collapsePOIRow();
      this._updateLocationMiniStatus();
    } else if (change.type === 'missing') this._showToast('Location not found');
    else if (change.type === 'failed') this._showToast('Search failed');
    else if (change.type === 'settled')
      this._settleLocationSearchUi(change.generation);
    else if (
      change.type === 'reset' &&
      this._activeLocationSearchGeneration !== null
    ) {
      this._settleLocationSearchUi(this._activeLocationSearchGeneration);
    }
  }

  /**
   * Initializes the location bar: renders city pills from CITY_POIS, sets up
   * QWERTY keyboard navigation for POI selection, wires the search toggle
   * and geocoding search input.
   * @returns {void}
   */
  _initLocationBar() {
    const { CITY_POIS, searchAndFlyTo, LocationSearch } = this.services;
    this._locationControls?.destroy();
    this._locationLookupUnsubscribe?.();
    this._locationLookup?.destroy();
    this._locationLookup = new LocationSearch({
      input: this._locationSearch,
      begin: () => this._beginDeferredNavigation('location'),
      isCurrent: (generation) =>
        !this._disposed && generation === this._navigationGeneration,
      beforeFly: (generation) => this._reassertNavigationHandoff(generation),
      search: (query, options) =>
        searchAndFlyTo(this.viewer, query, {
          placeSearch: this.placeSearch,
          ...options,
        }),
      onError: (error) => console.error('[Search] Geocoding failed:', error),
    });
    this._locationLookupUnsubscribe = this._locationLookup.subscribe(
      ({ initial, change }) => {
        this._locationState.publish(initial ? { type: 'reset' } : change);
      },
    );
    this._locationControls = new LocationControls({
      elements: {
        pills: this._locationPills,
        poiRow: this._poiRow,
        divider: this._locationBarDivider,
        search: this._locationSearch,
        searchToggle: this._searchToggle,
        resetButtons: [this._resetGlobeBtn, this._cockpitResetGlobeBtn],
        statusCity: this._locationMiniCity,
        statusPoi: this._locationMiniPoi,
      },
      cities: CITY_POIS,
      getExpandedCity: () => this._expandedCityId,
      onCity: (id) => this._onCityPillClick(id),
      onPoi: (id, index) => this._onPoiClick(id, index),
      onSearch: (query) => this._locationLookup.run(query),
      onReset: () => this.resetToGlobeView(),
    });
  }

  /**
   * Signals the start of an inter-city world jump: notifies the traffic layer
   * to pause tile fetching and suspends detection overlays to prevent stale
   * rendering during the flight.
   * @returns {void}
   */
  _beginWorldJumpTransition() {
    const { suspendDetection, trafficLayer } = this.services;
    clearTimeout(this._trafficTransitionTimer);
    trafficLayer.beginWorldJump?.();
    suspendDetection('intercity');
  }

  /**
   * Signals the end of an inter-city world jump: resumes traffic tile fetching,
   * resumes detection overlays, and forces a traffic sync chip update.
   * @returns {void}
   */
  _endWorldJumpTransition() {
    const { resumeDetection, trafficLayer } = this.services;
    clearTimeout(this._trafficTransitionTimer);
    trafficLayer.endWorldJump?.();
    resumeDetection();
    this._updateTrafficSyncChip(true);
  }

  /**
   * Wraps a fly-to action with world-jump transition hooks when the target
   * city differs from the current one. Applies begin/end transition signals
   * with a 5.2s safety timeout to guarantee cleanup if the flight callback
   * never fires onComplete.
   * @param {boolean} cityChanged - Whether the destination is in a different city.
   * @param {function} flyAction - Callback receiving `{onStart, onComplete}` hooks; should return a result with targetPosition.
   * @returns {*} Return value from flyAction.
   */
  _flyWithTransition(cityChanged, flyAction) {
    return this._runExplicitNavigation('location', () => {
      if (!cityChanged) return flyAction({});
      let completed = false;
      const finalize = () => {
        if (completed) return;
        completed = true;
        this._endWorldJumpTransition();
      };
      const result = flyAction({
        onStart: () => this._beginWorldJumpTransition(),
        onComplete: finalize,
      });
      this._trafficTransitionTimer = window.setTimeout(finalize, 5200);
      return result;
    });
  }

  /**
   * Release camera ownership when a resolved Location destination starts.
   * Contact mode and its selected subject remain intact so FOCUS can return to
   * that subject after the user finishes inspecting the destination.
   * @returns {boolean} Whether a Contact subject remains selected.
   */
  beginLocationNavigation() {
    this._stampNavigation();
    this.cockpitView?.exit({ restoreTracking: false });
    return this._releaseFollowCamera({ preserveVesselSelection: false });
  }

  /**
   * Handles a city pill click: toggles POI row collapse if same city,
   * otherwise expands the POI row, flies to the city's first POI, and
   * tracks the target position for orbit mode.
   * @param {string} cityId - Identifier of the clicked city.
   * @returns {void}
   */
  _onCityPillClick(cityId) {
    const { CITY_POIS, flyToPresetLocation } = this.services;
    if (this._expandedCityId === cityId) {
      // Same city clicked again — toggle collapse
      this._collapsePOIRow();
      return;
    }

    const isCityChanged =
      this._activeLocationId && this._activeLocationId !== cityId;
    const result = this._flyWithTransition(!!isCityChanged, (hooks) =>
      flyToPresetLocation(this.viewer, cityId, hooks),
    );
    if (result === false) return;
    this._expandPOIRow(cityId);
    this._setActiveLocation(cityId);
    this._activePoiIndex = 0;
    this._updatePoiHighlight();

    // Track current target + POI for orbit
    if (result) {
      this._currentTarget = result.targetPosition;
      this._currentPoi = CITY_POIS[cityId].pois[0];
    }
    this._updateLocationMiniStatus();
  }

  /**
   * Handles a POI pill click: stops orbit, flies to the POI, highlights it,
   * and saves the target position for future orbit activation.
   * @param {string} cityId - Parent city identifier.
   * @param {number} poiIndex - Index of the POI within the city's pois array.
   * @returns {void}
   */
  _onPoiClick(cityId, poiIndex) {
    const { CITY_POIS, flyToPOI } = this.services;
    const isCityChanged =
      this._activeLocationId && this._activeLocationId !== cityId;
    const result = this._flyWithTransition(!!isCityChanged, (hooks) =>
      flyToPOI(this.viewer, cityId, poiIndex, hooks),
    );
    if (result === false) return;
    this._setActiveLocation(cityId);
    this._activePoiIndex = poiIndex;
    this._updatePoiHighlight();

    // Track current target + POI for orbit
    if (result) {
      this._currentTarget = result.targetPosition;
      this._currentPoi = CITY_POIS[cityId].pois[poiIndex];
    }
    this._updateLocationMiniStatus();
  }

  /**
   * Builds and shows the POI pill row for a city. Each pill displays a
   * QWERTY keyboard shortcut key and the POI name.
   * @param {string} cityId - City whose POIs to render.
   * @returns {void}
   */
  _expandPOIRow(cityId) {
    const { CITY_POIS } = this.services;
    if (!CITY_POIS[cityId]) return;
    this._expandedCityId = cityId;
    this._locationControls.showPois(cityId);
  }

  /**
   * Hides the POI pill row and clears the expanded city state.
   * @returns {void}
   */
  _collapsePOIRow() {
    this._expandedCityId = null;
    this._activePoiIndex = null;
    this._locationControls.hidePois();
  }

  /**
   * Highlights the active POI pill and removes highlight from all others.
   * @returns {void}
   */
  _updatePoiHighlight() {
    this._locationControls.highlightPoi(this._activePoiIndex);
  }

  /**
   * Forget the last free-text search destination and repaint the LOCATION
   * readout. Public so camera owners that fly on their own — scene playback
   * most of all — can invalidate it without reaching into private state.
   * @returns {void}
   */
  clearSearchedLocation() {
    if (this._searchedLocationLabel === null) return;
    this._searchedLocationLabel = null;
    this._updateLocationMiniStatus();
  }

  /**
   * Sets the active city location, highlights its pill, and updates the mini-status readout.
   * @param {string|null} locationId - City identifier, or null to clear.
   * @returns {void}
   */
  _setActiveLocation(locationId) {
    this._activeLocationId = locationId;
    // A preset city is now what the camera is framed on, so any earlier
    // free-text destination has been superseded. Clearing only on a real id
    // leaves the search path's own _setActiveLocation(null) untouched.
    if (locationId) this._searchedLocationLabel = null;
    this._locationControls?.highlightCity(locationId);
    this._updateLocationMiniStatus();
  }

  /**
   * Updates the collapsed mini-status readout with the current destination:
   * a preset city + POI/landmark, or the last free-text geocode search.
   * @returns {void}
   */
  _updateLocationMiniStatus() {
    const { CITY_POIS } = this.services;
    this._locationControls?.renderStatus({
      city: this._activeLocationId ? CITY_POIS[this._activeLocationId] : null,
      currentPoi: this._currentPoi,
      searchedLabel: this._searchedLocationLabel,
    });
  }

  /**
   * Updates the collapsed mini-status readout with the active style label.
   * @param {string} [styleName=this.activeStyle] - Style name to display.
   * @returns {void}
   */
  _updateStyleMiniStatus(styleName = this.activeStyle) {
    return this._visualSettings._updateStyleMiniStatus(...arguments);
  }

  // ── Orbit Mode ──────────────────────────────

  /**
   * Creates the orbit mode indicator DOM element and appends it to the body.
   * @returns {void}
   */
  _initOrbit() {
    this._orbitIndicator = this._locationControls.createOrbitIndicator();
  }

  /**
   * Toggles the orbit controller around the current POI target. Shows a toast
   * if no target position has been set (user must fly to a POI first).
   * @returns {void}
   */
  _toggleOrbit() {
    if (!this._currentTarget) {
      this._showToast('Fly to a POI first');
      return;
    }

    const isActive = this.orbitController.toggle(this._currentTarget, {
      radius: this._currentPoi?.alt || 500,
      pitch: this._currentPoi?.pitch || -30,
    });

    this._orbitIndicator.classList.toggle('active', isActive);
  }

  /**
   * Stops orbit mode if active and hides the orbit indicator.
   * @returns {void}
   */
  _stopOrbit() {
    if (this.orbitController.active) {
      this.orbitController.stop();
      this._orbitIndicator.classList.remove('active');
    }
  }

  /** Wire the top-center action that clears only manager-owned data layers. */
  _initClearSelectedLayersButton() {
    if (!this._clearSelectedLayersBtn) return;
    this._clearLayersControl?.destroy();
    this._clearLayersControl = bindClearLayersControl(
      this._clearSelectedLayersBtn,
      () => this.clearSelectedLayers(),
    );
  }

  /** Wire Google Maps-style tilt and north-up camera actions. */
  _initCameraOrientationControls() {
    this._cameraOrientationControls?.destroy();
    this._cameraOrientationControls = bindCameraOrientationControls({
      viewer: this.viewer,
      elements: {
        tiltButton: this._tiltMapBtn,
        northButton: this._northUpBtn,
      },
      runNavigation: (noun, navigate) =>
        this._navigation.runOrientation(noun, navigate),
      showToast: (message) => this._showToast(message),
    });
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

  /**
   * Release every camera owner and return to the canonical full-globe frame.
   * Repeated requests adopt the in-flight reset rather than cancelling it.
   * @returns {Promise<object>} Canonical reset result shared with voice.
   */
  resetToGlobeView() {
    const {
      GLOBE_VIEW,
      flyToGlobeView,
      interruptCameraMotion,
      flightsLayer,
      militaryFlightsLayer,
      satellitesLayer,
      aisLiveVesselsLayer,
      militaryAwarenessLayer,
      rocketLaunchesLayer,
    } = this.services;
    if (this._globeResetPromise) return this._globeResetPromise;
    this._stampNavigation();
    interruptCameraMotion('reset-globe');
    this._stopOrbit();
    this.audioEngine?.playGlobeReset();
    this.cockpitView?.exit({ restoreTracking: false });
    try {
      militaryAwarenessLayer.releaseCameraOwnership?.({ origin: 'tool' });
    } catch {
      // Keep reset available if Context has not initialized completely.
      try {
        flightsLayer.stopTracking?.({ origin: 'tool' });
      } catch {
        /* best-effort release */
      }
      try {
        militaryFlightsLayer.stopTracking?.({ origin: 'tool' });
      } catch {
        /* best-effort release */
      }
      try {
        aisLiveVesselsLayer.clearSelection?.();
      } catch {
        /* best-effort release */
      }
    }
    try {
      satellitesLayer.stopTracking?.({ origin: 'tool' });
    } catch {
      /* best-effort release */
    }
    try {
      rocketLaunchesLayer.releaseCameraOwnership?.();
    } catch {
      /* best-effort release */
    }
    this.viewer.trackedEntity = undefined;
    this.viewer.camera.cancelFlight();
    this.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    this._beginWorldJumpTransition();

    let resolveReset;
    const resetPromise = new Promise((resolve) => {
      resolveReset = resolve;
    });
    this._globeResetPromise = resetPromise;
    let settled = false;
    let timer = null;
    const finish = (cancelled = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this._endWorldJumpTransition();
      const carto = this.viewer.camera.positionCartographic;
      const result = {
        ok: !cancelled,
        action: 'zoom_to_globe',
        cancelled,
        heightKm: Math.round(GLOBE_VIEW.heightM / 1000),
        centeredOn: {
          latitude: Number(Cesium.Math.toDegrees(carto.latitude).toFixed(2)),
          longitude: Number(Cesium.Math.toDegrees(carto.longitude).toFixed(2)),
        },
      };
      this._resetGlobeBtn?.setAttribute(
        'aria-label',
        'Reset to full globe view',
      );
      this._cockpitResetGlobeBtn?.setAttribute(
        'aria-label',
        'Reset cockpit to full globe view',
      );
      this._globeResetPromise = null;
      resolveReset(result);
    };
    timer = window.setTimeout(() => {
      const height = this.viewer.camera.positionCartographic?.height;
      finish(
        !Number.isFinite(height) ||
          Math.abs(height - GLOBE_VIEW.heightM) > 1000,
      );
    }, 4200);
    this._resetGlobeBtn?.setAttribute(
      'aria-label',
      'Resetting to full globe view',
    );
    this._cockpitResetGlobeBtn?.setAttribute(
      'aria-label',
      'Resetting cockpit to full globe view',
    );
    const target = flyToGlobeView(this.viewer, {
      onComplete: () => finish(false),
      onCancel: () => finish(true),
    });
    if (!target) finish(true);
    return resetPromise;
  }

  // ── Share Button ─────────────────────────────

  /**
   * Wires the share button click to copy the current share link to the clipboard.
   * @returns {void}
   */
  _initShareButton() {
    this._lifetime.listen(this._shareBtn, 'click', async () => {
      const success = await this.shareLinkManager.copyLink();
      this._showToast(success ? 'Link copied!' : 'Copy failed');
    });
  }

  /**
   * Displays a temporary toast notification for 2 seconds.
   * @param {string} message - Text to show in the toast.
   * @returns {void}
   */
  _showToast(message) {
    return this._feedback._showToast(message);
  }

  // ── HUD Toggle ───────────────────────────────

  /**
   * Wires the HUD toggle button, initializes the default HUD variant to 'tactical',
   * and sets up the detection mode cycle button.
   * @returns {void}
   */
  /**
   * Wires the DISPLAY-rail "3D" toggle to the flights layer's `models3d` param.
   * ON by default in `proximity` mode (owner directive 2026-08-22): the fleet
   * renders as 3D glTF models once the camera is zoomed in past the layer's
   * altitude ceiling, and only the nearest MODEL_MAX in view are admitted, so
   * the default costs nothing at globe scale. `all` is the deliberate opt-in;
   * turning the toggle off returns the fleet to flat billboards. The TRACKED
   * contact is independent of this toggle (see trackedModelRegime.js).
   * @returns {void}
   */
  /** One 3D toggle drives BOTH aircraft layers (commercial + military) so all planes flip together. */
  _setModels3dParams(params, { origin = 'user' } = {}) {
    this._dataManager?.setLayerParams('flights', params, { origin });
    this._dataManager?.setLayerParams('military', params, { origin });
  }

  _syncModels3dFromLayerState(state) {
    const options = state?.options?.flights;
    if (!options) return;
    this._models3dEnabled = options.models3d === true;
    this._models3dMode = options.models3dMode === 'all' ? 'all' : 'proximity';
    this._syncModels3dButtonState();
    this._models3dModeRow?.classList.toggle('visible', this._models3dEnabled);
    for (const button of this._models3dModeBtns || []) {
      if (!button) continue;
      const active = button.dataset.mode === this._models3dMode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-checked', String(active));
    }
    this._layoutRightPanels();
  }

  _syncModels3dModeRow() {
    if (this._models3dModeRow)
      this._models3dModeRow.classList.toggle('visible', this._models3dEnabled);
    this._layoutRightPanels();
  }

  _initModels3dToggle() {
    if (!this._models3dBtn) return;
    this._syncModels3dButtonState();
    this._syncModels3dModeRow();
  }

  _setModels3dEnabled(enabled) {
    this._models3dEnabled = !!enabled;
    this._setModels3dParams({ models3d: this._models3dEnabled });
    this._syncModels3dButtonState();
  }

  _setModels3dMode(mode) {
    const normalized = mode === 'all' ? 'all' : 'proximity';
    this._models3dMode = normalized;
    this._setModels3dParams({ models3dMode: normalized });
    for (const button of this._models3dModeBtns) {
      if (!button) continue;
      const active = button.dataset.mode === normalized;
      button.classList.toggle('active', active);
      button.setAttribute('aria-checked', String(active));
    }
    this._syncModels3dButtonState();
  }

  _syncModels3dButtonState() {
    this._models3dBtn?.classList.toggle('active', this._models3dEnabled);
    // The lit/dark state is a colour to a sighted operator and nothing at all to
    // a screen reader without this. It matters more now that the button ships
    // ACTIVE from markup (default-on, 2026-08-22): the very first thing assistive
    // tech reported was an unpressed-looking control over an armed layer.
    // Mirrors #scope-toggle, which has always carried aria-pressed.
    this._models3dBtn?.setAttribute(
      'aria-pressed',
      String(this._models3dEnabled),
    );
  }

  _initHUDToggle() {
    if (this._hudLayoutSelect) {
      this._hudLayoutSelect.value = 'tactical';
    }
    this._setHudVariant('tactical');
    this.hud.setMode('on');
    this._updateHudButtonState();

    this._lifetime.listen(this._cockpitDisplayToggleBtn, 'click', () => {
      const open =
        this._cockpitDisplayToggleBtn.getAttribute('aria-expanded') === 'true';
      this._setCockpitDisclosure?.('display', !open);
    });
    this._initCockpitDisplayPortal();
  }

  /**
   * Reuses the production Display controls inside Cockpit without cloning
   * stateful inputs or event listeners. Comment anchors preserve each group's
   * exact home in the standard Display panel for exit and teardown.
   * @returns {void}
   */
  _initCockpitDisplayPortal() {
    this._cockpitDisplayPortal?.destroy();
    this._cockpitDisplayPortal = new CockpitDisplayPortal({
      standardPanel: this._ppToggles,
      cockpitPanel: this._cockpitDisplayPanel,
      groups: [
        ['hud', this._hudBtn?.closest('.pp-toggle-group')],
        ['detection', this._detectionBtn?.closest('.pp-toggle-group')],
        ['parameters', this._sliderPanel],
        ['models3d', this._models3dBtn?.closest('.pp-toggle-group')],
      ],
      layout: () => {
        this._layoutRightPanels();
        this.cockpitView?.scheduleContextLayout();
      },
    });
  }

  /**
   * Moves the shared HUD, Detection, Parameters, and 3D controls into or out
   * of Cockpit.
   * @param {boolean} active Whether Cockpit owns the Display control groups.
   * @returns {void}
   */
  _setCockpitDisplayPortalActive(active) {
    this._cockpitDisplayPortal?.setActive(active);
  }
  get _cockpitDisplayPortalActive() {
    return this._cockpitDisplayPortal?.active ?? false;
  }
  get _displayPortalScrollRestoreOwner() {
    return this._cockpitDisplayPortal?.restoreOwner ?? null;
  }
  get _standardDisplayScrollTop() {
    return this._cockpitDisplayPortal?.standardScrollTop ?? 0;
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

  /**
   * Recalculates the CCTV panel max-height based on its current top position
   * and the window height, enabling internal scroll without viewport overflow.
   * @returns {void}
   */
  _syncCctvPanelViewport() {
    if (!this._cctvPanel) return;
    const inner = this._cctvPanel.querySelector('.cctv-panel-inner');
    this._lifetime.frame(() => {
      if (this._cctvPanel.parentElement?.id === 'right-context-rail') {
        this._cctvPanel.style.maxHeight = '';
        if (inner) inner.style.maxHeight = '';
        this._scheduleRightPanelLayout();
        return;
      }
      const rect = this._cctvPanel.getBoundingClientRect();
      const availableHeight = Math.max(
        190,
        Math.floor(window.innerHeight - rect.top - 12),
      );
      this._cctvPanel.style.maxHeight = `${availableHeight}px`;
      if (inner) {
        inner.style.maxHeight = `${availableHeight}px`;
      }
    });
  }

  /** Whether a share link was used to load the page */
  get hasShareState() {
    return !!this._hasShareState;
  }

  /** Terminal result for the complete initial share restoration. */
  get initialRestorePromise() {
    return (
      this._initialShareRestorePromise ||
      Promise.resolve({ status: 'not-requested' })
    );
  }

  _settleInitialShareRestore(result) {
    return this._shareRestoration._settleInitialShareRestore(...arguments);
  }

  getCameraFocalPoint() {
    if (!this.viewer?.camera) return { latDeg: 0, lonDeg: 0, altitudeM: 0 };
    try {
      const ray = this.viewer.camera.getPickRay(
        new Cesium.Cartesian2(
          this.viewer.canvas.width / 2,
          this.viewer.canvas.height / 2,
        ),
      );
      const pos = this.viewer.scene?.globe?.pick?.(ray, this.viewer.scene);
      if (pos) {
        const carto = Cesium.Cartographic.fromCartesian(pos);
        return {
          latDeg: (carto.latitude * 180) / Math.PI,
          lonDeg: (carto.longitude * 180) / Math.PI,
          altitudeM: carto.height,
        };
      }
    } catch {}
    const carto = this.viewer.camera.positionCartographic;
    return {
      latDeg: (carto?.latitude * 180) / Math.PI || 0,
      lonDeg: (carto?.longitude * 180) / Math.PI || 0,
      altitudeM: carto?.height || 0,
    };
  }

  _collectDossierData() {
    const focal = this.getCameraFocalPoint();
    const cameraState = {
      latDeg: focal.latDeg,
      lonDeg: focal.lonDeg,
      altitudeM: this.viewer?.camera?.positionCartographic?.height || focal.altitudeM,
      headingDeg: (this.viewer?.camera?.heading * 180) / Math.PI || 0,
      pitchDeg: (this.viewer?.camera?.pitch * 180) / Math.PI || -90,
    };

    let trackedEntity = null;
    const active = this.viewer?.trackedEntity;
    if (active) {
      trackedEntity = {
        id: active.name || active.id || 'TARGET',
        type: active.properties?.type?.getValue?.() || 'AIRCRAFT',
        speedKts: active.properties?.speed?.getValue?.() || 0,
        altitudeM: active.properties?.altitude?.getValue?.() || 0,
        headingDeg: active.properties?.heading?.getValue?.() || 0,
        latDeg: focal.latDeg,
        lonDeg: focal.lonDeg,
      };
    }

    return {
      operationName: "GOD'S EYE VIEW TACTICAL INTEL BRIEFING",
      timestamp: new Date(),
      cameraState,
      trackedEntity,
      geofences: this.geofenceEngine?.getZones() || [],
      weather: this._lastWeatherObservation || { available: false },
    };
  }

  _handleRadialAction(action, entity) {
    if (!entity) return;
    switch (action) {
      case 'lock':
      case 'chase':
        this.viewer.trackedEntity = entity;
        this.audioEngine?.playLock();
        this._showToast(`Target acquired: ${entity.id || entity.name || 'Contact'}`);
        break;
      case 'cockpit':
        enterCockpitWithTracking(entity, this.viewer, this.cockpitView);
        break;
      case 'cctv':
        if (entity.position) {
          const time = this.viewer.clock.currentTime;
          const pos = entity.position.getValue ? entity.position.getValue(time) : entity.position;
          routeCctvFocusRequest(
            { kind: 'cctv', position: pos },
            (activate, focus) => this._runExplicitCctvFocus(activate, focus),
            (id, dur) => this.services?.cctvLayer?.focusCamera(id, dur),
          );
        }
        break;
      case 'trajectory':
        if (this.trajectoryOverlay) {
          this.trajectoryOverlay.showTrajectoryForEntity(entity);
          this._showToast(`Extrapolating trajectory for ${entity.id || entity.name}`);
        }
        break;
      case 'inspect':
        if (this.hud?.setMode) this.hud.setMode('on');
        this._showToast(`Telemetry inspector opened`);
        break;
      case 'watchlist':
        this._showToast(`Added ${entity.id || entity.name} to priority alert watchlist`);
        this.audioEngine?.playAlert();
        break;
      case 'dismiss':
        this.radialMenu?.close();
        break;
    }
  }

  _initTacticalSuiteControls() {
    if (typeof document === 'undefined') return;

    const toggle = document.getElementById('tactical-suite-toggle');
    const row = document.getElementById('tactical-suite-row');
    const sfxBtn = document.getElementById('tactical-sfx-btn');
    const gestureBtn = document.getElementById('tactical-gesture-btn');
    const fenceBtn = document.getElementById('tactical-geofence-btn');
    const timelineBtn = document.getElementById('tactical-timeline-btn');
    const exportBtn = document.getElementById('tactical-export-btn');
    const gestureFab = document.getElementById('gesture-quick-toggle-fab');

    toggle?.addEventListener('click', () => {
      const isVisible = row?.style.display === 'flex';
      if (row) row.style.display = isVisible ? 'none' : 'flex';
      toggle.classList.toggle('active', !isVisible);
      toggle.setAttribute('aria-pressed', String(!isVisible));
    });

    sfxBtn?.addEventListener('click', () => {
      const isMuted = !this.audioEngine?.isMuted();
      this.audioEngine?.setMuted(isMuted);
      sfxBtn.classList.toggle('active', !isMuted);
      sfxBtn.textContent = isMuted ? '🔇 Muted' : '🔊 SFX';
      this._showToast(isMuted ? 'Tactical Audio Muted' : 'Tactical Audio Enabled');
    });

    gestureBtn?.addEventListener('click', () => {
      this.gestureControls?.toggle();
    });

    gestureFab?.addEventListener('click', () => {
      this.gestureControls?.toggle();
    });

    window.addEventListener('keydown', (e) => {
      if (
        (e.key === 'g' || e.key === 'G') &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey &&
        !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)
      ) {
        e.preventDefault();
        this.gestureControls?.toggle();
      }
    });

    fenceBtn?.addEventListener('click', () => {
      const focal = this.getCameraFocalPoint();
      const count = (this.geofenceEngine?.getZones().length || 0) + 1;
      const zoneName = `Zone-${count}`;
      this.geofenceEngine?.addCircularZone({
        name: zoneName,
        center: { lat: focal.latDeg, lon: focal.lonDeg },
        radiusM: 50000,
        minAltM: 0,
        maxAltM: 12000,
      });
      this.geofenceRenderer?.render(this.geofenceEngine?.getZones());
      this.audioEngine?.playLock();
      this._showToast(`Deployed Tactical Perimeter: ${zoneName}`);
    });

    timelineBtn?.addEventListener('click', () => {
      const isShown = this.timelineScrubber?.toggle();
      timelineBtn.classList.toggle('active', isShown);
      this._showToast(isShown ? '4D Timeline Replay Active' : 'Returned to Live Real-Time Feed');
    });

    exportBtn?.addEventListener('click', () => {
      this.exportControls?.exportDossier();
      this._showToast('Exported Tactical Mission Dossier');
    });
  }

  _handleGestureAction(action, payload) {
    switch (action) {
      case 'pan':
        if (this.viewer?.camera && payload?.pointTip) {
          const dx = payload.pointTip.x - 0.5;
          if (Math.abs(dx) > 0.08) {
            this.viewer.camera.rotate(Cesium.Cartesian3.UNIT_Z, -dx * 0.02);
          }
        }
        break;
      case 'pinch_zoom': {
        const delta = (payload?.pinchDist || 0.05) - 0.05;
        if (this.viewer?.camera && Math.abs(delta) > 0.008) {
          const amount = delta * 50000;
          if (amount > 0) {
            this.viewer.camera.zoomOut(amount);
          } else {
            this.viewer.camera.zoomIn(-amount);
          }
        }
        break;
      }
      case 'toggle_lock':
        if (this.viewer?.trackedEntity) {
          this.viewer.trackedEntity = undefined;
          this.audioEngine?.playRelease();
          this._showToast('Tracking lock disengaged');
        } else if (this.viewer?.selectedEntity) {
          this.viewer.trackedEntity = this.viewer.selectedEntity;
          this.audioEngine?.playLock();
          this._showToast(
            `Tracking locked: ${this.viewer.selectedEntity.name || this.viewer.selectedEntity.id || 'Target'}`,
          );
        } else if (this._currentTarget) {
          this._toggleOrbit();
          this._showToast('Target orbit lock engaged');
        } else {
          const flightsLayer = this.services?.flightsLayer;
          const entity = flightsLayer?.dataSource?.entities?.values?.[0];
          if (entity && this.viewer) {
            this.viewer.trackedEntity = entity;
            this.audioEngine?.playLock();
            this._showToast(`Tracking locked: ${entity.name || entity.id || 'Flight Contact'}`);
          } else {
            this._showToast('Select an entity on globe to lock tracking');
          }
        }
        break;
      case 'reset_globe':
        if (typeof this.resetToGlobeView === 'function') {
          this.resetToGlobeView();
        } else if (this._navigation?.resetView) {
          this._navigation.resetView();
        }
        this._showToast('Globe reset to home view');
        break;
      case 'toggle_cockpit':
        if (this.cockpitView?.active) {
          const res = this.controlCockpit('exit');
          this._showToast(res.ok ? 'Exited Cockpit View' : 'Cockpit already inactive');
        } else {
          if (!this.cockpitView.isEntryAllowed?.()) {
            if (!this.getContextModeState()?.active) {
              this.setContextMode('contacts');
            }
            const flightsLayer = this.services?.flightsLayer;
            const entity = this.viewer?.trackedEntity || flightsLayer?.dataSource?.entities?.values?.[0];
            if (entity && this.viewer) {
              this.viewer.trackedEntity = entity;
            }
          }
          const res = this.controlCockpit('enter');
          if (res.ok) {
            this._showToast('Engaged Cockpit View');
          } else {
            this._showToast(res.error || 'Select a flight to enter Cockpit');
          }
        }
        break;
      case 'export_dossier':
        this.exportControls?.exportDossier();
        this._showToast('Exported Tactical Mission Dossier');
        break;
      case 'cycle_style': {
        const styles = ['normal', 'retro', 'surveillance', 'thermal', 'anime', 'noir', 'snow'];
        const currIdx = styles.indexOf(this.activeStyle);
        const next = styles[(currIdx + 1) % styles.length];
        this.setStyle(next);
        this._showToast(`Visual Preset: ${next.toUpperCase()}`);
        break;
      }
      case 'toggle_voice': {
        const voiceBtn = document.getElementById('voice-control-btn') || document.querySelector('.gev-voice-btn');
        voiceBtn?.click();
        break;
      }
      case 'confirm':
        this._showToast('Gesture confirmed');
        break;
      case 'dismiss':
        this.radialMenu?.close();
        this._showToast('Dismissed');
        break;
      case 'next_contact':
      case 'prev_contact':
        this.services?.flightsLayer?.focusNext?.();
        break;
    }
  }

  /**
   * Tear down the StyleManager — cancel animation loop, clear intervals,
   * and release resources. Call this before discarding the instance to
   * prevent leaked rAF loops and event listeners.
   * @returns {Promise<void>} Resolves after focused-session state restoration.
   */
  async dispose() {
    const { destroyTrackedReadout, destroyWorldOverlay, destroyDetection } =
      this.services;
    if (this._disposed) return;
    this._shareRestoration.destroy();
    this._feedback._globalStatusNotice = null;
    if (this._globalLoadingStatus) this._globalLoadingStatus.hidden = true;
    this._disposed = true;
    this._navigation.stop();
    this._shareState.destroy();
    this._locationState.destroy();
    this._locationLookupUnsubscribe?.();
    this._locationLookupUnsubscribe = null;
    this._lifetime.destroy();
    this._recording.destroy();
    this._panelChrome.destroy();
    this._feedback.destroy();

    this._applicationShortcuts?.destroy();
    this._displayControls?.destroy();
    this._frameRateMonitor?.destroy();
    this._mapSourceControls?.destroy();
    this._cameraOrientationControls?.destroy();
    this._clearLayersControl?.destroy();
    this._locationControls?.destroy();
    this._cctvControls?.destroy();
    this._radioControls?.destroy();
    this.cockpitView?.stop();
    this._cockpitDisplayPortal?.stop();
    this._visualSettings.stop();
    this._locationLookup?.destroy();
    this.shareLinkManager?.destroy();
    if (this._awarenessSelectedHandler) {
      window.removeEventListener(
        'gev:awareness-subject-selected',
        this._awarenessSelectedHandler,
      );
      this._awarenessSelectedHandler = null;
    }
    if (this._awarenessClearedHandler) {
      window.removeEventListener(
        'gev:awareness-subject-cleared',
        this._awarenessClearedHandler,
      );
      this._awarenessClearedHandler = null;
    }

    this.radialMenu?.destroy();
    this.trajectoryOverlay?.destroy();
    this.geofenceRenderer?.destroy();
    this.audioControls?.destroy();
    this.geofenceControls?.destroy();
    this.timelineScrubber?.destroy();
    this.gestureControls?.destroy();
    this.touchGestures?.detach();
    this.exportControls?.destroy();
    this.weatherParticles?.destroy();

    // Invalidate any in-flight Context transaction the same way a newer request
    // would. Without this, a reinstatement already past its awaits could
    // re-enable a mode's entry layer and republish `_contextMode` while the
    // rest of teardown is tearing those very layers down.
    this._contextControls.stop();
    this._navigation.destroy();
    // Close camera-entry seams synchronously. Context restoration may await
    // layer work, so leaving these listeners attached until afterward lets a
    // focus event release tracking or start a flight during teardown.
    this._removeCctvRequestFocusListener?.();
    this._removeCctvRequestFocusListener = null;
    this._cctvRequestFocusHandler = null;
    this._removeWorldRequestFocusListener?.();
    this._removeWorldRequestFocusListener = null;
    this._worldRequestFocusHandler = null;
    this._navigationOwnerChangedRemover?.();
    this._navigationOwnerChangedRemover = null;
    this._removeNavigationAuthorityListener?.();
    this._removeNavigationAuthorityListener = null;
    await this._contextControls.restoreForDisposal();
    // IR boost teardown BEFORE detaching the data manager: restore fog and
    // un-boost both aircraft layers so a surviving viewer or replacement
    // manager doesn't inherit sensor state (review P2, 2026-08-16).
    this._visualSettings.releaseIrBoost();
    this.cockpitView?.dispose();
    this._cockpitDisplayPortal?.destroy();
    this._cockpitDisplayPortal = null;
    this._contextControls.disconnect();
    this._dataManagerUnsubscribe?.();
    this._dataManagerUnsubscribe = null;
    this._directionsShellModule?.attachShellServices?.(null);
    this._directionsShellModule = null;

    if (this._windowResizeHandler) {
      window.removeEventListener('resize', this._windowResizeHandler);
      this._windowResizeHandler = null;
    }
    destroyTrackedReadout();
    destroyDetection();
    destroyWorldOverlay();
    this.celestialRing?.destroy();
    this._visualSettings.destroy();
  }
}

