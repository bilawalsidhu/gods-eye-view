/** Coordinate Cockpit lifecycle through supplied aircraft, terrain, rendering and briefing operations. */
import {
  readAircraftInfo,
  readSatelliteInfo,
  readVesselInfo,
  readSubjectLayerId,
  resolveEntryKind,
  dispatchCockpitModeChanged,
  toggleTrackedTr3b,
  syncTr3bToggle,
  syncEntry,
  publishPresenceView,
  navigateContext,
  _adoptTrackedEntity,
  enter,
  exit,
} from './cockpitTrackingController.js';
import { update } from './cockpitCamera.js';
import {
  beginOrbital,
  endOrbital,
  resetOrbitalLook,
  jumpToSensorSwath,
  onOrbitalWheel,
  stepOrbitalZoom,
  turnOrbitalLook,
  updateOrbital,
  updateOrbitalHud,
} from './cockpitOrbitalView.js';
import {
  onOrbitalClick,
  onOrbitalDoubleClick,
  routeSceneClick,
  toggleOrbitalFocus,
} from './cockpitOrbitalFocus.js';
import {
  handleOrbitalSignalClick,
  refreshOrbitalSignals,
  updateOrbitalSignals,
} from './cockpitOrbitalSignals.js';
import { rideOrbitalSatellite } from './cockpitOrbitalSatellites.js';
import {
  publishInstrumentsView,
  publishRouteView,
  updateHud,
  updateRoute,
  updateRadar,
  presentLook,
  syncWeatherToggle,
  setVisionMode,
  cycleVisionMode,
  clearPredictiveRoute,
} from './cockpitInstruments.js';
import {
  publishContextView,
  showContextCard,
  updateContext,
} from './cockpitContext.js';
import { createContextState } from './cockpitContextState.js';
import { createBriefState } from './cockpitBriefPages.js';
import {
  createInstrumentState,
  createRouteState,
  createVisionState,
} from './cockpitInstrumentState.js';
import { onLocaleChange } from '../i18n/index.js';
import {
  publishBriefView,
  showBriefPage,
  setBriefAutoRotate,
  startBriefRotation,
  stopBriefRotation,
  updateLocalPosition,
  maybeRefreshRegionalBrief,
  renderRegionalBriefStatus,
  renderRegionalBrief,
  relocalizeBrief,
} from './cockpitBriefing.js';
import {
  dropCockpitSignal,
  dropContextSnapshotSignals,
  handleSignalClick,
  publishCockpitSignals,
  pushCockpitSignal,
  updateCockpitSignals,
} from './cockpitSignals.js';
import {
  scheduleContextLayout,
  setContextCollapsed,
  setSignalCollapsed,
  syncContextLayout,
  syncSignalLayout,
} from './cockpitLayout.js';
import {
  onKeyDown,
  onSceneDoubleClick,
  onScenePointerDown,
  routeSceneDoubleClick,
} from './cockpitInput.js';
import { DEFAULT_RADAR_RANGE_NM, nextRadarRange } from '../cockpitRadar.js';
import { VESSEL_BRIDGE_PITCH_DEG } from '../cockpitSubjects.js';
import { stepLook } from '../cockpitLook.js';
import * as Cesium from 'cesium';

/** Whether the user asked for reduced motion: look turns then jump. */
function prefersReducedMotion() {
  return Boolean(
    globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches,
  );
}

