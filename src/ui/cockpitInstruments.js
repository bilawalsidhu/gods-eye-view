/** Instrument values, routes and vision controls for the Cockpit controller. */
import { formatNumber, t } from '../i18n/index.js';
import {
  COCKPIT_VISION_MODES,
  normalizeCockpitVisionMode,
} from '../cockpitVisionPolicy.js';
import {
  altitudeRulerCurveInset,
  altitudeRulerTicks,
  bearingBetweenCoordinates,
  cockpitAltitudeDisplayFt,
  cockpitUiUpdateDue,
  compassDivisions,
  compassMarkerSlot,
  scrollingCompassDivisions,
  formatAltitudeRulerTick,
  formatCompassDivision,
  formatCockpitEmergency,
  formatHeadingReadout,
  formatSpeedRulerTick,
  normalizeHeading,
  relativeBearing,
  speedRulerTicks,
} from '../cockpitMath.js';
import {
  COCKPIT_CONTEXT_UPDATE_MS,
  cockpitUnitCase,
  compassPointLabel,
  formatCockpitCoordinate,
} from './cockpitPresentation.js';
import { createVisionState } from './cockpitInstrumentState.js';
import { unitLabel } from './unitLabels.js';
import {
  VESSEL_BRIDGE_PITCH_DEG,
  vesselCameraProfile,
} from '../cockpitSubjects.js';
import { lookIsOffset, lookReadoutParts, wrapLookYaw } from '../cockpitLook.js';
import { cockpitSubjectHudView } from '../cockpitSubjectProviders.js';
import {
  RADAR_MAX_CONTACTS,
  radarPicture,
  radarRangeM,
  radarRangeNm,
} from '../cockpitRadar.js';

/** A transponder status name (src/data/aircraftEmergency.js) for the HUD. */
const emergencyLabel = ({ name }) => t(name).toUpperCase();

/** The emergency line in the active language (see cockpitMath.js). */
const LOCALIZED_EMERGENCY = Object.freeze({
  squawk: (parts) =>
    t('SQUAWK {code} · {status}', {
      code: parts.squawk,
      status: emergencyLabel(parts),
    }),
  adsb: (parts) =>
    parts.priority
      ? t('ADS-B PRIORITY · {status}', { status: emergencyLabel(parts) })
      : t('ADS-B EMERGENCY · {status}', { status: emergencyLabel(parts) }),
});

/** Place a rim's ticks; a tick with no reading hides and keeps its place. */
function placeRimTicks(ticks, readings, label) {
  ticks.forEach((tick, index) => {
    const reading = readings[index];
    tick.hidden = !reading;
    if (!reading) return;
    tick.slot = reading.slot.toFixed(4);
    tick.depth = reading.depth.toFixed(4);
    tick.curve = altitudeRulerCurveInset(reading.slot).toFixed(5);
    tick.major = reading.major;
    tick.label = label(reading);
  });
}

export function publishInstrumentsView() {
  const view = this.instruments;
  const rim = (state) => ({
    ...state,
    ticks: state.ticks.map((tick) => ({ ...tick })),
  });
  this.publishInstruments({
    ...view,
    meta: { ...view.meta },
    speed: view.speed && { ...view.speed },
    altitude: view.altitude && { ...view.altitude },
    course: view.course && { ...view.course },
    heading: view.heading && { ...view.heading },
    speedRim: rim(view.speedRim),
    altitudeRim: rim(view.altitudeRim),
    compass: view.compass.map((division) => ({ ...division })),
    compassMarkers: { ...view.compassMarkers },
    look: { ...view.look },
    // A provider's view model is rebuilt on each HUD update, never edited
    // in place, so it is published as it stands.
    readouts: view.readouts,
    sources: view.sources,
    banner: view.banner,
    veil: view.veil,
    progress: view.progress,
  });
}

