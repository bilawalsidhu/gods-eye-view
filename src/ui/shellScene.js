import { createSceneHost } from '../app/sceneHost.js';
import { useWorldOverlayActionsStore } from './stores/worldOverlayActions.js';
import { renderGovernorFor } from '../renderGovernor.js';
import { retainsLayerSession } from '../app/layerSession.js';
import { LayerBindings } from './layerBindings.js';
import { VisualSettings } from './visualSettings.js';
import { ShareRestoration } from './shareRestoration.js';
import { CockpitCoordinator } from './cockpitCoordinator.js';
import { useCelestialRingStore } from './stores/celestialRing.js';
import {
  applyPendingVisualChoices,
  pendingVisualSettings,
} from './pendingVisualSettings.js';
import { ShellFacade } from './shellFacade.js';
import { applyShareFollowOffset } from './shareFollow.js';
import { applicationPinia } from './vueRuntime.js';
import { useCockpitStore } from './stores/cockpit.js';
import { useDisplayStore } from './stores/display.js';
import { useGlobeActionsStore } from './stores/globeActions.js';

/** Globe-bound composition kept separately from the page shell. */
export class ShellScene extends ShellFacade {
  // ── Scene attachment ──────────────────────────────────────────────────
  // The shell lives for the page; an engine switch only rebuilds the parts
  // bound to one globe (share restoration, visual effects, layer bindings,
  // Cockpit, the celestial ring, the overlay host, detection, the map-source
  // and camera-orientation controls) and points the kept ones (navigation,
  // location search, HUD, share link, display bindings) at the next globe.