export class CockpitViewController {
  constructor(
    viewer,
    {
      services,
      onVisionChange = null,
      getInitialVisionMode = null,
      onCameraTakeover = null,
      isEntryAllowed = null,
      isBridgeEntryAllowed = null,
      isOrbitEntryAllowed = null,
      isUtilityDisclosureOpen = null,
      onEntered = null,
      onExited = null,
      onRide = null,
      restoreTrackingFrame = null,
      publish = {},
    } = {},
  ) {
    this.viewer = viewer;
    this.services = services;
    this.destroyed = false;
    this.disposed = false;
    this.active = false;
    /**
     * 'aircraft', 'vessel' or 'satellite' while active; which subject the
     * camera rides.
     */
    this.subjectKind = null;
    /**
     * The vessel subject's id or the satellite's NORAD id; aircraft are
     * identified by trackedEntity.
     */
    this.subjectId = null;
    /**
     * The orbital view's zoom, look and saved field of view while a
     * satellite is ridden (src/ui/cockpitOrbitalView.js); null otherwise.
     */
    this.orbital = null;
    this.trackedEntity = null;
    this.trackedEntityWasShown = true;
    this.heading = null;
    this.lastFrameMs = 0;
    this.lastCameraUpdateMs = 0;
    this.lastHudUpdateMs = 0;
    this.lastContextUpdateMs = 0;
    this.lastGroundProbeMs = 0;
    this.contextNavigationDeadlineMs = 0;
    this.surfaceWaitStartedMs = 0;
    this.surfaceAcquiring = false;
    this.surfaceFallback = false;
    /**
     * Where the bridge view is turned to (`lookTarget`) and where the camera
     * looks on its way there (`lookView`): yaw off the bow, starboard
     * positive, and absolute pitch. Aircraft never turn it.
     */
    this.lookTarget = { yawDeg: 0, pitchDeg: VESSEL_BRIDGE_PITCH_DEG };
    this.lookView = { ...this.lookTarget };
    this.lookLastMs = 0;
    this.entry = document.getElementById('cockpit-entry');
    this.tr3bToggle = document.getElementById('tr3b-toggle');
    this._tr3bSignature = null;
    this.mapViewButton = document.getElementById('map-view-switch');
    this.hud = document.getElementById('cockpit-hud');
    this.entryFocusOrigin = null;
    this.visionPrevious = document.getElementById('cockpit-vision-previous');
    this.visionCurrent = document.getElementById('cockpit-vision-current');
    this.visionNext = document.getElementById('cockpit-vision-next');
    this.visionMode = 'optical';
    this.onVisionChange = onVisionChange;
    this.getInitialVisionMode =
      typeof getInitialVisionMode === 'function'
        ? getInitialVisionMode
        : () => 'optical';
    this.onCameraTakeover = onCameraTakeover;
    this.onEntered = onEntered;
    this.onExited = onExited;
    this.onRide = onRide;
    this.restoreTrackingFrame =
      typeof restoreTrackingFrame === 'function'
        ? restoreTrackingFrame
        : () => false;
    this.isEntryAllowed =
      typeof isEntryAllowed === 'function' ? isEntryAllowed : () => true;
    // Without a supplied gate there is no vessel layer to ride either.
    this.isBridgeEntryAllowed =
      typeof isBridgeEntryAllowed === 'function'
        ? isBridgeEntryAllowed
        : () => false;
    // Nor a satellite layer to ride without one.
    this.isOrbitEntryAllowed =
      typeof isOrbitEntryAllowed === 'function'
        ? isOrbitEntryAllowed
        : () => false;
    this.isUtilityDisclosureOpen =
      typeof isUtilityDisclosureOpen === 'function'
        ? isUtilityDisclosureOpen
        : () => false;
    this.context = document.getElementById('cockpit-context');
    this.contextPrevious = document.getElementById('cockpit-context-previous');
    this.contextNext = document.getElementById('cockpit-context-next');
    this.contextToggle = document.getElementById('cockpit-context-toggle');
    this.weatherToggle = document.getElementById('cockpit-weather-toggle');
    this.contextCollapsed = false;
    this.signalStream = document.getElementById('cockpit-signal-stream');
    this.signalList = document.getElementById('cockpit-signal-list');
    this.signalToggle = document.getElementById('cockpit-signal-toggle');
    this.briefPrevious = document.getElementById('cockpit-brief-previous');
    this.briefNext = document.getElementById('cockpit-brief-next');
    this.briefAutoToggle = document.getElementById('cockpit-brief-auto');
    this.briefTabs = Array.from(
      document.querySelectorAll('[data-cockpit-brief-index]'),
    );
    this.signalCollapsed = false;
    this.signalUserCollapsed = false;
    this.signalItems = [];
    this.signalSignatures = new Map();
    this.briefPageIndex = 0;
    this.briefAutoRotateEnabled = false;
    // Cockpit's views render what these receive.
    this.publishPresence = publish.presence ?? (() => {});
    this.publishBrief = publish.brief ?? (() => {});
    this.publishContext = publish.context ?? (() => {});
    this.publishInstruments = publish.instruments ?? (() => {});
    this.publishRoute = publish.route ?? (() => {});
    this.publishVision = publish.vision ?? (() => {});
    this.publishSignals = publish.signals ?? (() => {});
    this.publishUtilityLayout = publish.utilityLayout ?? (() => {});
    this.publishRadar = publish.radar ?? (() => {});
    this.publishOrbital = publish.orbital ?? (() => {});
    /** The bridge radar's range in nautical miles; kept across bridges. */
    this.radarRangeNm = DEFAULT_RADAR_RANGE_NM;
    this.presence = {
      active: false,
      entryAvailable: false,
      // Which subject the entry button would enter, and the active subject.
      entryKind: null,
      subjectKind: null,
      tr3b: null,
      context: false,
      // The Contact and briefing cards' collapse, which their toggles show.
      contextCollapsed: false,
      signalCollapsed: false,
    };
    this.instruments = createInstrumentState();
    this.routeView = createRouteState();
    this.routeSignature = null;
    this.contextView = createContextState();
    this.brief = createBriefState();
    this.briefTimer = null;
    // The last aircraft or vessel the HUD drew.
    this.lastSubjectInfo = null;
    this.regionalBrief = null;
    this.regionalBriefAnchor = null;
    this.regionalBriefFetchedAt = 0;
    this.regionalBriefAbort = null;
    this.regionalBriefRequestToken = 0;
    this.regionalBriefSubjectId = null;
    this.contextLayoutFrame = null;
    this.contextLayoutStamp = null;
    this.scratchTarget = new Cesium.Cartesian3();
    this.cockpitAnchor = new Cesium.Cartesian3();
    this.cockpitAnchorValid = false;
    this.scratchCamera = new Cesium.Cartesian3();
    this.scratchAdvance = new Cesium.Cartesian3();
    this.scratchCorrection = new Cesium.Cartesian3();
    this.scratchForward = new Cesium.Cartesian3();
    this.scratchHorizontal = new Cesium.Cartesian3();
    this.scratchUp = new Cesium.Cartesian3();
    this.scratchLocal = new Cesium.Cartesian3();
    this.scratchEnu = new Cesium.Matrix4();
    this.scratchAnchorCartographic = new Cesium.Cartographic();
    this.scratchCameraCartographic = new Cesium.Cartographic();
    this.scratchTargetCartographic = new Cesium.Cartographic();
    this._listenerRemovers = [onLocaleChange(() => this.relocalize())];

    // Camera mutations belong before scene update/culling. Changing the camera
    // from preRender makes 3D Tiles discover a new view after traversal and can
    // create a self-sustaining refinement loop under a moving cockpit camera.
    this._listenerRemovers.push(
      viewer.scene.preUpdate.addEventListener(() => this.update()),
      viewer.trackedEntityChanged.addEventListener(() => {
        if (this.active) this._adoptTrackedEntity(performance.now());
        else this.syncEntry();
      }),
    );
    this._listen(this.entry, 'click', () => this.enter());
    // Double-clicking the followed track is a third way in.
    this._listen(
      viewer.scene?.canvas,
      'pointerdown',
      () => this.onScenePointerDown(),
      true,
    );
    this._listenerRemovers.push(routeSceneDoubleClick.call(this));
    // In orbit a click on a mapped point keeps the camera on it.
    this._listenerRemovers.push(routeSceneClick.call(this));
    // In orbit the wheel steps the optical zoom (Cesium's own wheel zoom is
    // off while the Cockpit holds the camera).
    this._listen(
      viewer.scene?.canvas,
      'wheel',
      (event) => this.onOrbitalWheel(event),
      { passive: false },
    );
    // The readout's entry renders inside the Intel HUD, which may mount after
    // this controller; delegated like the radar's range button.
    this._listen(document, 'click', (event) => {
      if (event.target?.closest?.('#cockpit-entry-readout')) this.enter();
    });
    this._listen(this.tr3bToggle, 'click', () => this.toggleTrackedTr3b());
    this._listen(this.mapViewButton, 'click', () => this.exit());
    this._listen(this.visionPrevious, 'click', () => this.cycleVisionMode(-1));
    this._listen(this.visionCurrent, 'click', () => this.cycleVisionMode(1));
    this._listen(this.visionNext, 'click', () => this.cycleVisionMode(1));
    this._listen(this.contextPrevious, 'click', () =>
      this.navigateContext(-1, { origin: 'user' }),
    );
    this._listen(this.contextNext, 'click', () =>
      this.navigateContext(1, { origin: 'user' }),
    );
    this._listen(this.contextToggle, 'click', () =>
      this.setContextCollapsed(!this.contextCollapsed),
    );
    this._listen(this.weatherToggle, 'click', () => {
      const enabled = !this.contextView.weather;
      this.syncWeatherToggle(enabled);
      window.dispatchEvent(
        new CustomEvent('gev:cockpit-weather-toggle', {
          detail: { enabled },
        }),
      );
    });
    this._listen(window, 'gev:cockpit-weather-state', (event) => {
      this.syncWeatherToggle(event?.detail?.enabled !== false);
    });
    // The radar mounts only on a bridge, so its range button is delegated.
    this._listen(document, 'click', (event) => {
      if (event.target?.closest?.('#cockpit-radar-range'))
        this.cycleRadarRange();
    });
    // The look-ahead button shows only on a turned bridge view; delegated.
    this._listen(document, 'click', (event) => {
      if (event.target?.closest?.('#cockpit-look-ahead')) this.lookAhead();
    });
    // The orbital HUD mounts only in orbit, so its controls are delegated.
    this._listen(document, 'click', (event) => {
      const target = event.target;
      if (target?.closest?.('#cockpit-orbital-zoom-in'))
        this.stepOrbitalZoom(1);
      else if (target?.closest?.('#cockpit-orbital-zoom-out'))
        this.stepOrbitalZoom(-1);
      else if (target?.closest?.('#cockpit-orbital-nadir')) this.orbitalNadir();
      else if (target?.closest?.('#cockpit-orbital-sensor'))
        this.jumpToSensorSwath();
    });
    this._listen(this.signalToggle, 'click', () =>
      this.setSignalCollapsed(!this.signalCollapsed, { user: true }),
    );
    this._listen(this.signalList, 'click', (event) =>
      this.handleSignalClick(event),
    );
    this._listen(this.briefPrevious, 'click', () =>
      this.showBriefPage(this.briefPageIndex - 1, { manual: true }),
    );
    this._listen(this.briefNext, 'click', () =>
      this.showBriefPage(this.briefPageIndex + 1, { manual: true }),
    );
    this._listen(this.briefAutoToggle, 'click', () => {
      this.setBriefAutoRotate(!this.briefAutoRotateEnabled);
    });
    this.briefTabs.forEach((button) =>
      this._listen(button, 'click', () => {
        this.showBriefPage(Number(button.dataset.cockpitBriefIndex), {
          manual: true,
        });
      }),
    );
    this._listen(document, 'visibilitychange', () => {
      if (document.hidden) this.stopBriefRotation();
      else if (this.briefAutoRotateEnabled) this.startBriefRotation();
    });
    this._listen(window, 'resize', () => this.scheduleContextLayout());
    this._listen(document, 'keydown', (event) => this.onKeyDown(event), true);
  }