/** Word a bridge look's readout parts (see `lookReadoutParts`). */
function wordLook({ side, bearingDeg, elevation, angleDeg }) {
  const bearing = formatHeadingReadout(bearingDeg);
  const angle = formatNumber(angleDeg);
  let direction = '';
  if (side === 'starboard') direction = t('LOOK STBD {bearing}°', { bearing });
  else if (side === 'port') direction = t('LOOK PORT {bearing}°', { bearing });
  else if (side === 'astern') direction = t('LOOK ASTERN');
  let tilt = '';
  if (elevation === 'up') tilt = t('UP {angle}°', { angle });
  else if (elevation === 'down') tilt = t('DOWN {angle}°', { angle });
  else if (elevation === 'level') tilt = t('LEVEL');
  if (direction && tilt)
    return t('{direction} · {elevation}', { direction, elevation: tilt });
  if (tilt) return t('LOOK {elevation}', { elevation: tilt });
  return direction;
}

/**
 * Present the bridge look target: whether the view is turned off the bow,
 * its yaw for the radar and its worded readout. Outside a bridge the look
 * always rests. The caller publishes.
 */
export function presentLook() {
  const target = this.lookTarget;
  // A provider's view words its own readout (its HUD view's `lookReadout`).
  const provider = Boolean(this.subjectProvider);
  const rest = provider ? this.lookRestPitch : VESSEL_BRIDGE_PITCH_DEG;
  const offset =
    (this.active && this.subjectKind === 'vessel') ||
    (provider && this.looksAround)
      ? lookIsOffset(target, rest)
      : false;
  this.instruments.look = offset
    ? {
        offset: true,
        yawDeg: wrapLookYaw(target.yawDeg),
        readout: provider
          ? (this.subjectHud?.lookReadout ?? '')
          : wordLook(lookReadoutParts(target, VESSEL_BRIDGE_PITCH_DEG)),
      }
    : { offset: false, yawDeg: 0, readout: '' };
}

/** Live Signals' tone for a provider's signal row. */
const SUBJECT_SIGNAL_TONES = Object.freeze({
  warning: 'warning',
  alert: 'warning',
});

/**
 * Present a provider subject's HUD: its view model (cockpitSubjectHudView)
 * in the generic readouts, the compass at the camera's heading, the route
 * card, and its signals in Live Signals. A HUD view that is null, a `hud()`
 * that throws, or a view whose reading throws keeps the last one. Contact
 * navigation stays with aircraft, so the Contact card is withdrawn.
 */