  /** Share restoration, visual settings and layer bindings of this globe. */
  _buildSceneControls() {
    const { viewer, engine, mapStackController } = this._scene;
    const services = {
      ...this.services,
      ...renderGovernorFor(this._scene.engine),
    };
    const layerSession = this._layerSession;
    this._shareRestoration = new ShareRestoration({
      engine,
      canvas: engine?.host.canvas ?? viewer?.canvas,
      handoff: layerSession?.handoff,
      navigation: this._navigation,
      syncShareState: () => this._syncShareState(),
      syncModels3d: (state) => this._syncModels3dFromLayerState(state),
      showStatus: (message, options) =>
        this._showGlobalStatusNotice(message, options),
      feedback: this._feedback,
      updateFeedback: () => this._updateGlobalLoadingFeedback(),
      applyFollowOffset: (handle, offset) =>
        applyShareFollowOffset(engine, handle, offset),
    });

    this._visualSettings = new VisualSettings({
      viewer,
      engine,
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
      engine,
      services: {
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
  }

  /** Cockpit and the celestial ring of this globe. */
  _buildSceneCockpit() {
    const { viewer, engine } = this._scene;
    const services = {
      ...this.services,
      ...renderGovernorFor(this._scene.engine),
    };
    const { CelestialRing } = services;
    this._cockpitCoordinator = new CockpitCoordinator({
      viewer,
      engine,
      services: {
        flightsLayer: services.flightsLayer,
        militaryFlightsLayer: services.militaryFlightsLayer,
        aisLiveVesselsLayer: services.aisLiveVesselsLayer,
        satellitesLayer: services.satellitesLayer,
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

    // Full-globe sun/moon ring on either engine, below the HUD/readout.
    this.celestialRing = new CelestialRing(viewer ?? engine, {
      engine,
      enabled: false,
      store: useCelestialRingStore(applicationPinia()),
      onAutoDisable: () =>
        this.setCelestialRingEnabled(false, {
          syncShare: !!this.shareLinkManager,
          focus: false,
        }),
    });
  }

  /** The world-overlay host, detection and post-process stages of this globe. */
  _initSceneOverlays() {
    const { engine } = this._scene;
    const {
      worldOverlayFor,
      initDetection,
      initTrackedReadout,
      setDetectionStyle,
      trafficLayer,
      flightsLayer,
      militaryFlightsLayer,
      localAdsbLayer,
      satellitesLayer,
      cctvLayer,
      bikeshareLayer,
      transitLayer,
      aisLiveVesselsLayer,
    } = this.services;
    // The shared world-overlay host must own its one postRender lane before
    // detection and tracked-readout initialize. It stays transparent until a
    // production source explicitly registers entries.
    worldOverlayFor(engine).init();
    const overlayActionsStore = useWorldOverlayActionsStore(applicationPinia());
    this._overlayActionsUnsubscribe?.();
    overlayActionsStore.connect({
      activate: (...args) =>
        this.services.worldOverlayFor(engine).activateAction(...args),
    });
    this._overlayActionsUnsubscribe = this.services
      .worldOverlayFor(engine)
      .subscribeActions((view) => overlayActionsStore.publish(view));
    // Initialize detection overlay BEFORE style stages so the composite
    // stage is first in the post-process pipeline. Both run on the engine,
    // Navara's too.
    {
      initDetection(
        engine,
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
      initTrackedReadout(engine);
    }
    setDetectionStyle(this.activeStyle);
    this._setDetectionDensity();

    this._initStages();
    this._initBloomSharpen();
  }

  /**
   * Attach the shell to another globe (an engine switch): `{ viewer, engine,
   * mapStackController, services }`, where `services` are that catalog's
   * layer roles. The shell, its stores, open panels, typed text and focus
   * stay; the parts bound to a globe are built for this one and the
   * address's view is restored on it.
   */
  attachScene(options = {}, transaction) {
    this._sceneHost ??= createSceneHost();
    return this._sceneHost.run(() => this._attachScene(options), transaction);
  }

  async _attachScene({
    viewer = null,
    engine = null,
    mapStackController = null,
    services = {},
    engineSwitch = true,
  } = {}) {
    if (this._disposed) return;
    if (this._scene.engine === engine && this._scene.viewer === viewer) return;
    if (this._scene.engine)
      throw new Error('The shell is attached to a globe already');
    // An attachment that fails part-way releases what it built: the shell
    // stays detached, ready for the working engine.
    try {
      const previousServices = this.services;
      this.services = { ...this.services, ...services };
      this._scene = { viewer, engine, mapStackController };
      const {
        flightsLayer,
        militaryFlightsLayer,
        satellitesLayer,
        aisLiveVesselsLayer,
        militaryAwarenessLayer,
        rocketLaunchesLayer,
      } = this.services;
      this._navigation.tracking = {
        flightsLayer,
        militaryFlightsLayer,
        satellitesLayer,
        aisLiveVesselsLayer,
        militaryAwarenessLayer,
        rocketLaunchesLayer,
      };
      this._navigation.setScene({ engine });
      this._locationNavigation.attachScene({ engine });
      this.hud.attachEngine(engine, { viewer });
      this.shareLinkManager.attachEngine(engine);
      this._displayBindings.attachEngine(engine);
      this._buildSceneControls();
      this._buildSceneCockpit();
      this._shareRestoration.attachLinks(this.shareLinkManager);
      this._initSceneOverlays();
      this._initMapStackControl();
      this._refreshLayerControls(previousServices);
      this._cctvControls?.attachEngine(engine);
      this._initCameraOrientationControls();
      this._initHudScene();
      this._initCockpitDisplayPortal();
      this._applyGlobalPostDefaults();
      this._startAnimationLoop();
      this._publishActiveStyle();
      this._shareRestoration.start({
        engineSwitch,
        retainScene: Boolean(this._layerSession?.handoff),
      });
      this._layerBindings.observeCamera();
      this._layoutRightPanels();
      this._syncCctvPanelViewport();
      // Choices made between the engines apply once this engine restored
      // the address's view: the person's choice wins over the link.
      const pending = this._pendingVisual?.queue;
      this._pendingVisual = null;
      if (pending?.length) {
        const settings = this._visualSettings;
        void this.initialRestorePromise.then(() => {
          if (!this._disposed && this._visualSettings === settings)
            applyPendingVisualChoices(settings, pending);
        });
      }
    } catch (error) {
      await this._detachScene().catch((cleanupError) =>
        console.error(
          'The shell could not leave a failed globe:',
          cleanupError,
        ),
      );
      throw error;
    }
  }

  /**
   * Detach the shell from its globe (an engine switch, or the page going).
   * The parts bound to that globe are released; the shell, its stores and
   * the open panels stay. `handoff` keeps the selection and a retainable
   * Context mode for the next globe.
   */
  detachScene(options = {}, transaction) {
    this._sceneHost ??= createSceneHost();
    return this._sceneHost.run(() => this._detachScene(options), transaction);
  }

  async _detachScene({
    handoff = retainsLayerSession(this._layerSession),
  } = {}) {
    if (!this._scene.engine && !this._scene.viewer) return;
    const { destroyTrackedReadout, worldOverlayFor, destroyDetection } =
      this.services;
    this._shareRestoration.destroy();
    this._navigation.setScene({}, { retainScene: handoff });
    this._layerBindings.stop();
    this._cockpitCoordinator.stop();
    this._visualSettings.stop();
    // A Context mode that cannot be carried to the next globe (a transition
    // in flight) restores the layers it changed, as a teardown does.
    if (!this._contextControls.canRetainScene()) {
      this._contextControls._contextModeGeneration++;
      await this._contextControls.restoreForDisposal();
      this._contextControls._contextModeChanging = false;
    }
    // IR boost teardown BEFORE detaching the data manager: restore fog and
    // un-boost both aircraft layers so the next globe does not inherit
    // sensor state.
    this._visualSettings.releaseIrBoost();
    this._cockpitCoordinator.destroy();
    this._layerBindings.disconnect();
    this._cctvControls?.attachEngine(null);
    destroyTrackedReadout(this._scene.engine);
    destroyDetection();
    worldOverlayFor(this._scene.engine).destroy();
    this._overlayActionsUnsubscribe?.();
    this._overlayActionsUnsubscribe = null;
    this.celestialRing?.destroy();
    this.celestialRing = null;
    this._visualSettings.destroy();
    // Until the next globe: choices wait for it (pendingVisualSettings.js),
    // and the map-source chips and camera buttons answer nothing.
    this._pendingVisual = pendingVisualSettings(this._visualSettings);
    this._visualSettings = this._pendingVisual.settings;
    this._mapSourceControls?.destroy();
    this._mapSourceControls = null;
    useDisplayStore(applicationPinia()).connectMapSource(null);
    this._cameraOrientationControls?.destroy();
    this._cameraOrientationControls = null;
    if (this._orientationToken)
      useGlobeActionsStore(applicationPinia()).detach(this._orientationToken);
    this._orientationToken = null;
    this._displayBindings.attachEngine(null);
    this._locationNavigation.detachScene();
    this.hud.attachEngine(null);
    this.shareLinkManager.attachEngine(null);
    this._scene = { viewer: null, engine: null, mapStackController: null };
  }

  /**
   * Rebuild a panel's controls whose layer is another instance in the new
   * catalog (a layer this engine left out, then shows). Layers the session
   * keeps are the same instances, so their controls stay.
   */
  _refreshLayerControls(previous) {
    const changed = (...roles) =>
      roles.some((role) => previous?.[role] !== this.services[role]);
    if (changed('cctvLayer')) this._initCctvPanel();
    if (changed('radioLayer', 'localAdsbLayer')) this._initRadioPanel();
    if (changed('streetLevelLayer')) this._initStreetLevelPanel();
    this._initWildlifeSightingCard();
    if (
      changed(
        'radioLayer',
        'militaryInstallationsLayer',
        'militaryAwarenessLayer',
        'rocketLaunchesLayer',
      )
    ) {
      this._contextControls.stop();
      this._contextControls.disconnect();
      this._initGlobalContextPanel();
    }
  }
}
