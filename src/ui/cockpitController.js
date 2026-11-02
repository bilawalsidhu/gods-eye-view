/** Coordinate Cockpit lifecycle through supplied aircraft, terrain, rendering and briefing operations. */
import {
  readAircraftInfo,
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
  publishInstrumentsView,
  publishRouteView,
  updateHud,
  updateRoute,
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
import { onKeyDown } from './cockpitInput.js';
import * as Cesium from 'cesium';

export class CockpitViewController {
  constructor(
    viewer,
    {
      services,
      onVisionChange = null,
      getInitialVisionMode = null,
      onCameraTakeover = null,
      isEntryAllowed = null,
      isUtilityDisclosureOpen = null,
      onEntered = null,
      onExited = null,
      restoreTrackingFrame = null,
      publish = {},
    } = {},
  ) {
    this.viewer = viewer;
    this.services = services;
    this.destroyed = false;
    this.disposed = false;
    this.active = false;
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
    this.restoreTrackingFrame =
      typeof restoreTrackingFrame === 'function'
        ? restoreTrackingFrame
        : () => false;
    this.isEntryAllowed =
      typeof isEntryAllowed === 'function' ? isEntryAllowed : () => true;
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
    this.presence = {
      active: false,
      entryAvailable: false,
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
    this.lastAircraftInfo = null;
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
  enter() {
    return enter.call(this);
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
  updateCockpitSignals(snapshot, unknownCount) {
    return updateCockpitSignals.call(this, snapshot, unknownCount);
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
    if (this.active && this.lastAircraftInfo) {
      this.rewordingSignals = true;
      try {
        this.updateHud(this.lastAircraftInfo, performance.now(), true);
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
