import { nextTick } from 'vue';
import { resolveImageryHost } from '../layers/weather/imageryHost.js';
import { ShellFacade } from './shellFacade.js';
import { AircraftDisplay } from './aircraftDisplay.js';
import { LayerBindings } from './layerBindings.js';
import { PanelChrome } from './panelChrome.js';
import { initMobileShell } from './mobileShell.js';
import { VisualSettings } from './visualSettings.js';
import { NavigationController } from './navigationController.js';
import { ShareRestoration } from './shareRestoration.js';
import { DisplayBindings } from './displayBindings.js';
import { createStateChannel } from '../app/stateChannel.js';
import { UiLifetime } from './uiLifetime.js';
import { RecordingControls } from './recordingControls.js';
import { readShellElements } from './shellElements.js';
import { CockpitCoordinator } from './cockpitCoordinator.js';
import { ContextControls } from './context.js';
import { CctvControls } from './cctv.js';
import { StreetLevelControls } from './streetLevelControls.js';
import { createWildlifeSightingCard } from './wildlifeSightingCard.js';
import { RadioControls } from './radio.js';
import { LocalSdrControls } from './localSdrControls.js';
import { LocationNavigation } from './locationNavigation.js';
import { bindCameraOrientationControls } from './cameraOrientationControls.js';
import { createMapSourceControls } from './mapSource.js';
import { STYLES } from './effects.js';
import { isHudLayout } from '../hudLayouts.js';
import {
  getCyberSonarControlState,
  setCyberSonarControls,
} from './cyberSonarControls.js';

import * as Cesium from 'cesium';

import { aircraftTrackingTarget } from '../cockpitTracking.js';

import { ShellFeedback } from './shellFeedback.js';
import {
  applyShareFollowOffset,
  readShareFollowSubject,
} from './shareFollow.js';

import { runCctvLayerEnableTransition } from '../cctvFocusPolicy.js';

import {
  getLocale,
  onLocaleChange,
  persistLocale,
  setLocale,
  t,
} from '../i18n/index.js';
import { applyLocaleChoice } from './localePicker.js';
import { PanelNavigation } from './panelNavigation.js';
import { applicationPinia, createUiRuntime } from './vueRuntime.js';
import { useContextStore } from './stores/context.js';
import { useMissionReplayStore } from './stores/missionReplay.js';
import { useCelestialRingStore } from './stores/celestialRing.js';
import { useWorldOverlayActionsStore } from './stores/worldOverlayActions.js';
import { useAwarenessDirectionStore } from './stores/awarenessDirection.js';
import { useHudStore } from './stores/hud.js';
import { useDisplayStore } from './stores/display.js';
import { useLocaleStore } from './stores/locale.js';
import { useLocationStore } from './stores/location.js';
import { useCockpitStore } from './stores/cockpit.js';
import { useGlobeActionsStore } from './stores/globeActions.js';
import { useRecordingStore } from './stores/recording.js';
import { onPlacePacksLoadingChange } from '../data/placeBelow.js';
import { withPlacePacks } from './placePacksLoading.js';
import { preloadOwnerFlags } from './ownerFlag.js';

