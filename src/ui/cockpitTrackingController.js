/** Tracking identity, entry, exit and contact navigation for the Cockpit controller. */
import { t } from '../i18n/index.js';
import {
  formatHeadingReadout,
  normalizeHeading,
  resolveTrackedAircraftInfo,
} from '../cockpitMath.js';
import {
  cockpitSubjectCandidate,
  cockpitSubjectFrame,
} from '../cockpitSubjectProviders.js';

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
 * What an application subject provider would have entry ride now, or null.
 * @param {object} provider A provider from cockpitSubjectProviders.
 * @returns {{id: string, name: string, face: object|null}|null}
 */
export function readSubjectCandidate(provider) {
  return cockpitSubjectCandidate(
    this.callSubject(provider, 'candidate', [], null),
  );
}

/**
 * What a provider's `read` and `hud` receive besides the frame: the shared
 * ground floor at a point (metres, or null), a way to warm its cells, and the
 * floor service's lift.
 */
export function subjectContext() {
  this._subjectContext ??= Object.freeze({
    groundHeightAt: (latitude, longitude) => {
      const height = this.services.cachedGroundFloor?.(latitude, longitude);
      return Number.isFinite(height) ? height : null;
    },
    warmGround: (points) => {
      this.services.warmGroundFloor?.(points);
    },
    liftM: Number.isFinite(this.services.GROUND_FLOOR_LIFT_M)
      ? this.services.GROUND_FLOOR_LIFT_M
      : 0,
  });
  return this._subjectContext;
}

/**
 * The ridden provider subject as the camera and HUD read it: the frame's
 * place and motion, named like the built-in kinds' info.
 * @param {object} frame From cockpitSubjectFrame.
 */
export function subjectInfo(frame) {
  return {
    kind: this.subjectProvider?.kind ?? null,
    generic: true,
    layerId: this.subjectProvider?.layerId ?? null,
    id: frame.id,
    name: frame.name,
    latitude: frame.latitude,
    longitude: frame.longitude,
    track: frame.headingDeg,
    motionCourse: frame.courseDeg,
    velocityMps: frame.speedMps ?? 0,
    stale: frame.stale,
    groundClamp: frame.groundClamp,
    anchor: frame.anchor,
    onGround: false,
  };
}

/** The built-in kinds' fixed entry order. */
const BUILT_IN_ENTRY_ORDER = Object.freeze({
  aircraft: 0,
  satellite: 1,
  vessel: 2,
});

/**
 * Every subject entry could ride now, in entry order: a tracked aircraft,
 * the tracked satellite, the selected vessel and each provider's candidate.
 * The built-in kinds keep their fixed order (aircraft, satellite, vessel),
 * whenever each was selected. A provider's candidate goes ahead of them only
 * when it was selected after every built-in one present: a train picked
 * after an aircraft was tracked takes entry, an aircraft tracked after it
 * takes it back. Providers' candidates are ordered most recently selected
 * first, then by priority. A candidate's time is when this controller first
 * saw it (it looks on its entry cadence and on tracking changes), or saw it
 * selected again: another subject of a built-in kind, a provider candidate
 * whose `selectedAt` changes, or one without a `selectedAt` whose id changes.
 * A new id under the same `selectedAt` is the same selection, as when a
 * train's selection moves to another feed's copy of it. One
 * first seen together with a built-in candidate comes after it. With no
 * provider, entry is the built-in order alone. Each carries `allowed()`, its
 * kind's entry gate.
 * @param {number} [nowMs]
 * @returns {Array<{kind: string, id: string, seenAtMs: number, order: number,
 *   allowed: () => boolean, provider?: object, candidate?: object}>}
 */
