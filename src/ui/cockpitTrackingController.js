/** Tracking identity, entry, exit and contact navigation for the Cockpit controller. */
import { t } from '../i18n/index.js';
import {
  formatHeadingReadout,
  normalizeHeading,
  resolveTrackedAircraftInfo,
} from '../cockpitMath.js';

export function readAircraftInfo() {
  // In cockpit mode the controller takes the entity off `viewer.trackedEntity`
  // (see update()), so the cockpit's own handle is the tracked identity there.
  const trackedEntity = this.viewer?.trackedEntity || this.trackedEntity;
  return resolveTrackedAircraftInfo({
    civilian: this.services.flightsLayer.getTrackedInfo?.() || null,
    military: this.services.militaryFlightsLayer.getTrackedInfo?.() || null,
    trackedId: trackedEntity?.gevTrackedId || '',
  });
}

export function dispatchCockpitModeChanged(active, info = null) {
  const subjectId = active
    ? String(info?.icao24 || '')
        .trim()
        .toLowerCase() || null
    : null;
  const layerId =
    active && ['flights', 'military'].includes(info?.layerId)
      ? info.layerId
      : null;
  window.dispatchEvent(
    new CustomEvent('gev:cockpit-mode-changed', {
      detail: { active: active === true, subjectId, layerId },
    }),
  );
}

export function toggleTrackedTr3b() {
  if (this.destroyed) return false;
  const info = this.readAircraftInfo();
  const icao24 = String(info?.icao24 || '').trim();
  if (!icao24) return false;
  this.services.toggleTr3b(icao24);
  const layer =
    info.layerId === 'military'
      ? this.services.militaryFlightsLayer
      : this.services.flightsLayer;
  layer.refreshTr3b?.(icao24);
  this._tr3bSignature = null; // force the chip to repaint on the next sync
  this.syncTr3bToggle(info);
  return true;
}

/**
 * Publish which Cockpit surfaces are shown: the entry button, the TR-3B chip,
 * the HUD with its exit and reset buttons and briefing card, and the Contact
 * card. The views bind these; nothing else writes their visibility.
 */
export function publishPresenceView() {
  const presence = this.presence;
  this.publishPresence({
    ...presence,
    tr3b: presence.tr3b && { ...presence.tr3b },
  });
}

export function syncTr3bToggle(info) {
  const icao24 = String(info?.icao24 || '').trim();
  const converted = !!icao24 && this.services.isTr3b(icao24);
  const signature = icao24 ? `${icao24}:${converted ? 1 : 0}` : '';
  if (this._tr3bSignature === signature) return;
  this._tr3bSignature = signature;
  this.presence.tr3b = icao24 ? { converted } : null;
  this.publishPresenceView();
}

export function syncEntry() {
  if (this.destroyed) return false;
  if (this.active) return;
  const info = this.readAircraftInfo();
  const trackedContact = !!(info && this.viewer.trackedEntity?.position);
  this.syncTr3bToggle(trackedContact ? info : null);
  const available = !!(this.isEntryAllowed() && trackedContact);
  // Change-only publishes: this runs on a preUpdate cadence, and a fresh
  // presence every frame would re-render the views even when nothing
  // changed. (perf item 9)
  if (this.presence.entryAvailable === available) return;
  this.presence.entryAvailable = available;
  this.publishPresenceView();
}

export function navigateContext(direction, options = {}) {
  if (this.destroyed) return false;
  const method = direction < 0 ? 'navigatePrevious' : 'navigateNext';
  const wasActive = this.active;
  if (wasActive) this.contextNavigationDeadlineMs = performance.now() + 1500;
  const navigationOptions = wasActive
    ? { ...options, aircraftOnly: true }
    : options;
  const changed = Boolean(
    this.services.militaryAwarenessLayer?.[method]?.(navigationOptions),
  );
  if (!changed) {
    this.contextNavigationDeadlineMs = 0;
    return false;
  }
  if (wasActive) this._adoptTrackedEntity(performance.now());
  return true;
}

export function _adoptTrackedEntity(nowMs, suppliedInfo = null) {
  const nextEntity = this.viewer.trackedEntity;
  if (
    !this.active ||
    !nextEntity?.position ||
    nextEntity === this.trackedEntity
  )
    return false;
  const info = suppliedInfo || this.readAircraftInfo();
  if (!info) return false;
  if (this.trackedEntity && this.viewer.entities.contains(this.trackedEntity)) {
    this.trackedEntity.show = this.trackedEntityWasShown;
  }
  this.trackedEntity = nextEntity;
  this.trackedEntityWasShown = nextEntity.show;
  nextEntity.show = false;
  this.viewer.trackedEntity = undefined;
  this.cockpitAnchorValid = false;
  this.heading = normalizeHeading(info.track ?? 0);
  this.lastFrameMs = nowMs;
  this.lastHudUpdateMs = 0;
  this.lastContextUpdateMs = 0;
  this.lastCameraUpdateMs = 0;
  this.contextNavigationDeadlineMs = 0;
  this.dispatchCockpitModeChanged(true, info);
  return true;
}