function updateSubjectHud(info, nowMs, forceContext) {
  const provider = this.subjectProvider;
  this.lastSubjectInfo = info;
  const frame = this.lastSubjectFrame;
  const look = {
    yawDeg: this.lookTarget?.yawDeg ?? 0,
    pitchDeg: this.lookTarget?.pitchDeg ?? 0,
    offset:
      this.looksAround && lookIsOffset(this.lookTarget, this.lookRestPitch),
  };
  const raw = frame
    ? this.callSubject(
        provider,
        'hud',
        [frame, Object.freeze({ ...this.subjectContext(), look })],
        null,
      )
    : null;
  if (raw != null)
    this.subjectHud = cockpitSubjectHudView(raw) ?? this.subjectHud;
  const hud = this.subjectHud ?? cockpitSubjectHudView(null);
  const view = this.instruments;
  view.kind = 'subject';
  view.trackSource = null;
  view.kicker = hud.kicker || provider.labels.kicker;
  view.callsign = hud.title || info.name || '';
  // While the floor under a subject with no height is acquired
  // (cockpitCamera.js), the meta line says so in place of the provider's.
  const acquiring = this.surfaceAcquiring === true;
  view.meta.text = acquiring ? t('ACQUIRING SURFACE') : hud.meta.text;
  view.meta.tone = acquiring ? 'warning' : hud.meta.tone;
  view.meta.emergency = !acquiring && hud.meta.tone === 'alert';
  const speed = hud.speed?.value ?? null;
  view.speed = hud.speed
    ? {
        text: speed === null ? '---' : formatNumber(Math.round(speed)),
        value: speed === null ? null : Math.round(speed),
        immediate: forceContext,
      }
    : null;
  view.speedUnit = hud.speed?.unit ?? '';
  view.speedTag = hud.speed?.tag ?? '';
  view.speedTone = hud.speed?.tone ?? 'normal';
  view.speedRim.unavailable = true;
  view.altitude = null;
  view.altitudeRim.unavailable = true;
  view.course = null;
  const heading = normalizeHeading(this.heading ?? info.track ?? 0);
  view.heading = {
    text: formatHeadingReadout(heading),
    value: heading,
    immediate: forceContext,
  };
  const viewHeading = normalizeHeading(
    heading + (provider.look ? (this.lookView?.yawDeg ?? 0) : 0),
  );
  view.compass = scrollingCompassDivisions(viewHeading).map((division) => ({
    slot: division.slot,
    heading: division.heading,
    active: division.nearest,
    label: compassPointLabel(formatCompassDivision(division.heading)),
  }));
  view.compassMarkers = {
    prograde: compassMarkerSlot(heading, viewHeading),
    retrograde: compassMarkerSlot(heading + 180, viewHeading),
  };
  view.clock = new Date().toISOString().slice(11, 19) + 'Z';
  view.position = `${formatCockpitCoordinate(info.latitude, 'N', 'S')} · ${formatCockpitCoordinate(info.longitude, 'E', 'W')}`;
  view.readouts = hud.readouts;
  view.sources = hud.sources;
  view.banner = hud.banner;
  view.veil = hud.veil;
  view.progress = hud.progress;
  view.lookEnabled = Boolean(provider.look);
  view.layer = provider.layerId;
  this.presentLook();
  this.publishInstrumentsView();
  const route = this.routeView;
  route.kind = 'subject';
  route.title = hud.route?.title ?? '';
  route.from = hud.route?.from ?? '';
  route.to = hud.route?.to ?? '';
  route.status = hud.route?.status ?? '';
  route.visible = Boolean(hud.route);
  // No destination arrow; clearing also publishes the card.
  this.clearPredictiveRoute();
  if (
    forceContext ||
    cockpitUiUpdateDue(
      nowMs,
      this.lastContextUpdateMs,
      COCKPIT_CONTEXT_UPDATE_MS,
    )
  ) {
    this.lastContextUpdateMs = nowMs;
    this.updateLocalPosition(info);
    this.maybeRefreshRegionalBrief(info);
    this.showContextCard(false);
    const keys = new Set();
    for (const signal of hud.signals) {
      const key = `subject:${signal.id}`;
      keys.add(key);
      this.pushCockpitSignal(
        key,
        SUBJECT_SIGNAL_TONES[signal.tone] ?? 'info',
        signal.title,
        signal.detail || signal.title,
      );
    }
    for (const key of this.subjectSignalKeys ?? [])
      if (!keys.has(key)) this.dropCockpitSignal(key);
    this.subjectSignalKeys = keys;
  }
}