export function entryCandidates(nowMs = performance.now()) {
  const seen = (this._entrySeen ??= new Map());
  const list = [];
  const note = (kind, id, entry, selectedAt = null) => {
    const last = seen.get(kind);
    // A provider's token says when its subject was selected: a new id under
    // the same token (a train handed to another feed's copy of it) is not a
    // new selection. Without a token, a new id is.
    if (
      !last ||
      last.selectedAt !== selectedAt ||
      (selectedAt === null && last.id !== id)
    )
      seen.set(kind, { id, selectedAt, atMs: nowMs });
    else if (last.id !== id) seen.set(kind, { ...last, id });
    list.push({ kind, id, seenAtMs: seen.get(kind).atMs, ...entry });
  };
  const aircraft = this.readAircraftInfo();
  if (aircraft && this.viewer.trackedEntity?.position)
    note(
      'aircraft',
      String(
        this.viewer.trackedEntity.gevTrackedId ||
          aircraft.icao24 ||
          aircraft.id ||
          'aircraft',
      ),
      {
        order: BUILT_IN_ENTRY_ORDER.aircraft,
        allowed: () => this.isEntryAllowed(),
      },
    );
  const satellite = this.readSatelliteInfo();
  if (satellite)
    note('satellite', String(satellite.noradId ?? satellite.id ?? ''), {
      order: BUILT_IN_ENTRY_ORDER.satellite,
      allowed: () => this.isOrbitEntryAllowed(),
    });
  const vessel = this.readVesselInfo();
  if (vessel)
    note('vessel', String(vessel.id ?? ''), {
      order: BUILT_IN_ENTRY_ORDER.vessel,
      allowed: () => this.isBridgeEntryAllowed(),
    });
  this.subjectProviders.forEach((provider, index) => {
    const candidate = this.readSubjectCandidate(provider);
    if (candidate)
      note(
        provider.kind,
        candidate.id,
        {
          order: 3 + index,
          provider,
          candidate,
          allowed: () => this.isSubjectEntryAllowed(provider, candidate),
        },
        candidate.selectedAt,
      );
  });
  // A subject gone and back counts as selected again.
  for (const kind of [...seen.keys()])
    if (!list.some((entry) => entry.kind === kind)) seen.delete(kind);
  const builtIns = list
    .filter((entry) => !entry.provider)
    .sort((a, b) => a.order - b.order);
  const provided = list
    .filter((entry) => entry.provider)
    .sort((a, b) => b.seenAtMs - a.seenAtMs || a.order - b.order);
  const builtInSeenAtMs = Math.max(
    -Infinity,
    ...builtIns.map((entry) => entry.seenAtMs),
  );
  const later = provided.filter((entry) => entry.seenAtMs > builtInSeenAtMs);
  const earlier = provided.filter((entry) => entry.seenAtMs <= builtInSeenAtMs);
  return [...later, ...builtIns, ...earlier];
}

/**
 * The subject entry would ride: the first in entry order (entryCandidates).
 * It decides alone, so when its own gate is shut entry is unavailable rather
 * than taken by the next one.
 * @returns {object|null} An entry of entryCandidates, or null.
 */
export function resolveEntry(nowMs = performance.now()) {
  return this.entryCandidates(nowMs)[0] ?? null;
}

/**
 * The layer the active view rides: Live AIS Vessels on a bridge, Satellites
 * in orbit, a provider's own layer, else the aircraft's own layer. It is read
 * from the tracked entity's id once the layer has dropped its tracking, so a
 * layer turned off still names itself.
 * @returns {string|null}
 */
export function readSubjectLayerId() {
  if (!this.active) return null;
  if (this.subjectProvider) return this.subjectProvider.layerId;
  if (this.subjectKind === 'vessel') return 'ais-live-vessels';
  if (this.subjectKind === 'satellite') return 'satellites';
  const layerId = this.readAircraftInfo()?.layerId;
  if (layerId) return layerId;
  const [prefix] = String(this.trackedEntity?.gevTrackedId || '').split(':');
  return ['flights', 'military'].includes(prefix) ? prefix : null;
}

/**
 * The kind entry would take, the first in entry order's (resolveEntry): a
 * Cesium-tracked aircraft, the tracked satellite, the selected vessel or a
 * provider's candidate.
 * @returns {string|null}
 */
export function resolveEntryKind() {
  return this.resolveEntry()?.kind ?? null;
}