  _listen(target, type, handler, options) {
    if (!target?.addEventListener) return;
    target.addEventListener(type, handler, options);
    this._listenerRemovers.push(() =>
      target.removeEventListener(type, handler, options),
    );
  }

  readAircraftInfo() {
    return readAircraftInfo.call(this);
  }
  readVesselInfo() {
    return readVesselInfo.call(this);
  }
  readSatelliteInfo() {
    return readSatelliteInfo.call(this);
  }
  beginOrbital() {
    return beginOrbital.call(this);
  }
  endOrbital() {
    return endOrbital.call(this);
  }
  updateOrbital(nowMs) {
    return updateOrbital.call(this, nowMs);
  }
  updateOrbitalHud(info, nowMs) {
    return updateOrbitalHud.call(this, info, nowMs);
  }
  /**
   * Step the orbital view's optical zoom (the + and − keys and buttons).
   * @param {number} direction Positive zooms in, negative out.
   * @returns {boolean} True when the zoom changed.
   */
  stepOrbitalZoom(direction) {
    return stepOrbitalZoom.call(this, direction);
  }
  jumpToSensorSwath() {
    return jumpToSensorSwath.call(this);
  }
  onOrbitalWheel(event) {
    return onOrbitalWheel.call(this, event);
  }
  /**
   * A click on the orbital picture: on a mapped point in reach it keeps the
   * camera on that point; anywhere else it ends such a focus.
   * @param {{x: number, y: number}|null|undefined} position
   * @returns {boolean} True when the click focused a point.
   */
  onOrbitalClick(position) {
    return onOrbitalClick.call(this, position);
  }
  /**
   * A double-click on the orbital picture: on a mapped ground point it keeps
   * or starts the focus there instead of letting Cesium track the point.
   * @param {{x: number, y: number}|null|undefined} position
   * @returns {boolean} True when it was taken.
   */
  onOrbitalDoubleClick(position) {
    return onOrbitalDoubleClick.call(this, position);
  }
  /**
   * A site's orbital Live Signals row: focus that site, switch to it, or end
   * the focus held on it.
   * @param {string} key The site's id in the Mapped Installations layer.
   * @returns {boolean} True when the focus changed.
   */
  toggleOrbitalFocus(key) {
    return toggleOrbitalFocus.call(this, key);
  }
  /** Rebuild the orbital Live Signals rows now. */
  refreshOrbitalSignals() {
    return refreshOrbitalSignals.call(this);
  }
  /** Rebuild the orbital Live Signals rows on their clock. */
  updateOrbitalSignals(nowMs) {
    return updateOrbitalSignals.call(this, nowMs);
  }
  /**
   * Ride the satellite an orbital Live Signals row names (RETURN goes back).
   * @param {number|string} noradId
   * @returns {boolean} True when the ridden satellite changed.
   */
  rideOrbitalSatellite(noradId) {
    return rideOrbitalSatellite.call(this, noradId);
  }
  /**
   * A click on an orbital Live Signals row.
   * @returns {boolean} True in orbit.
   */
  handleOrbitalSignalClick(layerId, id) {
    return handleOrbitalSignalClick.call(this, layerId, id);
  }
  /**
   * Tilt the orbital view one arrow step off nadir.
   * @param {{axis: 'yaw'|'pitch', sign: number, stepDeg: number}} step
   * @returns {boolean} True in an orbital view.
   */
  turnOrbitalLook(step) {
    return turnOrbitalLook.call(this, step);
  }
  /**
   * The NADIR control and the Home and 0 keys in orbit: back to pure nadir.
   * Focus leaves the button before it hides.
   * @returns {boolean} True in an orbital view.
   */
  orbitalNadir() {
    const button = document.getElementById('cockpit-orbital-nadir');
    const hadFocus = !!button && button.contains(document.activeElement);
    const reset = resetOrbitalLook.call(this);
    if (reset && hadFocus) this.mapViewButton?.focus({ preventScroll: true });
    return reset;
  }
  readSubjectLayerId() {
    return readSubjectLayerId.call(this);
  }
  resolveEntryKind() {
    return resolveEntryKind.call(this);
  }
  dispatchCockpitModeChanged(active, info) {
    return dispatchCockpitModeChanged.call(this, active, info);
  }
  toggleTrackedTr3b() {
    return toggleTrackedTr3b.call(this);
  }
  publishPresenceView() {
    return publishPresenceView.call(this);
  }
  syncTr3bToggle(info) {
    return syncTr3bToggle.call(this, info);
  }
  syncEntry() {
    return syncEntry.call(this);
  }
  navigateContext(direction, options) {
    return navigateContext.call(this, direction, options);
  }
  _adoptTrackedEntity(nowMs, suppliedInfo) {
    return _adoptTrackedEntity.call(this, nowMs, suppliedInfo);
  }
  enter(options) {
    return enter.call(this, options);
  }
  exit(options) {
    return exit.call(this, options);
  }
  update() {
    return update.call(this);
  }
  publishInstrumentsView() {
    return publishInstrumentsView.call(this);
  }
  publishRouteView() {
    return publishRouteView.call(this);
  }
  updateHud(info, nowMs, forceContext) {
    return updateHud.call(this, info, nowMs, forceContext);
  }
  updateRoute(info) {
    return updateRoute.call(this, info);
  }
  updateRadar(info) {
    return updateRadar.call(this, info);
  }
  /** Step the bridge radar to its next range and redraw it at once. */
  cycleRadarRange() {
    this.radarRangeNm = nextRadarRange(this.radarRangeNm);
    if (this.active && this.subjectKind === 'vessel' && this.lastSubjectInfo)
      this.updateRadar(this.lastSubjectInfo);
  }
  presentLook() {
    return presentLook.call(this);
  }
  /**
   * Turn the bridge view one arrow step (see `lookKeyStep`). The camera
   * eases there unless the user prefers reduced motion.
   * @param {{axis: 'yaw'|'pitch', sign: number, stepDeg: number}} step
   * @returns {boolean} True when a bridge view was turned.
   */
  turnLook(step) {
    if (!this.active || this.subjectKind !== 'vessel' || !step) return false;
    this.lookTarget = stepLook(this.lookTarget, step);
    if (prefersReducedMotion()) this.lookView = { ...this.lookTarget };
    this.presentLook();
    this.publishInstrumentsView();
    return true;
  }
  /**
   * Point the bridge view back over the bow at the rest pitch.
   * @param {{immediate?: boolean}} [options] Jump there instead of easing,
   *   as entry and exit do.
   */
  resetLook({ immediate = false } = {}) {
    this.lookTarget = { yawDeg: 0, pitchDeg: VESSEL_BRIDGE_PITCH_DEG };
    if (immediate || prefersReducedMotion())
      this.lookView = { ...this.lookTarget };
    this.lookLastMs = performance.now();
    this.presentLook();
    this.publishInstrumentsView();
  }
  /**
   * The LOOK AHEAD control and the Home and 0 keys: ease the bridge view
   * back over the bow. Focus leaves the button before it hides.
   * @returns {boolean} True on a bridge.
   */
  lookAhead() {
    if (!this.active || this.subjectKind !== 'vessel') return false;
    const button = document.getElementById('cockpit-look-ahead');
    const hadFocus = !!button && button.contains(document.activeElement);
    this.resetLook();
    if (hadFocus) this.mapViewButton?.focus({ preventScroll: true });
    return true;
  }
  syncWeatherToggle(enabled) {
    return syncWeatherToggle.call(this, enabled);
  }
  setVisionMode(mode, options) {
    return setVisionMode.call(this, mode, options);
  }
  cycleVisionMode(direction) {
    return cycleVisionMode.call(this, direction);
  }
  clearPredictiveRoute() {
    return clearPredictiveRoute.call(this);
  }
  publishContextView() {
    return publishContextView.call(this);
  }
  showContextCard(visible) {
    return showContextCard.call(this, visible);
  }
  updateContext(info, heading) {
    return updateContext.call(this, info, heading);
  }
  publishBriefView() {
    return publishBriefView.call(this);
  }
  showBriefPage(index, options) {
    return showBriefPage.call(this, index, options);
  }
  setBriefAutoRotate(enabled) {
    return setBriefAutoRotate.call(this, enabled);
  }
  startBriefRotation(options) {
    return startBriefRotation.call(this, options);
  }
  stopBriefRotation() {
    return stopBriefRotation.call(this);
  }
  updateLocalPosition(info) {
    return updateLocalPosition.call(this, info);
  }
  maybeRefreshRegionalBrief(info) {
    return maybeRefreshRegionalBrief.call(this, info);
  }
  renderRegionalBriefStatus(status, info) {
    return renderRegionalBriefStatus.call(this, status, info);
  }
  relocalizeBrief() {
    return relocalizeBrief.call(this);
  }
  renderRegionalBrief(payload, info) {
    return renderRegionalBrief.call(this, payload, info);
  }
  publishCockpitSignals() {
    return publishCockpitSignals.call(this);
  }
  pushCockpitSignal(key, tone, title, detail, target) {
    return pushCockpitSignal.call(this, key, tone, title, detail, target);
  }
  dropCockpitSignal(key) {
    return dropCockpitSignal.call(this, key);
  }
  dropContextSnapshotSignals() {
    return dropContextSnapshotSignals.call(this);
  }
  updateCockpitSignals(snapshot, unknownCount, partialPicture) {
    return updateCockpitSignals.call(
      this,
      snapshot,
      unknownCount,
      partialPicture,
    );
  }
  scheduleContextLayout() {
    return scheduleContextLayout.call(this);
  }
  setContextCollapsed(collapsed) {
    return setContextCollapsed.call(this, collapsed);
  }
  setSignalCollapsed(collapsed, options) {
    return setSignalCollapsed.call(this, collapsed, options);
  }
  syncContextLayout() {
    return syncContextLayout.call(this);
  }
  syncSignalLayout() {
    return syncSignalLayout.call(this);
  }
  onKeyDown(event) {
    return onKeyDown.call(this, event);
  }
  onSceneDoubleClick(position, nowMs) {
    return onSceneDoubleClick.call(this, position, nowMs);
  }
  onScenePointerDown(nowMs) {
    return onScenePointerDown.call(this, nowMs);
  }