export function updateHud(
  info,
  nowMs = performance.now(),
  forceContext = false,
) {
  if (this.subjectProvider && info?.generic === true) {
    updateSubjectHud.call(this, info, nowMs, forceContext);
    return;
  }
  if (info?.kind === 'vessel') {
    updateVesselHud.call(this, info, nowMs, forceContext);
    return;
  }
  // The orbital view keeps its own HUD (CockpitOrbital).
  if (info?.kind === 'satellite') {
    this.updateOrbitalHud(info, nowMs);
    return;
  }
  this.lastSubjectInfo = info;
  const view = this.instruments;
  view.kind = 'aircraft';
  view.trackSource = null;
  view.course = null;
  const heading = normalizeHeading(this.heading ?? info.track ?? 0);
  view.callsign =
    info.callsign || info.registration || info.icao24 || t('AIRCRAFT');
  const speedKt = Number.isFinite(info.velocityMps)
    ? info.velocityMps * 1.94384
    : null;
  view.speed = {
    text: formatSpeedRulerTick(speedKt),
    value: speedKt,
    immediate: forceContext,
  };
  view.speedRim.unavailable = speedKt === null;
  view.speedRim.value = formatSpeedRulerTick(speedKt);
  placeRimTicks(
    view.speedRim.ticks,
    speedRulerTicks(speedKt, view.speedRim.ticks.length),
    (tick) => formatSpeedRulerTick(tick.valueKt),
  );
  const altitudeFt = cockpitAltitudeDisplayFt(info.altitudeM, info.onGround);
  const displayedAltitudeFt = Number.isFinite(altitudeFt)
    ? Math.round(altitudeFt)
    : null;
  view.altitude = {
    text:
      displayedAltitudeFt !== null
        ? formatNumber(displayedAltitudeFt)
        : '-----',
    value: displayedAltitudeFt,
    immediate: forceContext,
  };
  view.altitudeRim.unavailable = altitudeFt === null;
  view.altitudeRim.value = formatAltitudeRulerTick(altitudeFt);
  placeRimTicks(
    view.altitudeRim.ticks,
    altitudeRulerTicks(altitudeFt, view.altitudeRim.ticks.length),
    (tick) => formatAltitudeRulerTick(tick.valueFt),
  );
  view.heading = {
    text: formatHeadingReadout(heading),
    value: heading,
    immediate: forceContext,
  };
  view.compass = compassDivisions(heading).map((division, index) => ({
    slot: index - 3,
    label: compassPointLabel(formatCompassDivision(division)),
  }));
  view.compassMarkers = { prograde: null, retrograde: null };
  view.clock = new Date().toISOString().slice(11, 19) + 'Z';
  const lat = Number.isFinite(info.latitude)
    ? formatCockpitCoordinate(info.latitude, 'N', 'S')
    : '--';
  const lon = Number.isFinite(info.longitude)
    ? formatCockpitCoordinate(info.longitude, 'E', 'W')
    : '--';
  view.position = `${lat} · ${lon}`;
  const feedState = this.surfaceAcquiring
    ? t('ACQUIRING SURFACE')
    : this.surfaceFallback
      ? t('SURFACE FALLBACK')
      : info.stale
        ? t('STALE FEED')
        : t('LIVE TRACK');
  const aircraftClass =
    info.layerId === 'military' ? t('MILITARY') : t('COMMERCIAL');
  const emergency = formatCockpitEmergency(info.emergency, LOCALIZED_EMERGENCY);
  view.meta.text = emergency
    ? t('{aircraftClass} · {emergency} · {feedState}', {
        aircraftClass,
        emergency,
        feedState,
      })
    : t('{aircraftClass} · {feedState} · COURSE ALIGNED', {
        aircraftClass,
        feedState,
      });
  view.meta.emergency = info.emergency?.severity === 'emergency';
  view.layer = info.layerId || 'flights';
  this.publishInstrumentsView();
  this.updateRoute(info);
  if (
    forceContext ||
    cockpitUiUpdateDue(
      nowMs,
      this.lastContextUpdateMs,
      COCKPIT_CONTEXT_UPDATE_MS,
    )
  ) {
    this.lastContextUpdateMs = nowMs;
    this.updateLocalPosition(info);
    this.maybeRefreshRegionalBrief(info);
    this.updateContext(info, heading);
  }
}

/**
 * Present the bridge readouts: speed and course over ground, true heading,
 * the vessel type and its assumed eye height. Contact navigation and Live
 * Signals stay aircraft-only, so the Contact card is withdrawn.
 */