export function dispatchCockpitModeChanged(active, info = null) {
  const subjectId = active
    ? String(
        info?.icao24 ||
          (info?.kind === 'vessel' || info?.generic === true ? info.id : '') ||
          info?.noradId ||
          '',
      )
        .trim()
        .toLowerCase() || null
    : null;
  const layerId =
    active &&
    (['flights', 'military', 'ais-live-vessels', 'satellites'].includes(
      info?.layerId,
    ) ||
      (info?.generic === true &&
        this.subjectProviders.some(
          (provider) => provider.layerId === info.layerId,
        )))
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

/**
 * Word the ridden provider subject's labels and Look ahead button again,
 * after a change of the page's language: a provider may give them as
 * functions (cockpitSubjectProviders).
 */
export function refreshSubjectWords() {
  const provider = this.subjectProvider;
  if (!this.active || !provider) return;
  this.presence.subjectLabels = { ...provider.labels };
  const look = provider.look;
  this.presence.subjectLook = look ? { aheadLabel: look.aheadLabel } : null;
  this.publishPresenceView();
}

export function syncEntry() {
  if (this.destroyed) return false;
  if (this.active) return;
  const candidates = this.entryCandidates(performance.now());
  const tracked = candidates.some(({ kind }) => kind === 'aircraft');
  this.syncTr3bToggle(tracked ? this.readAircraftInfo() : null);
  // The first in entry order decides alone (resolveEntry).
  const chosen = candidates[0] ?? null;
  const entryKind = chosen?.allowed() ? chosen.kind : null;
  const face =
    entryKind && chosen.provider
      ? (chosen.candidate.face ?? chosen.provider.entryFace)
      : null;
  const available = entryKind !== null;
  // Change-only publishes: this runs on a preUpdate cadence, and a fresh
  // presence every frame would re-render the views even when nothing
  // changed. (perf item 9)
  if (
    this.presence.entryAvailable === available &&
    this.presence.entryKind === entryKind &&
    this.presence.entryFace?.icon === face?.icon &&
    this.presence.entryFace?.label === face?.label
  )
    return;
  this.presence.entryAvailable = available;
  this.presence.entryKind = entryKind;
  this.presence.entryFace = face && { icon: face.icon, label: face.label };
  this.publishPresenceView();
}

export function navigateContext(direction, options = {}) {
  if (this.destroyed) return false;
  // Contact navigation moves between aircraft; a bridge does not jump ship,
  // an orbital view stays with its satellite and a provider's view with its
  // subject.
  if (
    this.subjectKind === 'vessel' ||
    this.subjectKind === 'satellite' ||
    this.subjectProvider
  )
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
  // An aircraft tracked from the bridge, from orbit or from a provider's view
  // ends that view (see the camera updates); it is never adopted as its
  // subject.
  if (
    this.subjectKind === 'vessel' ||
    this.subjectKind === 'satellite' ||
    this.subjectProvider
  )
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
 * Enter a provider's view on its candidate: hold it, read a first frame, then
 * take the camera as the built-in views do. Entry fails when the gate is shut,
 * the hold answers anything but `true` or no frame comes; past the gate, a
 * failed entry releases the subject, since the hold may have taken it.
 * @param {object} provider From cockpitSubjectProviders.
 * @returns {boolean}
 */
function enterSubject(provider) {
  const candidate = this.readSubjectCandidate(provider);
  if (!candidate || !this.isSubjectEntryAllowed(provider, candidate))
    return false;
  const failed = {};
  const release = () =>
    this.callSubject(provider, 'release', [candidate.id, { restore: false }]);
  // An asynchronous hold may land after it was refused: it is released
  // again once it settles, unless this subject is being ridden by then.
  const releaseLate = () => {
    if (
      this.active &&
      this.subjectProvider === provider &&
      this.subjectId === candidate.id
    )
      return;
    release();
  };
  const held = this.callSubject(
    provider,
    'hold',
    [candidate.id],
    failed,
    releaseLate,
  );
  if (held !== true) {
    // `false` refuses entry; a hold that threw, returned a promise or
    // answered anything else (warned of once) may still have taken the
    // subject. Each is released.
    if (held !== false && held !== failed)
      this.callSubject.warnOnce(
        provider,
        'hold',
        'must return true or false; entry refused',
        held,
      );
    release();
    return false;
  }
  const frame = cockpitSubjectFrame(
    this.callSubject(
      provider,
      'read',
      [performance.now(), this.subjectContext()],
      null,
    ),
    candidate.id,
  );
  if (!frame) {
    this.callSubject(provider, 'release', [candidate.id, { restore: false }]);
    return false;
  }
  this.entryFocusOrigin =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  this.onCameraTakeover?.();
  this.viewer.camera.cancelFlight();
  this.subjectKind = provider.kind;
  this.subjectProvider = provider;
  this.subjectId = candidate.id;
  this.lastSubjectFrame = frame;
  this.subjectHud = null;
  this.subjectSignalKeys = new Set();
  this.vesselWaterline = null;
  this.vesselFix = null;
  this.trackedEntity = null;
  this.heading = normalizeHeading(
    frame.headingDeg ?? cameraHeadingDeg(this.viewer.camera),
  );
  this.lastFrameMs = performance.now();
  this.lastCameraUpdateMs = 0;
  this.lastHudUpdateMs = 0;
  this.lastContextUpdateMs = 0;
  this.contextNavigationDeadlineMs = 0;
  this.lastGroundProbeMs = 0;
  this.surfaceWaitStartedMs = 0;
  this.surfaceAcquiring = false;
  this.surfaceFallback = false;
  this.cockpitAnchorValid = false;
  this.subjectHeightM = null;
  this.lookRestPitchDeg = provider.look?.restPitchDeg ?? null;
  this.resetLook({ immediate: true });
  this.active = true;
  this.services.holdContinuousRender('cockpit');
  this.viewer.trackedEntity = undefined;
  this.viewer.scene.screenSpaceCameraController.enableInputs = false;
  document.body.classList.add('cockpit-mode', 'cockpit-subject');
  this._tr3bSignature = null;
  Object.assign(this.presence, {
    active: true,
    entryAvailable: false,
    entryKind: null,
    entryFace: null,
    subjectKind: provider.kind,
    subjectGeneric: true,
    subjectLabels: { ...provider.labels },
    subjectLook: provider.look
      ? { aheadLabel: provider.look.aheadLabel }
      : null,
    tr3b: null,
  });
  this.publishPresenceView();
  this.publishRadar(null);
  this.signalItems = [];
  this.signalSignatures.clear();
  this.showBriefPage(0);
  this.startBriefRotation();
  this.pushCockpitSignal('track', 'track', t('TRACK ACQUIRED'), frame.name);
  const info = this.subjectInfo(frame);
  this.updateHud(info, performance.now(), true);
  this.setVisionMode(this.getInitialVisionMode());
  this.scheduleContextLayout();
  Promise.resolve().then(() => {
    if (this.active && !this.destroyed)
      this.mapViewButton?.focus({ preventScroll: true });
  });
  this.onEntered?.();
  this.onRide?.(provider.layerId);
  this.dispatchCockpitModeChanged(true, info);
  return true;
}

/**
 * Enter first person on the first subject in entry order (resolveEntry): a
 * tracked aircraft, the tracked satellite's orbital view, the selected
 * vessel's bridge or an application provider's subject.
 * @param {{kind?: string|null}} [options] Restrict entry to one subject kind;
 *   voice entry is aircraft-only.
 * @returns {boolean} True when the view was entered.
 */
export function enter({ kind = null } = {}) {
  if (this.destroyed) return false;
  if (this.active) return false;
  const subjectKind = kind ?? this.resolveEntryKind() ?? 'aircraft';
  const provider = this.subjectProviders.find(
    (entry) => entry.kind === subjectKind,
  );
  if (provider) return enterSubject.call(this, provider);
  if (!['aircraft', 'satellite', 'vessel'].includes(subjectKind)) return false;
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
  const provider = this.subjectProvider;
  const providerSubject = provider ? this.subjectId : null;
  const vesselSubject = this.subjectKind === 'vessel' ? this.subjectId : null;
  const satelliteSubject =
    this.subjectKind === 'satellite' ? this.subjectId : null;
  this.active = false;
  this.subjectKind = null;
  this.subjectProvider = null;
  this.lastSubjectFrame = null;
  this.subjectHud = null;
  this.lookRestPitchDeg = null;
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
    'cockpit-subject',
  );
  // The camera's own field of view returns before any follow resumes.
  this.endOrbital();
  this.onExited?.();
  this.publishUtilityLayout(null);
  this.presence.active = false;
  this.presence.subjectKind = null;
  this.presence.subjectGeneric = false;
  this.presence.subjectLabels = null;
  this.presence.subjectLook = null;
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
  // The provider gives its subject back; `restore` asks it to bring the map
  // back to it, as the built-in kinds' refocus does.
  if (provider)
    this.callSubject(provider, 'release', [
      providerSubject,
      { restore: restoreTracking === true },
    ]);
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
