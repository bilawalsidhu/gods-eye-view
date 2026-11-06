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
  compassPointLabel,
  formatCockpitCoordinate,
} from './cockpitPresentation.js';
import { createVisionState } from './cockpitInstrumentState.js';

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
    heading: view.heading && { ...view.heading },
    speedRim: rim(view.speedRim),
    altitudeRim: rim(view.altitudeRim),
    compass: view.compass.map((division) => ({ ...division })),
  });
}

export function updateHud(
  info,
  nowMs = performance.now(),
  forceContext = false,
) {
  this.lastAircraftInfo = info;
  const view = this.instruments;
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