export function enter() {
  if (this.destroyed) return false;
  if (this.active) return false;
  if (!this.isEntryAllowed()) return false;
  const info = this.readAircraftInfo();
  const entity = this.viewer.trackedEntity;
  if (!info || !entity?.position) return false;
  this.entryFocusOrigin =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  // Retire deferred navigation before cancelFlight can run its callbacks.
  this.onCameraTakeover?.();
  this.viewer.camera.cancelFlight();
  this.trackedEntity = entity;
  this.trackedEntityWasShown = entity.show;
  entity.show = false;
  this.heading = normalizeHeading(info.track ?? 0);
  this.lastFrameMs = performance.now();
  this.lastCameraUpdateMs = 0;
  this.lastHudUpdateMs = 0;
  this.lastContextUpdateMs = 0;
  this.contextNavigationDeadlineMs = 0;
  this.lastGroundProbeMs = 0;
  this.surfaceWaitStartedMs = performance.now();
  this.surfaceAcquiring = false;
  this.surfaceFallback = false;
  this.cockpitAnchorValid = false;
  this.lastCameraUpdateMs = 0;
  this.active = true;
  // Cockpit animates the camera from preUpdate every frame — preUpdate only
  // runs on rendered frames, so idle mode would freeze the cockpit solid.
  // (perf wave 2)
  this.services.holdContinuousRender('cockpit');
  this.viewer.trackedEntity = undefined;
  this.viewer.scene.screenSpaceCameraController.enableInputs = false;
  document.body.classList.add('cockpit-mode');
  // Activation hides the entry and TR-3B chip; clearing the chip's signature
  // lets the exit-path syncEntry publish it again.
  this._tr3bSignature = null;
  Object.assign(this.presence, {
    active: true,
    entryAvailable: false,
    tr3b: null,
  });
  this.publishPresenceView();
  this.signalItems = [];
  this.signalSignatures.clear();
  this.showBriefPage(0);
  this.startBriefRotation();
  const trackLabel =
    info.callsign || info.registration || info.icao24 || t('AIRCRAFT');
  const trackHeading = formatHeadingReadout(info.track ?? 0);
  this.pushCockpitSignal(
    'track',
    'track',
    t('TRACK ACQUIRED'),
    t('{label} · COURSE {heading}°', {
      label: trackLabel,
      heading: trackHeading,
    }),
  );
  this.updateHud(info, performance.now(), true);
  this.setVisionMode(this.getInitialVisionMode());
  this.scheduleContextLayout();
  // The exit button shows when Vue flushes the presence; focus it after.
  Promise.resolve().then(() => {
    if (this.active && !this.destroyed)
      this.mapViewButton?.focus({ preventScroll: true });
  });
  this.onEntered?.();
  this.dispatchCockpitModeChanged(true, info);
  return true;
}

export function exit({ restoreTracking = true } = {}) {
  if (!this.active) return false;
  const entity = this.trackedEntity;
  this.active = false;
  this.services.releaseContinuousRender('cockpit');
  this.trackedEntity = null;
  this.heading = null;
  this.cockpitAnchorValid = false;
  this.surfaceWaitStartedMs = 0;
  this.surfaceAcquiring = false;
  this.surfaceFallback = false;
  this.lastHudUpdateMs = 0;
  this.lastContextUpdateMs = 0;
  this.contextNavigationDeadlineMs = 0;
  this.stopBriefRotation();
  this.regionalBriefAbort?.abort();
  this.regionalBriefAbort = null;
  this.regionalBriefRequestToken += 1;
  this.regionalBriefSubjectId = null;
  document.body.classList.remove('cockpit-mode');
  this.onExited?.();
  this.publishUtilityLayout(null);
  this.presence.active = false;
  this.publishPresenceView();
  this.routeView.visible = false;
  this.clearPredictiveRoute();
  this.setVisionMode('optical');
  this.viewer.scene.screenSpaceCameraController.enableInputs = true;
  if (entity && this.viewer.entities.contains(entity))
    entity.show = this.trackedEntityWasShown;
  this.trackedEntityWasShown = true;
  this.dispatchCockpitModeChanged(false);
  if (restoreTracking && entity && this.viewer.entities.contains(entity)) {
    this.viewer.trackedEntity = entity;
    this.restoreTrackingFrame(entity);
  }
  this.syncEntry();
  const restoreTarget =
    this.entryFocusOrigin === this.entry
      ? this.entry
      : this.entry || this.entryFocusOrigin;
  this.entryFocusOrigin = null;
  // The entry shows when Vue flushes the presence; read it after.
  Promise.resolve().then(() => {
    if (
      !this.destroyed &&
      !this.active &&
      restoreTarget?.isConnected &&
      !restoreTarget.hidden
    )
      restoreTarget.focus({ preventScroll: true });
  });
  return true;
}
