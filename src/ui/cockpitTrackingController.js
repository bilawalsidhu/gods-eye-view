/** Tracking identity, entry, exit and contact navigation for the Cockpit controller. */
import { t } from '../i18n/index.js';
import {
  formatHeadingReadout,
  normalizeHeading,
  resolveTrackedAircraftInfo,
} from '../cockpitMath.js';

/** The camera's own heading in degrees, or 0 when it has none. */
function cameraHeadingDeg(camera) {
  const heading = camera?.heading;
  return Number.isFinite(heading) ? (heading * 180) / Math.PI : 0;
}

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

/** The selected vessel the bridge view would ride, or rides; null without one. */
export function readVesselInfo() {
  return this.services.aisLiveVesselsLayer?.getCockpitSubject?.() || null;
}

/** The tracked satellite the orbital view would ride, or rides; null without one. */
export function readSatelliteInfo() {
  return this.services.satellitesLayer?.getCockpitSubject?.() || null;
}

/**
 * The layer the active view rides: Live AIS Vessels on a bridge, Satellites
 * in orbit, else the aircraft's own layer. It is read from the tracked
 * entity's id once the layer has dropped its tracking, so a layer turned off
 * still names itself.
 * @returns {'flights'|'military'|'ais-live-vessels'|'satellites'|null}
 */
export function readSubjectLayerId() {
  if (!this.active) return null;
  if (this.subjectKind === 'vessel') return 'ais-live-vessels';
  if (this.subjectKind === 'satellite') return 'satellites';
  const layerId = this.readAircraftInfo()?.layerId;
  if (layerId) return layerId;
  const [prefix] = String(this.trackedEntity?.gevTrackedId || '').split(':');
  return ['flights', 'military'].includes(prefix) ? prefix : null;
}

/**
 * The subject entry would take: a Cesium-tracked aircraft first, then the
 * tracked satellite, else the selected vessel. Vessels never take Cesium
 * tracking, so an aircraft and a vessel cannot be live through the same owner.
 * @returns {'aircraft'|'satellite'|'vessel'|null}
 */
export function resolveEntryKind() {
  if (this.readAircraftInfo() && this.viewer.trackedEntity?.position)
    return 'aircraft';
  if (this.readSatelliteInfo()) return 'satellite';
  return this.readVesselInfo() ? 'vessel' : null;
}

export function dispatchCockpitModeChanged(active, info = null) {
  const subjectId = active
    ? String(
        info?.icao24 ||
          (info?.kind === 'vessel' ? info.id : '') ||
          info?.noradId ||
          '',
      )
        .trim()
        .toLowerCase() || null
    : null;
  const layerId =
    active &&
    ['flights', 'military', 'ais-live-vessels', 'satellites'].includes(
      info?.layerId,
    )
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
  const orbitContact = !trackedContact && !!this.readSatelliteInfo();
  const bridgeContact =
    !trackedContact && !orbitContact && !!this.readVesselInfo();
  let entryKind = null;
  if (trackedContact) entryKind = this.isEntryAllowed() ? 'aircraft' : null;
  else if (orbitContact)
    entryKind = this.isOrbitEntryAllowed() ? 'satellite' : null;
  else if (bridgeContact)
    entryKind = this.isBridgeEntryAllowed() ? 'vessel' : null;
  const available = entryKind !== null;
  // Change-only publishes: this runs on a preUpdate cadence, and a fresh
  // presence every frame would re-render the views even when nothing
  // changed. (perf item 9)
  if (
    this.presence.entryAvailable === available &&
    this.presence.entryKind === entryKind
  )
    return;
  this.presence.entryAvailable = available;
  this.presence.entryKind = entryKind;
  this.publishPresenceView();
}

export function navigateContext(direction, options = {}) {
  if (this.destroyed) return false;
  // Contact navigation moves between aircraft; a bridge does not jump ship
  // and an orbital view stays with its satellite.
  if (this.subjectKind === 'vessel' || this.subjectKind === 'satellite')
    return false;
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
  // An aircraft tracked from the bridge or from orbit ends that view (see the
  // vessel and orbital camera updates); it is never adopted as its subject.
  if (this.subjectKind === 'vessel' || this.subjectKind === 'satellite')
    return false;
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
  this.onRide?.(info.layerId);
  this.dispatchCockpitModeChanged(true, info);
  return true;
}

