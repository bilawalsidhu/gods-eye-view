/** Tracking identity, entry, exit and contact navigation for the Cockpit controller. */
import {
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

export function syncTr3bToggle(info) {
  if (!this.tr3bToggle) return;
  const icao24 = String(info?.icao24 || '').trim();
  const converted = !!icao24 && this.services.isTr3b(icao24);
  const signature = icao24 ? `${icao24}:${converted ? 1 : 0}` : '';
  if (this._tr3bSignature === signature) return;
  this._tr3bSignature = signature;
  this.tr3bToggle.hidden = !icao24;
  this.tr3bToggle.setAttribute('aria-pressed', converted ? 'true' : 'false');
  this.tr3bToggle.title = converted
    ? 'Restore real aircraft'
    : 'Reclassify as TR-3B';
}

export function syncEntry() {
  if (this.destroyed) return false;
  if (this.active) return;
  const info = this.readAircraftInfo();
  const trackedContact = !!(info && this.viewer.trackedEntity?.position);
  this.syncTr3bToggle(trackedContact ? info : null);
  const available = !!(this.isEntryAllowed() && trackedContact);
  // Change-only DOM writes: this runs on a preUpdate cadence, and
  // unconditional `hidden` assignments invalidate style/layout every frame
  // even when nothing changed. (perf item 9)
  if (this._entryAvailable === available) return;
  this._entryAvailable = available;
  if (this.entry) this.entry.hidden = !available;
  if (this.mapViewButton) this.mapViewButton.hidden = true;
  if (this.resetGlobeButton) this.resetGlobeButton.hidden = true;
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
  this.lastCompassSignature = '';
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
  // Activation writes entry/quick/map visibility directly, bypassing
  // syncEntry's change-only cache — invalidate it so the exit-path
  // syncEntry re-applies every write (notably re-hiding mapViewButton).
  this._entryAvailable = undefined;
  if (this.entry) this.entry.hidden = true;
  if (this.tr3bToggle) {
    this.tr3bToggle.hidden = true;
    this._tr3bSignature = null;
  }
  if (this.mapViewButton) this.mapViewButton.hidden = false;
  if (this.resetGlobeButton) this.resetGlobeButton.hidden = false;
  if (this.hud) this.hud.hidden = false;
  if (this.signalStream) this.signalStream.hidden = false;
  this.hud?.classList.add('signals-active');
  this.signalItems = [];
  this.signalSignatures.clear();
  this.showBriefPage(0);
  this.startBriefRotation();
  const trackLabel =
    info.callsign || info.registration || info.icao24 || 'AIRCRAFT';
  const trackHeading = String(
    Math.round(normalizeHeading(info.track ?? 0)),
  ).padStart(3, '0');
  this.pushCockpitSignal(
    'track',
    'track',
    'TRACK ACQUIRED',
    `${trackLabel} · COURSE ${trackHeading}°`,
  );
  this.updateHud(info, performance.now(), true);
  this.setVisionMode(this.visionMode);
  this.scheduleContextLayout();
  this.mapViewButton?.focus({ preventScroll: true });
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
  this.lastCompassSignature = '';
  this.stopBriefRotation();
  this.regionalBriefAbort?.abort();
  this.regionalBriefAbort = null;
  this.regionalBriefRequestToken += 1;
  this.regionalBriefSubjectId = null;
  document.body.classList.remove('cockpit-mode');
  this.onExited?.();
  this.hud?.style.removeProperty('--cockpit-utility-top');
  this.hud?.style.removeProperty('--cockpit-utility-max-height');
  if (this.hud) this.hud.hidden = true;
  if (this.route) this.route.hidden = true;
  this.clearPredictiveRoute();
  this.setVisionMode('optical');
  if (this.signalStream) this.signalStream.hidden = true;
  this.hud?.classList.remove('signals-active');
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
  if (!this.destroyed && restoreTarget?.isConnected && !restoreTarget.hidden) {
    restoreTarget.focus({ preventScroll: true });
  }
  return true;
}