function updateVesselHud(info, nowMs, forceContext) {
  this.lastSubjectInfo = info;
  const view = this.instruments;
  view.kind = 'vessel';
  view.trackSource = info.trackSource ?? null;
  // A ship reporting neither heading nor course has no heading to read out
  // and no bow to mark; the tape still follows the camera.
  const headingKnown = Number.isFinite(info.track);
  const cameraHeading = normalizeHeading(this.heading ?? info.track ?? 0);
  const heading = headingKnown ? cameraHeading : null;
  view.callsign = info.name;
  const speedKt = Number.isFinite(info.speedKt)
    ? Math.max(0, info.speedKt)
    : null;
  view.speed = {
    text: formatSpeedRulerTick(speedKt),
    value: speedKt,
    immediate: forceContext,
  };
  view.speedRim.unavailable = speedKt === null;
  view.speedRim.value = formatSpeedRulerTick(speedKt);
  placeRimTicks(
    view.speedRim.ticks,
    speedRulerTicks(speedKt, view.speedRim.ticks.length),
    (tick) => formatSpeedRulerTick(tick.valueKt),
  );
  view.altitude = null;
  view.altitudeRim.unavailable = true;
  const course = Number.isFinite(info.course)
    ? normalizeHeading(info.course)
    : null;
  view.course = {
    text: formatHeadingReadout(course),
    value: course,
    immediate: forceContext,
  };
  view.heading = {
    text: formatHeadingReadout(heading),
    value: heading,
    immediate: forceContext,
  };
  // Looking around turns the tape with the camera; the readout above it
  // keeps the ship's heading, and the bow and stern marks stay on the ship.
  const viewHeading = normalizeHeading(
    cameraHeading + (this.lookView?.yawDeg ?? 0),
  );
  // The tape scrolls continuously, so the caret reads the view's exact
  // heading and the marks sit at their true bearings from it.
  view.compass = scrollingCompassDivisions(viewHeading).map((division) => ({
    slot: division.slot,
    heading: division.heading,
    active: division.nearest,
    label: compassPointLabel(formatCompassDivision(division.heading)),
  }));
  view.compassMarkers = headingKnown
    ? {
        prograde: compassMarkerSlot(heading, viewHeading),
        retrograde: compassMarkerSlot(heading + 180, viewHeading),
      }
    : { prograde: null, retrograde: null };
  view.clock = new Date().toISOString().slice(11, 19) + 'Z';
  view.position = `${formatCockpitCoordinate(info.latitude, 'N', 'S')} · ${formatCockpitCoordinate(info.longitude, 'E', 'W')}`;
  const eyeHeightM = vesselCameraProfile(info).upM;
  view.meta.text = t('{vesselType} · {feedState} · EYE {height}', {
    vesselType: info.typeLabel || t('VESSEL'),
    feedState: info.stale ? t('STALE FEED') : t('LIVE AIS'),
    height: `${formatNumber(Math.round(eyeHeightM))} ${cockpitUnitCase(unitLabel('m'))}`,
  });
  view.meta.emergency = false;
  view.layer = info.layerId;
  // Reworded here too, so a language switch reaches the look readout.
  this.presentLook();
  this.publishInstrumentsView();
  updateVesselRoute.call(this, info);
  if (
    forceContext ||
    cockpitUiUpdateDue(
      nowMs,
      this.lastContextUpdateMs,
      COCKPIT_CONTEXT_UPDATE_MS,
    )
  ) {
    this.lastContextUpdateMs = nowMs;
    this.updateLocalPosition(info);
    this.maybeRefreshRegionalBrief(info);
    this.updateRadar(info);
    this.showContextCard(false);
    this.pushCockpitSignal(
      'context-status',
      'info',
      t('CONTACT NAVIGATION OFF'),
      t('THE BRIDGE STAYS WITH THE SELECTED VESSEL'),
    );
  }
}

/**
 * Publish the bridge radar: nearby AIS vessels drawn heading-up from the
 * camera's current heading, within the chosen range. Own ship sits where
 * the camera rides (its fix dead-reckoned); contacts sit at their last
 * fixes, where the vessel layer draws them, so the scope matches the
 * window.
 * @param {object} info The vessel subject (`readVesselInfo`).
 */