/**
 * Enter first person on a tracked aircraft or, with none tracked, the
 * tracked satellite's orbital view or the selected vessel's bridge.
 * @param {{kind?: 'aircraft'|'satellite'|'vessel'|null}} [options] Restrict
 *   entry to one subject kind; voice entry is aircraft-only.
 * @returns {boolean} True when the view was entered.
 */
export function enter({ kind = null } = {}) {
  if (this.destroyed) return false;
  if (this.active) return false;
  const subjectKind = kind ?? this.resolveEntryKind() ?? 'aircraft';
  const vessel = subjectKind === 'vessel';
  const satellite = subjectKind === 'satellite';
  const allowed = vessel
    ? this.isBridgeEntryAllowed()
    : satellite
      ? this.isOrbitEntryAllowed()
      : this.isEntryAllowed();
  if (!allowed) return false;
  const info = vessel
    ? this.readVesselInfo()
    : satellite
      ? this.readSatelliteInfo()
      : this.readAircraftInfo();
  // Only an aircraft is ridden through its Cesium entity.
  const entity = vessel || satellite ? null : this.viewer.trackedEntity;
  if (!info || (!vessel && !satellite && !entity?.position)) return false;
  this.entryFocusOrigin =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  // Retire deferred navigation before cancelFlight can run its callbacks.
  this.onCameraTakeover?.();
  this.viewer.camera.cancelFlight();
  this.subjectKind = subjectKind;
  // Each session reads its own water: never a height left from the last.
  this.vesselWaterline = null;
  this.vesselFix = null;
  this.subjectId = vessel ? info.id : satellite ? info.noradId : null;
  this.trackedEntity = entity;
  if (entity) {
    this.trackedEntityWasShown = entity.show;
    entity.show = false;
  } else if (satellite) {
    // The layer hides the satellite's own marks and dims the other orbits.
    this.services.satellitesLayer?.setCockpitSubject?.(info.noradId);
    this.beginOrbital();
  } else {
    this.services.aisLiveVesselsLayer?.setCockpitSubject?.(info.id);
  }
  // A ship reporting neither heading nor course keeps the camera's own
  // heading: no direction is made up for it.
  this.heading = normalizeHeading(
    Number.isFinite(info.track)
      ? info.track
      : vessel
        ? cameraHeadingDeg(this.viewer.camera)
        : 0,
  );
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
  // Every bridge opens looking over the bow.
  this.resetLook({ immediate: true });
  this.active = true;
  // Cockpit animates the camera from preUpdate every frame — preUpdate only
  // runs on rendered frames, so idle mode would freeze the cockpit solid.
  // (perf wave 2)
  this.services.holdContinuousRender('cockpit');
  this.viewer.trackedEntity = undefined;
  this.viewer.scene.screenSpaceCameraController.enableInputs = false;
  document.body.classList.add('cockpit-mode');
  // Bridge styling reaches surfaces outside the HUD (exit row, side panels).
  if (vessel) document.body.classList.add('cockpit-bridge');
  if (satellite) document.body.classList.add('cockpit-orbit');
  // Activation hides the entry and TR-3B chip; clearing the chip's signature
  // lets the exit-path syncEntry publish it again.
  this._tr3bSignature = null;
  Object.assign(this.presence, {
    active: true,
    entryAvailable: false,
    entryKind: null,
    subjectKind,
    tr3b: null,
  });
  this.publishPresenceView();
  // Only a bridge has a radar.
  if (!vessel) this.publishRadar(null);
  this.signalItems = [];
  this.signalSignatures.clear();
  this.showBriefPage(0);
  this.startBriefRotation();
  const trackHeading = formatHeadingReadout(info.track ?? 0);
  if (satellite) {
    this.pushCockpitSignal(
      'track',
      'track',
      t('TRACK ACQUIRED'),
      t('{label} · NADIR VIEW', { label: info.name }),
    );
  } else if (vessel) {
    this.pushCockpitSignal(
      'track',
      'track',
      t('TRACK ACQUIRED'),
      // A ship with no true heading is held on its course over ground; one
      // with neither is named without a direction.
      info.trackSource === 'course'
        ? t('{label} · COURSE {heading}°', {
            label: info.name,
            heading: trackHeading,
          })
        : info.trackSource === 'heading'
          ? t('{label} · HEADING {heading}°', {
              label: info.name,
              heading: trackHeading,
            })
          : t('{label} · NO HEADING', { label: info.name }),
    );
  } else {
    const trackLabel =
      info.callsign || info.registration || info.icao24 || t('AIRCRAFT');
    this.pushCockpitSignal(
      'track',
      'track',
      t('TRACK ACQUIRED'),
      t('{label} · COURSE {heading}°', {
        label: trackLabel,
        heading: trackHeading,
      }),
    );
  }
  this.updateHud(info, performance.now(), true);
  // Orbit always opens in the plain optical picture; the vision styles stay
  // one click away.
  this.setVisionMode(satellite ? 'optical' : this.getInitialVisionMode());
  this.scheduleContextLayout();
  // The exit button shows when Vue flushes the presence; focus it after.
  Promise.resolve().then(() => {
    if (this.active && !this.destroyed)
      this.mapViewButton?.focus({ preventScroll: true });
  });
  this.onEntered?.();
  this.onRide?.(info.layerId);
  this.dispatchCockpitModeChanged(true, info);
  return true;
}