/**
 * Central UI orchestrator for the God's Eye View application.
 *
 * Responsibilities:
 * - Visual controls and presets backed by the VisualEffects controller.
 * - Bloom and sharpen post-processing toggle/intensity control.
 * - Collapsible rail panels with their collapsed state kept in localStorage.
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

export class StyleManager extends ShellFacade {
  /**
   * @param {Cesium.Viewer} viewer - The CesiumJS viewer instance.
   * @param {object} [options]
   * @param {boolean} [options.localePicker=true] - false removes the language
   *   picker, for a host that does not initialize Core's locale.
   */
  constructor(
    viewer,
    {
      mapStackController = null,
      placeSearch,
      services,
      requestServices,
      initialShareCode = null,
      localePicker = true,
    } = {},
  ) {
    super();
    this._localePickerEnabled = localePicker;
    const {
      IntelHUD,
      ShareLinkManager,
      CelestialRing,
      initTrackedReadout,
      initWorldOverlay,
      subscribeWorldOverlayActions,
      activateWorldOverlayAction,
      initDetection,
      setDetectionStyle,
      trafficLayer,
      flightsLayer,
      militaryFlightsLayer,
      satellitesLayer,
      cctvLayer,
      bikeshareLayer,
      transitLayer,
      aisLiveVesselsLayer,
      militaryAwarenessLayer,
      localAdsbLayer,
    } = services;
    this.services = services;
    this._lifetime = new UiLifetime();
    this._recording = new RecordingControls({
      syncShareState: () => this._syncShareState(),
      syncHudControls: () => this._visualSettings._syncHudControls(),
      publishSafeFrame: (frame) =>
        useRecordingStore(applicationPinia()).publishSafeFrame(frame),
    });
    Object.assign(this, readShellElements());
    this._panelChrome = new PanelChrome({
      elements: {
        _leftPanelStack: this._leftPanelStack,
        _ppToggles: this._ppToggles,
        _rightPanelStack: this._rightPanelStack,
      },
      operations: {
        _closeLocationSearch: () => this._locationNavigation?.closeSearch(),
        _syncCctvPanelViewport: (...args) =>
          this._syncCctvPanelViewport(...args),
        _showToast: (...args) => this._showToast(...args),
      },
      readHud: () => this.hud,
      readCockpit: () => this.cockpitView,
      readShareLinks: () => this.shareLinkManager,
      readInitialShare: () => this._initialShareState,
      readScrollRestoreOwner: () => this._displayPortalScrollRestoreOwner,
      readDisplayScrollTop: () => this._standardDisplayScrollTop,
      readSharedCollapsed: (panelId) =>
        this._mobileShell?.sharedCollapsed(panelId),
    });
    // Vue views share this runtime and its stores; dispose unmounts them.
    this._ui = createUiRuntime({ pinia: applicationPinia() });
    this._feedback = new ShellFeedback({
      readLayers: () => withPlacePacks(this._dataManager?.getAll?.() || []),
    });
    // The satellite owner flags load with the app, not on the first ride.
    preloadOwnerFlags();
    // The place names under a Cockpit load on its first lookup: the loading
    // status names them meanwhile.
    this._offPlacePacks = onPlacePacksLoadingChange(() =>
      this._updateGlobalLoadingFeedback(),
    );
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
      settleSearch: (options) =>
        this._locationNavigation?.settleSearch(options),
      interruptCameraMotion: services.interruptCameraMotion,
      interruptGlobeRotation: services.interruptGlobeRotation,
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
      applyFollowOffset: (entity, offset) =>
        applyShareFollowOffset(viewer, entity, offset),
    });

    this._visualSettings = new VisualSettings({
      viewer,
      mapStackController,
      services: {
        setScopeTerminusOverride: services.setScopeTerminusOverride,
        clampScopeTerminusPct: services.clampScopeTerminusPct,
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
        _ppToggles: this._ppToggles,
        _sliderPanel: this._sliderPanel,
      },
      operations: {
        _restorePanelState: (...args) => this._restorePanelState(...args),
        _layoutRightPanels: (...args) => this._layoutRightPanels(...args),
        _scheduleAdaptivePanelLayout: (...args) =>
          this._scheduleAdaptivePanelLayout(...args),
        _scheduleRightPanelLayout: (...args) =>
          this._scheduleRightPanelLayout(...args),
        _setCockpitDisclosure: (...args) => this._setCockpitDisclosure(...args),
        _cockpitDisclosureOpen: (kind) => this._cockpitDisclosureOpen(kind),
        _setMapStack: (...args) => this._setMapStack(...args),
        _presentPanel: (...args) => this._presentPanel(...args),
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

    this._layerBindings = new LayerBindings({
      viewer,
      services: {
        imageryHost: () =>
          resolveImageryHost({
            viewer,
            tileset: mapStackController?.getImageryHostTileset?.(),
          }),
        cachedGroundFloor: services.cachedGroundFloor,
        warmGroundFloor: services.warmGroundFloor,
        cctvLayer: services.cctvLayer,
      },
      readControls: () => ({
        hud: this.hud,
        _contextControls: this._contextControls,
        _cctvControls: this._cctvControls,
        _radioControls: this._radioControls,
        _streetLevelControls: this._streetLevelControls,
      }),
      operations: {
        _updateTrafficSyncChip: (...args) =>
          this._updateTrafficSyncChip(...args),
        _updateGlobalLoadingFeedback: (...args) =>
          this._updateGlobalLoadingFeedback(...args),
        _syncContextModeButtons: (...args) =>
          this._syncContextModeButtons(...args),
        _stampNavigation: (...args) => this._stampNavigation(...args),
        _runExplicitCctvFocus: (...args) => this._runExplicitCctvFocus(...args),
        _runExplicitWorldFocus: (...args) =>
          this._runExplicitWorldFocus(...args),
        runImmediateNavigation: (...args) =>
          this.runImmediateNavigation(...args),
        _showToast: (...args) => this._showToast(...args),
      },
      feedback: this._feedback,
      shareRestoration: this._shareRestoration,
    });

    this._windowResizeHandler = null;
    this._disposed = false;

    this._mapStackChangeHandler = null;

    this._cockpitDisplayModeHandler = null;

    this._locationNavigation = new LocationNavigation({
      viewer,
      placeSearch,
      navigation: this._navigation,
      readCockpit: () => this.cockpitView,
      services: {
        CITY_POIS: services.CITY_POIS,
        searchAndFlyTo: services.searchAndFlyTo,
        LocationSearch: services.LocationSearch,
        OrbitController: services.OrbitController,
        suspendDetection: services.suspendDetection,
        resumeDetection: services.resumeDetection,
        trafficLayer: services.trafficLayer,
        flyToPresetLocation: services.flyToPresetLocation,
        flyToPOI: services.flyToPOI,
        GLOBE_VIEW: services.GLOBE_VIEW,
        flyToGlobeView: services.flyToGlobeView,
        interruptCameraMotion: services.interruptCameraMotion,
        interruptGlobeRotation: services.interruptGlobeRotation,
        flightsLayer: services.flightsLayer,
        militaryFlightsLayer: services.militaryFlightsLayer,
        satellitesLayer: services.satellitesLayer,
        aisLiveVesselsLayer: services.aisLiveVesselsLayer,
        militaryAwarenessLayer: services.militaryAwarenessLayer,
        rocketLaunchesLayer: services.rocketLaunchesLayer,
      },
      elements: {
        _locationSearch: this._locationSearch,
      },
      operations: {
        _publishLocation: (view) =>
          useLocationStore(applicationPinia()).publish(view),
        _connectLocation: (controls) =>
          useLocationStore(applicationPinia()).connect(controls),
        _connectGlobeReset: (controls) => this._connectGlobeReset(controls),
        _publishGlobeResetting: (busy) => this._publishGlobeResetting(busy),
        _beginDeferredNavigation: (...args) =>
          this._beginDeferredNavigation(...args),
        _reassertNavigationHandoff: (...args) =>
          this._reassertNavigationHandoff(...args),
        _settleLocationSearchUi: (...args) =>
          this._settleLocationSearchUi(...args),
        _runExplicitNavigation: (...args) =>
          this._runExplicitNavigation(...args),
        _stampNavigation: (...args) => this._stampNavigation(...args),
        _updateTrafficSyncChip: (...args) =>
          this._updateTrafficSyncChip(...args),
        _showToast: (...args) => this._showToast(...args),
      },
    });
    this._lastTrafficChipUpdateAt = 0;

    // Intel HUD
    const hudStore = useHudStore(applicationPinia());
    this.hud = new IntelHUD(viewer, {
      placeSearch,
      summaryService: requestServices?.summary,
      publish: (view) => hudStore.publish(view),
    });
    this._recording.hud = this.hud;
    this._cockpitCoordinator = new CockpitCoordinator({
      viewer,
      services: {
        flightsLayer: services.flightsLayer,
        militaryFlightsLayer: services.militaryFlightsLayer,
        aisLiveVesselsLayer: services.aisLiveVesselsLayer,
        satellitesLayer: services.satellitesLayer,
        // Orbit's Live Signals rows list and focus its mapped sites.
        militaryInstallationsLayer: services.militaryInstallationsLayer,
        isTr3b: services.isTr3b,
        toggleTr3b: services.toggleTr3b,
        militaryAwarenessLayer: services.militaryAwarenessLayer,
        cachedGroundFloor: services.cachedGroundFloor,
        cachedMeshFloor: services.cachedMeshFloor,
        GROUND_FLOOR_LIFT_M: services.GROUND_FLOOR_LIFT_M,
        meshFloorPreferred: services.meshFloorPreferred,
        warmGroundFloor: services.warmGroundFloor,
        sampleMeshFloorCells: services.sampleMeshFloorCells,
        holdContinuousRender: services.holdContinuousRender,
        releaseContinuousRender: services.releaseContinuousRender,
        fetchRegionalBrief: services.fetchRegionalBrief,
        regionalDistanceM: services.regionalDistanceM,
        weatherCodeLabel: services.weatherCodeLabel,
        // Orbit reads flat Esri imagery: Google 3D tiles stay coarse from
        // hundreds of kilometres up. The lease puts the map back on exit.
        acquireOrbitImagery: () =>
          this.mapStackController?.acquireImageryComparison?.({
            owner: 'cockpit-orbit',
            switchPolicy: 'esri-if-photoreal',
          }) ?? null,
      },
      elements: {
        _ppToggles: this._ppToggles,
        _cockpitDisplayPanel: this._cockpitDisplayPanel,
        _hudBtn: this._hudBtn,
        _detectionBtn: this._detectionBtn,
        _sliderPanel: this._sliderPanel,
        _models3dBtn: this._models3dBtn,
      },
      operations: {
        publishCockpit: {
          presence: (view) =>
            useCockpitStore(applicationPinia()).publishPresence(view),
          brief: (view) =>
            useCockpitStore(applicationPinia()).publishBrief(view),
          context: (view) =>
            useCockpitStore(applicationPinia()).publishContext(view),
          instruments: (view) =>
            useCockpitStore(applicationPinia()).publishInstruments(view),
          route: (view) =>
            useCockpitStore(applicationPinia()).publishRoute(view),
          vision: (view) =>
            useCockpitStore(applicationPinia()).publishVision(view),
          signals: (rows) =>
            useCockpitStore(applicationPinia()).publishSignals(rows),
          radar: (view) =>
            useCockpitStore(applicationPinia()).publishRadar(view),
          orbital: (view) =>
            useCockpitStore(applicationPinia()).publishOrbital(view),
          utilityLayout: (layout) =>
            useCockpitStore(applicationPinia()).publishUtilityLayout(layout),
        },
        publishCockpitPortal: (slots) =>
          useDisplayStore(applicationPinia()).publishCockpitPortal(slots),
        _layoutRightPanels: (...args) => this._layoutRightPanels(...args),
        _setCockpitVision: (...args) => this._setCockpitVision(...args),
        _stampNavigation: (...args) => this._stampNavigation(...args),
        getAircraftTrackingTarget: (...args) =>
          this.getAircraftTrackingTarget(...args),
        _scheduleRightPanelLayout: (...args) =>
          this._scheduleRightPanelLayout(...args),
      },
      readDataManager: () => this._dataManager,
      readContext: () => this.getContextModeState(),
      readActiveStyle: () => this.activeStyle,
      readUtilityDisclosureOpen: () =>
        this._cockpitDisclosureOpen('display') ||
        this._cockpitDisclosureOpen('radio'),
      enterPanels: () => this._panelChrome.enterCockpit(),
      exitPanels: () => this._panelChrome.exitCockpit(),
    });

    // Full-globe sun/moon ring. It is a crisp screen-space overlay above the
    // Cesium canvas but below the HUD/detection/readout z ladder.
    this.celestialRing = new CelestialRing(viewer, {
      enabled: false,
      store: useCelestialRingStore(applicationPinia()),
      onAutoDisable: () =>
        this.setCelestialRingEnabled(false, {
          syncShare: !!this.shareLinkManager,
          focus: false,
        }),
    });

    // Share Link Manager
    this.shareLinkManager = new ShareLinkManager(viewer, {
      onRestore: async (state) => {
        return this._visualSettings.restoreShareState(state);
      },
      isNavigationCurrent: (generation) =>
        generation === this._navigationGeneration,
      cancelOwnedNavigation: () => this.viewer.camera.cancelFlight(),
      // A host may open a share code without a `/share/<code>` address.
      initialShareCode,
    });
    this.shareLinkManager.setFollowSubjectProvider(({ nowMs }) =>
      readShareFollowSubject({ viewer: this.viewer, nowMs }),
    );
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
    // Parse before panel chrome initializes so every valid share URL starts
    // from deterministic markup defaults instead of recipient-local panel
    // preferences. Encoded panel fields are applied after all panels exist.
    this._shareRestoration.attachLinks(this.shareLinkManager);

    this._aircraftDisplay = new AircraftDisplay({
      elements: {
        _models3dBtn: this._models3dBtn,
      },
      readDataManager: () => this._dataManager,
      layout: () => this._layoutRightPanels(),
    });

    // The shared world-overlay host must own its one postRender lane before
    // detection and tracked-readout initialize. It stays transparent until a
    // production source explicitly registers entries.
    initWorldOverlay(viewer);
    // Its focusable mirror of the painted cards, which the scene chrome
    // renders.
    const overlayActionsStore = useWorldOverlayActionsStore(applicationPinia());
    overlayActionsStore.connect({ activate: activateWorldOverlayAction });
    this._overlayActionsUnsubscribe = subscribeWorldOverlayActions((view) =>
      overlayActionsStore.publish(view),
    );

    // Initialize detection overlay BEFORE style stages so the composite
    // stage is first in the post-process pipeline
    initDetection(
      viewer,
      [
        trafficLayer,
        flightsLayer,
        militaryFlightsLayer,
        localAdsbLayer,
        satellitesLayer,
        cctvLayer,
        bikeshareLayer,
        transitLayer,
        aisLiveVesselsLayer,
      ].filter(Boolean),
      (modeLabel) => {
        this._updateDetectionButton(modeLabel);
      },
    );
    initTrackedReadout(viewer);
    setDetectionStyle(this.activeStyle);
    this._setDetectionDensity();

    this._initStages();
    this._initBloomSharpen();
    this._displayBindings = new DisplayBindings({
      viewer,
      services: {
        cycleDetectionMode: services.cycleDetectionMode,
        isScopeMaskEnabled: services.isScopeMaskEnabled,
      },
      elements: {
        _locationSearch: this._locationSearch,
      },
      operations: {
        _closeLocationSearch: (options) =>
          this._locationNavigation?.closeSearch(options),
        setStyle: (...args) => this.setStyle(...args),
        _updateHudButtonState: (...args) => this._updateHudButtonState(...args),
        _syncShareState: (...args) => this._syncShareState(...args),
        _toggleOrbit: (...args) => this._toggleOrbit(...args),
        toggleCleanView: (...args) => this.toggleCleanView(...args),
        _toggleCctvEnabled: (...args) => this._toggleCctvEnabled(...args),
        _setBloomEnabled: (...args) => this._setBloomEnabled(...args),
        _setBloomIntensity: (...args) => this._setBloomIntensity(...args),
        _setSharpenEnabled: (...args) => this._setSharpenEnabled(...args),
        _setSharpenIntensity: (...args) => this._setSharpenIntensity(...args),
        _setHudVariant: (...args) => this._setHudVariant(...args),
        _setCyberSonarEnabled: (...args) => this._setCyberSonarEnabled(...args),
        _setCyberSonarSetting: (...args) => this._setCyberSonarSetting(...args),
        _setDetectionDensity: (...args) => this._setDetectionDensity(...args),
        _setDetectionAllocation: (...args) =>
          this._setDetectionAllocation(...args),
        _setDetectionFade: (...args) => this._setDetectionFade(...args),
        _setScope: (...args) => this._visualSettings._setScope(...args),
        setCelestialRingEnabled: (...args) =>
          this.setCelestialRingEnabled(...args),
        _setModels3dEnabled: (...args) => this._setModels3dEnabled(...args),
        _syncModels3dModeRow: (...args) => this._syncModels3dModeRow(...args),
        _setModels3dMode: (...args) => this._setModels3dMode(...args),
      },
      readState: () => ({
        shareLinkManager: this.shareLinkManager,
        hud: this.hud,
        bloomEnabled: this.bloomEnabled,
        sharpenEnabled: this.sharpenEnabled,
        celestialRing: this.celestialRing,
        celestialRingEnabled: this.celestialRingEnabled,
        _models3dEnabled: this._models3dEnabled,
      }),
      claimDetection: () => {
        this._visualSettings._detectionUserOverridden = true;
      },
    });
    this._initUI();
    this._initMapStackControl();
    this._initPanelChrome();
    this._panelNavigation = new PanelNavigation({
      ui: this._ui,
      stacks: { left: this._leftPanelStack, right: this._rightPanelStack },
      setPanelCollapsed: (...args) =>
        this._panelChrome.setPanelCollapsed(...args),
    });
    this._panelNavigation.init();
    this._initLocaleSelector();
    this._sizeDisplayLabelColumn();
    this._initLeftPanelAdaptiveLayout();
    this._initRightPanelAdaptiveLayout();
    this._initRadioPanel();
    this._initCctvPanel();
    this._initStreetLevelPanel();
    this._initWildlifeSightingCard();
    this._initGlobalContextPanel();
    this._initLocationBar();
    this._initMobileShell();
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
    this._publishActiveStyle();
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
    this._layerBindings.observeCamera();
  }

  // Compatibility reads for existing controls, scene snapshots and Cockpit.

  /** Advance camera authority and settle any older search UI immediately. */
  _stampNavigation({
    cancelPendingSelection = true,
    clearSearchedLocation = true,
  } = {}) {
    return this._navigation._stampNavigation(...arguments);
  }

  /** Release every follow owner while preserving Contact and vessel selection. */
  _releaseFollowCamera({
    preserveVesselSelection = true,
    preserveCameraFlight = false,
    trackingOrigin = 'tool',
  } = {}) {
    return this._navigation._releaseFollowCamera(...arguments);
  }

  /** Accept a delayed lookup without releasing its current camera owner. */
  _beginDeferredNavigation(
    noun = 'location',
    { cancelPendingSelection = true } = {},
  ) {
    return this._navigation._beginDeferredNavigation(...arguments);
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

  /** Apply a temporary cockpit-only CRT/NVG/FLIR/NOIR post-process override. */
  _setCockpitVision(mode, active, { revealParameters = false } = {}) {
    return this._visualSettings._setCockpitVision(...arguments);
  }

  /** Reveal shared style parameters, optionally opening Cockpit Display first. */
  _revealCockpitStyleParameters({ openDisplay = false } = {}) {
    return this._visualSettings._revealCockpitStyleParameters(...arguments);
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
   * Wires up all primary UI event listeners: style buttons, keyboard shortcuts
   * (1-8 style keys, H/O/V/F/D/C hotkeys, Escape), AI prompt input with
   * debounce, bloom/sharpen/HUD toggles, detection density slider, and
   * clean-view toggle.
   * @returns {void}
   */
  _initUI() {
    this._displayBindings._initUI();
  }

  /**
   * Publishes the language picker, which ProviderSettingsView renders. A
   * choice switches the page's language in place and is kept for the next
   * visit; the Display panel's label column is sized again for it.
   * @returns {void}
   */
  _initLocaleSelector() {
    this._lifetime.own(
      onLocaleChange(() => nextTick(() => this._sizeDisplayLabelColumn())),
    );
    // A host that does not initialize Core's locale shows no picker.
    if (this._localePickerEnabled === false) return;
    this._publishLocalePicker();
  }

  /**
   * @param {{focus?: boolean}} [options] Focus the picker's button, as after
   *   a choice: the picker is drawn again for the new language.
   */
  _publishLocalePicker({ focus = false } = {}) {
    useLocaleStore(applicationPinia()).publishPicker({
      current: getLocale(),
      onSelect: (locale) => this._chooseLocale(locale),
      focus,
    });
  }

  /**
   * Switch to `locale`: nothing for the active language, otherwise store it
   * and apply it to the page.
   * @param {string} locale
   * @returns {'unchanged'|'switched'}
   */
  _chooseLocale(locale) {
    return applyLocaleChoice(locale, {
      current: getLocale(),
      switchLocale: (next) => {
        setLocale(persistLocale(next));
        // Focus once, as the redrawn picker mounts; a later remount leaves
        // focus where it is.
        this._publishLocalePicker({ focus: true });
        void nextTick(() => this._publishLocalePicker());
      },
    });
  }

  /**
   * Sizes one Display-panel label column to the longest label in the active
   * language, so slider tracks line up. Counts characters (labels are
   * monospace and often hidden); CSS turns the count into a width.
   * @returns {void}
   */
  _sizeDisplayLabelColumn() {
    const labels = document.querySelectorAll(
      '#pp-toggles .pp-slider-row > .pp-slider-mini-label',
    );
    let longest = 0;
    for (const label of labels) {
      longest = Math.max(longest, label.textContent.trim().length);
    }
    if (longest > 0) {
      document.documentElement.style.setProperty(
        '--pp-label-chars',
        String(longest),
      );
    }
  }

  /**
   * Phone layout: a bottom tab bar presenting one panel sheet at a time
   * (src/ui/mobileShell.js). Inactive above 720px.
   * @returns {void}
   */
  _initMobileShell() {
    this._mobileShell = initMobileShell({
      setPanelCollapsed: (panelId, collapsed, options) =>
        this._panelChrome.setPanelCollapsed(panelId, collapsed, options),
      readPanel: (panel) => this._panelChrome._shownPanel(panel),
      onSheetsClosed: () => this._syncShareState(),
      onTabOpened: (sheet) => {
        void this._onMobileTabOpened(sheet);
      },
      publish: (view) =>
        useDisplayStore(applicationPinia()).publishPhoneShell(view),
      afterPublish: (callback) => {
        void nextTick(callback);
      },
    });
  }

  /** Reveal a tracked aircraft through Contacts when its phone tab is opened. */
  async _onMobileTabOpened(sheet) {
    const context = this.getContextModeState();
    if (
      sheet !== 'context' ||
      this._disposed ||
      !context ||
      context.mode ||
      context.changing ||
      context.entering ||
      !this.getAircraftTrackingTarget()
    )
      return false;
    try {
      const result = await this.setContextMode('contacts');
      if (result?.ok) return true;
      if (result?.cancelled || this._disposed) return false;
    } catch {
      if (this._disposed) return false;
    }
    this._showToast(
      t('Contacts could not complete the requested transition; try again'),
    );
    return false;
  }

  /**
   * Renders the owner-approved map stack chip row from the matching controller
   * entries. Cesium ion/Bing chips remain keyboard-focusable but unavailable,
   * with an accessible explanation, until a CESIUM_ION_TOKEN is configured.
   * @returns {void}
   */
  _initMapStackControl() {
    if (!this.mapStackController) return;

    const displayStore = useDisplayStore(applicationPinia());
    this._mapSourceControls?.destroy();
    displayStore.publishMapSource(null);
    this._mapSourceControls = createMapSourceControls({
      controller: this.mapStackController,
      publish: (view) => displayStore.publishMapSource(view),
      subscribe: (onChange) => {
        window.addEventListener('gev:map-stack-changed', onChange);
        return () =>
          window.removeEventListener('gev:map-stack-changed', onChange);
      },
      claimSelection: () => this.shareLinkManager?.claimRestoreLane?.('map'),
      onStateChanged: () => this._syncShareState(),
      onError: (message) => this._showToast(message),
    });
    displayStore.connectMapSource(this._mapSourceControls);
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

  _setDetectionAllocation(strategy, { syncShare = true, persist = true } = {}) {
    return this._visualSettings._setDetectionAllocation(...arguments);
  }

  /**
   * Pushes the current visual state (bloom, sharpen, HUD, detection) to
   * the ShareLinkManager so the URL hash stays in sync.
   * @returns {void}
   */

  _syncShareState() {
    if (this._disposed) return;
    this._shareState.publish({ type: 'settings-changed' });
  }

  _setCommandDockPanelPinState(
    panelId,
    pin,
    { restore = false, persist = true, syncShare = true } = {},
  ) {
    return this._panelChrome._setCommandDockPanelPinState(...arguments);
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

  _initGlobalContextPanel() {
    const {
      radioLayer,
      militaryInstallationsLayer,
      militaryAwarenessLayer,
      rocketLaunchesLayer,
    } = this.services;
    const contextStore = useContextStore(applicationPinia());
    this._contextControls = new ContextControls({
      elements: {
        _globalContextFlightsBtn: this._globalContextFlightsBtn,
        _globalContextMissionsBtn: this._globalContextMissionsBtn,
        _installationsSearchBtn: this._installationsSearchBtn,
      },
      installations: militaryInstallationsLayer,
      publish: (view) => contextStore.publish(view),
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
        setClearBusy: (busy) => this._publishClearBusy(busy),
      },
    });
    // The Contacts layer publishes its panel; the view calls its navigation.
    contextStore.connectAwareness(militaryAwarenessLayer);
    // A panel left by an earlier shell must not outlive its layer.
    this._awarenessPanelUnsubscribe?.();
    contextStore.publishAwareness(null);
    this._awarenessPanelUnsubscribe = militaryAwarenessLayer?.subscribePanel?.(
      (view) => contextStore.publishAwareness(view),
    );
    // And its compass and contact bearings, which the scene chrome renders.
    const awarenessDirectionStore =
      useAwarenessDirectionStore(applicationPinia());
    this._awarenessDirectionUnsubscribe?.();
    awarenessDirectionStore.publish(null);
    this._awarenessDirectionUnsubscribe =
      militaryAwarenessLayer?.subscribeDirectionOverlay?.((view) =>
        awarenessDirectionStore.publish(view),
      );
    // The Space Missions layer publishes its roster and selected mission.
    contextStore.connectMissions(rocketLaunchesLayer);
    this._missionsPanelUnsubscribe?.();
    contextStore.publishMissions(null);
    this._missionsPanelUnsubscribe = rocketLaunchesLayer?.subscribePanel?.(
      (view) => contextStore.publishMissions(view),
    );
    // And its replay vehicle overlay, which the scene chrome renders.
    const missionReplayStore = useMissionReplayStore(applicationPinia());
    this._missionReplayUnsubscribe?.();
    missionReplayStore.publish(null);
    this._missionReplayUnsubscribe =
      rocketLaunchesLayer?.subscribeReplayOverlay?.((view) =>
        missionReplayStore.publish(view),
      );
  }

  /** Wire the independent Radio companion controls. */
  _initRadioPanel() {
    const { radioLayer } = this.services;
    this._radioControls?.destroy();
    this._radioControls = new RadioControls({
      elements: {
        _cockpitDisplayToggleBtn: this._cockpitDisplayToggleBtn,
        _cockpitRadioEnableBtn: this._cockpitRadioEnableBtn,
        _cockpitRadioToggleBtn: this._cockpitRadioToggleBtn,
        _cockpitUtilityControls: this._cockpitUtilityControls,
        _radioEnableBtn: this._radioEnableBtn,
        _radioLayerState: this._radioLayerState,
        _radioPanel: this._radioPanel,
        _radioPlaybackState: this._radioPlaybackState,
        _radioStationHomepage: this._radioStationHomepage,
        _radioStationMeta: this._radioStationMeta,
        _radioStationName: this._radioStationName,
        _radioStationTags: this._radioStationTags,
        _radioTunerSlider: this._radioTunerSlider,
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
        // An open local receiver keeps the shared Radio panel expanded.
        preservePanelStateDuringClear: () =>
          this._preservePanelStateDuringLayerClear ||
          Boolean(this._localSdrControls?.isActive()),
        scheduleLayout: () => this._scheduleRightPanelLayout(),
      },
    });
    this._localSdrControls?.destroy();
    this._localSdrControls = null;
    const receiver = this.services.localAdsbLayer?.receiver;
    if (receiver) {
      this._localSdrControls = new LocalSdrControls({
        document,
        receiver,
        feeds: this.services.localAdsbLayer?.feeds || null,
        radio: radioLayer,
        actions: {
          isLocalAdsbEnabled: () =>
            Boolean(this._dataManager?.isEnabled('local-adsb')),
          setLocalAdsbEnabled: (enabled) =>
            this._dataManager?.setEnabled('local-adsb', enabled, {
              origin: 'user',
            }),
          scheduleLayout: () => this._scheduleRightPanelLayout(),
        },
      });
    }
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

  /** Keep one compact card anchored to the selected wildlife sighting. */
  _initWildlifeSightingCard() {
    this._wildlifeSightingCard?.destroy();
    this._wildlifeSightingCard = null;
    const layer = this.services.wildlifeSightingsLayer;
    if (!layer) return;
    this._wildlifeSightingCard = createWildlifeSightingCard({
      layer,
      ui: this._ui,
      viewer: this.viewer,
    });
  }

  /** Compose the Street Level panel controls from its layer and application actions. */
  _initStreetLevelPanel() {
    const { streetLevelLayer } = this.services;
    this._streetLevelControls?.destroy();
    this._streetLevelControls = null;
    if (!this._streetLevelPanel || !streetLevelLayer) return;
    // Photo framing yields to newer navigation and releases tracking like
    // any deferred flight.
    streetLevelLayer.attachNavigation?.({
      begin: (noun) => this._beginDeferredNavigation(noun),
      reassert: (generation) => this._reassertNavigationHandoff(generation),
    });
    this._streetLevelControls = new StreetLevelControls({
      root: this._streetLevelPanel,
      layer: streetLevelLayer,
      actions: {
        isEnabled: () => this._dataManager?.isEnabled('street-level') === true,
        setEnabled: (enabled) =>
          this._dataManager?.setEnabled('street-level', enabled, {
            origin: 'user',
          }),
        setParams: (params, options) =>
          this._dataManager?.setLayerParams('street-level', params, options),
        setPanelCollapsed: (collapsed, options) =>
          this.setPanelCollapsed('street-level-panel', collapsed, options),
        showToast: (message) => this._showToast(message),
        // Lets the panel open for a user, voice or tool switch-on, not a restore.
        subscribeEnableRequests: (listener) =>
          this._dataManager?.subscribeVisibilityRequests?.((change) => {
            if (change?.layerId === 'street-level' && change.enabled)
              listener(change.origin);
          }) || null,
      },
    });
    this._streetLevelControls.connect();
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
        _cctvVideo: this._cctvVideo,
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
      },
      cctv: cctvLayer,
      viewer: this.viewer,
      actions: {
        isEnabled: () => this._dataManager?.isEnabled('cctv'),
        setParams: (params, options) =>
          this._dataManager?.setLayerParams('cctv', params, options),
        toggleEnabled: (...args) => this._toggleCctvEnabled(...args),
        runExplicitFocus: (...args) => this._runExplicitCctvFocus(...args),
        setPanelCollapsed: (...args) => this.setPanelCollapsed(...args),
        showToast: (message) => this._showToast(message),
        syncViewport: () => this._syncCctvPanelViewport(),
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
      this._showToast(t('CCTV layer unavailable'));
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
   * @param {'tactical'|'minimal'|'cyber'} variantName - Layout variant.
   * @returns {{ok: boolean, layout?: string, visible?: boolean, error?: string}}
   */
  setHudLayout(variantName) {
    const variant = String(variantName ?? '').toLowerCase();
    if (!isHudLayout(variant)) {
      return { ok: false, error: `Unknown HUD layout: ${variantName}` };
    }
    this.shareLinkManager?.claimRestoreLane?.('visual');
    this._setHudVariant(variant, { applyVisualDefaults: true });
    return {
      ok: true,
      layout: this.hud.getVariant(),
      visible: !!this.hud.visible,
    };
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

  /** Apply Cyber-only sonar settings through the shared visual controls. */
  setCyberSonar(settings) {
    return setCyberSonarControls(this, settings);
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
        sonar: getCyberSonarControlState(globalThis.document, {
          hudActive: this.hud ? !!this.hud.visible : undefined,
        }),
      },
      detection: this.getDetectionState(),
      bloom: {
        enabled: !!this.bloomEnabled,
        intensityPct: this._visualSettings.bloomIntensityPct,
      },
      sharpen: {
        enabled: !!this.sharpenEnabled,
        intensityPct: this._visualSettings.sharpenIntensityPct,
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
   * Applies recording-friendly post-processing and shader uniform overrides.
   * @param {object} preset
   */
  applyCinematicPreset(preset = {}) {
    return this._visualSettings.applyCinematicPreset(...arguments);
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

  // ── Style switching ───────────────────────────

  /**
   * Switches the active visual style. Handles full lifecycle:
   * 1. Crossfades the previous shader stage intensity to 0.
   * 2. Crossfades the new shader stage intensity to 1.
   * 3. Applies style preset defaults (bloom/sharpen/HUD) if applyPreset is true.
   * 4. Updates button highlights, style indicator, slider panel, HUD, and detection overlay.
   * @param {string} styleName - Target style ('normal'|'retro'|'surveillance'|'thermal'|'anime'|'noir').
   * @param {object} [options]
   * @param {boolean} [options.applyPreset=true] - Whether to apply STYLE_PRESET_DEFAULTS for the new style.
   * @param {boolean} [options.userInitiated=false] - Whether a direct user preset choice owns the Cyber exit style.
   * @param {boolean} [options.preserveCyberRestore=false] - Whether an automatic style update keeps the Cyber entry snapshot.
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
    return this._visualSettings.setStyle(...arguments);
  }

  // ── Shader transitions ────────────────────────

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
   * Answer the top-center action that clears only manager-owned data layers;
   * the caller owns its transaction, and the button stays focusable while it
   * runs.
   */
  _initClearSelectedLayersButton() {
    const store = useGlobeActionsStore(applicationPinia());
    if (this._clearLayersToken) store.detach(this._clearLayersToken);
    this._clearLayersToken = store.connect({
      clear: () => {
        if (!this._disposed) void this.clearSelectedLayers();
      },
    });
    // A clear under way as the shell connects again stays on the button.
    if (this._clearBusy != null)
      store.publishClearBusy(this._clearLayersToken, this._clearBusy);
  }

  /**
   * Publish this shell's clear under way; the button shows it while this
   * shell answers the clear.
   */
  _publishClearBusy(busy) {
    if (this._disposed) return;
    this._clearBusy = Boolean(busy);
    if (this._clearLayersToken)
      useGlobeActionsStore(applicationPinia()).publishClearBusy(
        this._clearLayersToken,
        busy,
      );
  }

  /**
   * Answer the globe and cockpit reset buttons through the location controls,
   * or stop answering them (null).
   */
  _connectGlobeReset(controls) {
    const store = useGlobeActionsStore(applicationPinia());
    if (this._resetToken) store.detach(this._resetToken);
    this._resetToken = controls
      ? store.connect({ reset: () => controls.reset() })
      : null;
    // A reset under way as the controls are replaced stays on the buttons.
    if (this._resetToken && this._globeResetting != null)
      store.publishResetting(this._resetToken, this._globeResetting);
  }

  /** Publish a reset to the full globe view under way. */
  _publishGlobeResetting(busy) {
    if (this._disposed) return;
    this._globeResetting = Boolean(busy);
    if (this._resetToken)
      useGlobeActionsStore(applicationPinia()).publishResetting(
        this._resetToken,
        busy,
      );
  }

  /**
   * Stop answering the globe actions. Its clear under way goes with its
   * owner, and its camera state too; a newer shell's stays.
   */
  _releaseGlobeActions() {
    const store = useGlobeActionsStore(applicationPinia());
    if (store.owns(this._orientationToken, 'tilt')) store.publishCamera(null);
    if (this._clearLayersToken) store.detach(this._clearLayersToken);
    if (this._shareToken) store.detach(this._shareToken);
    if (this._orientationToken) store.detach(this._orientationToken);
    if (this._resetToken) store.detach(this._resetToken);
    this._clearLayersToken = this._shareToken = this._orientationToken = null;
    this._resetToken = null;
  }

  /** Wire Google Maps-style tilt and north-up camera actions. */
  _initCameraOrientationControls() {
    const store = useGlobeActionsStore(applicationPinia());
    this._cameraOrientationControls?.destroy();
    if (this._orientationToken) store.detach(this._orientationToken);
    const token = store.connect({
      tilt: () => controls.tilt(),
      northUp: () => controls.northUp(),
    });
    this._orientationToken = token;
    // A newer shell's controls own what the buttons show.
    const controls = bindCameraOrientationControls({
      viewer: this.viewer,
      // Every drawn frame publishes: a state the store already shows stops
      // here, before the store's actions run.
      publish: (state) => {
        const shown = store.camera;
        if (shown?.tilted === state.tilted && shown.heading === state.heading)
          return;
        if (store.owns(token, 'tilt')) store.publishCamera(state);
      },
      runNavigation: (noun, navigate) =>
        this._navigation.runOrientation(noun, navigate),
      showToast: (message) => this._showToast(message),
    });
    this._cameraOrientationControls = controls;
  }

  // ── Share Button ─────────────────────────────

  /**
   * Wires the share button. By default it copies the current share link to the
   * clipboard; a host may pass `services.shareLink(url)` to share it another way
   * (a system share sheet, for example). It resolves to 'shared', 'copied',
   * 'cancelled' (no toast) or false (failed).
   * @returns {void}
   */
  _initShareButton() {
    const store = useGlobeActionsStore(applicationPinia());
    if (this._shareToken) store.detach(this._shareToken);
    this._shareToken = store.connect({ share: () => this._share() });
  }

  /** Share or copy the current link, then say how it went. */
  async _share() {
    if (this._disposed) return;
    const share = this.services.shareLink;
    let result;
    if (typeof share === 'function') {
      // A host's hook may return a plain value or throw; both are answers.
      result = await Promise.resolve()
        .then(() => {
          const href = this.shareLinkManager.buildLink();
          return href ? share(href) : false;
        })
        .catch(() => false);
    } else {
      result = (await this.shareLinkManager.copyLink()) ? 'copied' : false;
    }
    if (this._disposed || result === 'cancelled') return;
    this._showToast(
      result === 'shared'
        ? t('Link shared')
        : result === 'copied'
          ? t('Link copied!')
          : t('Copy failed'),
    );
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

  _initHUDToggle() {
    this._setHudVariant('tactical');
    this.hud.setMode('on');
    this._updateHudButtonState();

    this._lifetime.listen(this._cockpitDisplayToggleBtn, 'click', () => {
      this._setCockpitDisclosure?.(
        'display',
        !this._cockpitDisclosureOpen('display'),
      );
    });
    this._initCockpitDisplayPortal();
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

  /** Terminal result for the complete initial share restoration. */
  get initialRestorePromise() {
    return (
      this._initialShareRestorePromise ||
      Promise.resolve({ status: 'not-requested' })
    );
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
    this._feedback.clearLoadingStatus();
    this._disposed = true;
    this._navigation.stop();
    this._shareState.destroy();
    this._locationNavigation.destroy();
    this._lifetime.destroy();
    useLocaleStore(applicationPinia()).publishPicker(null);
    this._recording.destroy();
    this._mobileShell?.destroy();
    this._panelNavigation?.destroy();
    this._wildlifeSightingCard?.destroy();
    this._ui.destroy();
    this._panelChrome.destroy();
    this._offPlacePacks();
    this._feedback.destroy();

    this._displayBindings.destroy();
    this._mapSourceControls?.destroy();
    useDisplayStore(applicationPinia()).connectMapSource(null);
    useDisplayStore(applicationPinia()).publishMapSource(null);
    this._cameraOrientationControls?.destroy();
    this._releaseGlobeActions();
    this._cctvControls?.destroy();
    this.services?.streetLevelLayer?.attachNavigation?.(null);
    this._streetLevelControls?.destroy();
    this._radioControls?.destroy();
    this._localSdrControls?.destroy();
    this._awarenessPanelUnsubscribe?.();
    this._awarenessPanelUnsubscribe = null;
    this._awarenessDirectionUnsubscribe?.();
    this._awarenessDirectionUnsubscribe = null;
    useAwarenessDirectionStore(applicationPinia()).publish(null);
    this._missionsPanelUnsubscribe?.();
    this._missionsPanelUnsubscribe = null;
    this._missionReplayUnsubscribe?.();
    this._missionReplayUnsubscribe = null;
    useMissionReplayStore(applicationPinia()).publish(null);
    const contextStore = useContextStore(applicationPinia());
    contextStore.connectAwareness(null);
    contextStore.publishAwareness(null);
    contextStore.connectMissions(null);
    contextStore.publishMissions(null);
    this._cockpitCoordinator.stop();
    this._visualSettings.stop();
    this.shareLinkManager?.destroy();
    this._layerBindings.stop();

    // Invalidate any in-flight Context transaction the same way a newer request
    // would. Without this, a reinstatement already past its awaits could
    // re-enable a mode's entry layer and republish `_contextMode` while the
    // rest of teardown is tearing those very layers down.
    this._contextControls.stop();
    this._navigation.destroy();
    // Close camera-entry seams synchronously. Context restoration may await
    // layer work, so leaving these listeners attached until afterward lets a
    // focus event release tracking or start a flight during teardown.
    await this._contextControls.restoreForDisposal();
    // IR boost teardown BEFORE detaching the data manager: restore fog and
    // un-boost both aircraft layers so a surviving viewer or replacement
    // manager doesn't inherit sensor state (review P2, 2026-08-16).
    this._visualSettings.releaseIrBoost();
    this._cockpitCoordinator.destroy();
    this._contextControls.disconnect();
    this._layerBindings.disconnect();

    if (this._windowResizeHandler) {
      window.removeEventListener('resize', this._windowResizeHandler);
      this._windowResizeHandler = null;
    }
    destroyTrackedReadout();
    destroyDetection();
    this._overlayActionsUnsubscribe?.();
    this._overlayActionsUnsubscribe = null;
    destroyWorldOverlay();
    const overlayActionsStore = useWorldOverlayActionsStore(applicationPinia());
    overlayActionsStore.connect(null);
    overlayActionsStore.publish(null);
    this.celestialRing?.destroy();
    this._visualSettings.destroy();
  }
}