  handleSignalClick(event) {
    return handleSignalClick.call(this, event);
  }

  /**
   * Word every Cockpit surface again in the current locale. In flight the
   * last reading is shown again; otherwise the surfaces go back to their
   * placeholders, which the next entry replaces.
   */
  relocalize() {
    if (this.destroyed) return;
    this.relocalizeBrief();
    this.publishVision(createVisionState(this.visionMode));
    this.routeSignature = null;
    if (this.active && this.lastSubjectInfo) {
      this.rewordingSignals = true;
      try {
        this.updateHud(this.lastSubjectInfo, performance.now(), true);
      } finally {
        this.rewordingSignals = false;
      }
      return;
    }
    this.instruments = createInstrumentState();
    this.publishInstrumentsView();
    this.routeView = createRouteState();
    this.publishRouteView();
    this.contextView = {
      ...createContextState(),
      weather: this.contextView.weather,
    };
    this.publishContextView();
  }

  /** Revoke new work before the shell awaits layer restoration. */
  stop() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.regionalBriefAbort?.abort();
    this.regionalBriefAbort = null;
    this.regionalBriefRequestToken += 1;
    this.stopBriefRotation();
    if (this.contextLayoutFrame !== null)
      cancelAnimationFrame(this.contextLayoutFrame);
    this.contextLayoutFrame = null;
    for (const removeListener of this._listenerRemovers.splice(0))
      removeListener?.();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.exit({ restoreTracking: false });
  }
}