export function exit({ restoreTracking = true } = {}) {
  if (!this.active) return false;
  const entity = this.trackedEntity;
  const vesselSubject = this.subjectKind === 'vessel' ? this.subjectId : null;
  const satelliteSubject =
    this.subjectKind === 'satellite' ? this.subjectId : null;
  this.active = false;
  this.subjectKind = null;
  this.vesselWaterline = null;
  this.vesselFix = null;
  this.subjectId = null;
  this.services.releaseContinuousRender('cockpit');
  this.trackedEntity = null;
  this.heading = null;
  this.resetLook({ immediate: true });
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
  document.body.classList.remove(
    'cockpit-mode',
    'cockpit-bridge',
    'cockpit-orbit',
  );
  // The camera's own field of view returns before any follow resumes.
  this.endOrbital();
  this.onExited?.();
  this.publishUtilityLayout(null);
  this.presence.active = false;
  this.presence.subjectKind = null;
  this.publishPresenceView();
  this.routeView.visible = false;
  this.clearPredictiveRoute();
  this.publishRadar(null);
  this.setVisionMode('optical');
  this.viewer.scene.screenSpaceCameraController.enableInputs = true;
  if (entity && this.viewer.entities.contains(entity))
    entity.show = this.trackedEntityWasShown;
  this.trackedEntityWasShown = true;
  if (vesselSubject)
    this.services.aisLiveVesselsLayer?.setCockpitSubject?.(null);
  if (satelliteSubject !== null)
    this.services.satellitesLayer?.setCockpitSubject?.(null);
  this.dispatchCockpitModeChanged(false);
  if (restoreTracking && entity && this.viewer.entities.contains(entity)) {
    this.viewer.trackedEntity = entity;
    this.restoreTrackingFrame(entity);
  } else if (restoreTracking && vesselSubject) {
    // Back to the selected vessel's map view, through the layer's own focus.
    this.services.aisLiveVesselsLayer?.focusSelectedVessel?.();
  } else if (restoreTracking && satelliteSubject !== null) {
    // Back to the satellite's follow camera, through the layer's own refocus.
    this.services.satellitesLayer?.refocusTrackedById?.(satelliteSubject);
  }
  this.syncEntry();
  // Back to whichever entry was used: the Contacts button or the readout's.
  const readoutEntry = document.getElementById('cockpit-entry-readout');
  const restoreTarget =
    this.entryFocusOrigin === this.entry ||
    (readoutEntry && this.entryFocusOrigin === readoutEntry)
      ? this.entryFocusOrigin
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