export function updateRadar(info) {
  const layer = this.services.aisLiveVesselsLayer;
  if (!info || typeof layer?.getRadarContacts !== 'function') {
    this.publishRadar(null);
    return;
  }
  const rangeNm = radarRangeNm(this.radarRangeNm);
  const own = this.vesselFix ?? info;
  const contacts = layer.getRadarContacts(
    own.latitude,
    own.longitude,
    radarRangeM(rangeNm),
    RADAR_MAX_CONTACTS,
  );
  const picture = radarPicture(
    {
      latitude: own.latitude,
      longitude: own.longitude,
      headingDeg: normalizeHeading(this.heading ?? info.track ?? 0),
      courseDeg: info.course,
    },
    contacts,
    rangeNm,
  );
  this.publishRadar({
    ...picture,
    rangeLabel: t('{range} NM', { range: formatNumber(rangeNm) }),
  });
}

/** Show the AIS voyage destination; it is crew-entered text, not a place. */
function updateVesselRoute(info) {
  const route = this.routeView;
  route.kind = 'vessel';
  route.from = '';
  route.to = info.destination || t('UNKNOWN');
  route.status = t('AIS DESTINATION · CREW REPORTED');
  route.visible = Boolean(info.destination);
  // No coordinates, so no arrow; clearing also publishes the card.
  this.clearPredictiveRoute();
}

/** Publish the route card and destination arrow when either changed. */
export function publishRouteView() {
  const signature = JSON.stringify(this.routeView);
  if (signature === this.routeSignature) return;
  this.routeSignature = signature;
  this.publishRoute({
    ...this.routeView,
    direction: { ...this.routeView.direction },
  });
}

export function updateRoute(info) {
  const route = this.routeView;
  route.kind = 'aircraft';
  const origin = info?.route?.origin;
  const destination = info?.route?.destination;
  const validDestination =
    Number.isFinite(destination?.lat) && Number.isFinite(destination?.lon);
  const routeLabel = (airport) =>
    [airport?.code, airport?.name].filter(Boolean).join(' · ') || t('UNKNOWN');
  route.from = routeLabel(origin);
  route.to = routeLabel(destination);
  route.status = validDestination
    ? t('ARROW · ESTIMATED DIRECTION')
    : t('ROUTE DATA UNAVAILABLE');
  route.visible = !!(origin || destination);
  if (
    !validDestination ||
    !Number.isFinite(info?.longitude) ||
    !Number.isFinite(info?.latitude)
  ) {
    this.clearPredictiveRoute();
    return;
  }
  const destinationBearing = bearingBetweenCoordinates(
    info.latitude,
    info.longitude,
    destination.lat,
    destination.lon,
  );
  const relative = relativeBearing(
    destinationBearing,
    this.heading ?? info.track ?? 0,
  );
  if (!Number.isFinite(destinationBearing) || !Number.isFinite(relative)) {
    this.clearPredictiveRoute();
    return;
  }
  const displayedRelative = Math.max(-120, Math.min(120, relative));
  route.direction.visible = true;
  route.direction.angle = `${displayedRelative.toFixed(2)}deg`;
  route.direction.label = t('DEST {bearing}', {
    bearing: `${formatHeadingReadout(destinationBearing)}°`,
  });
  this.publishRouteView();
}

export function syncWeatherToggle(enabled) {
  this.contextView.weather = !!enabled;
  this.publishContextView();
}

export function setVisionMode(mode, { revealParameters = false } = {}) {
  const next = normalizeCockpitVisionMode(mode);
  this.visionMode = next;
  this.publishVision(createVisionState(next));
  this.onVisionChange?.(next, this.active, { revealParameters });
}

export function cycleVisionMode(direction = 1) {
  const modes = COCKPIT_VISION_MODES;
  const currentIndex = Math.max(0, modes.indexOf(this.visionMode));
  const step = direction < 0 ? -1 : 1;
  const nextIndex = (currentIndex + step + modes.length) % modes.length;
  this.setVisionMode(modes[nextIndex], { revealParameters: true });
}

export function clearPredictiveRoute() {
  this.routeView.direction.visible = false;
  this.publishRouteView();
}
