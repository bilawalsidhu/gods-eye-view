/** Instrument values, routes and vision controls for the Cockpit controller. */
import { t } from '../i18n/index.js';
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
  formatSpeedRulerTick,
  normalizeHeading,
  relativeBearing,
  speedRulerTicks,
} from '../cockpitMath.js';
import {
  COCKPIT_CONTEXT_UPDATE_MS,
  setCockpitRollingValue,
} from './cockpitPresentation.js';

export function updateHud(
  info,
  nowMs = performance.now(),
  forceContext = false,
) {
  this.lastAircraftInfo = info;
  const heading = normalizeHeading(this.heading ?? info.track ?? 0);
  if (this.callsign) {
    this.callsign.textContent =
      info.callsign ||
      info.registration ||
      info.icao24 ||
      t('cockpit.instruments.aircraftFallback');
  }
  const speedKt = Number.isFinite(info.velocityMps)
    ? info.velocityMps * 1.94384
    : null;
  setCockpitRollingValue(this.speed, formatSpeedRulerTick(speedKt), speedKt, {
    immediate: forceContext,
  });
  if (this.speedRim)
    this.speedRim.classList.toggle('unavailable', speedKt === null);
  if (this.speedRimValue)
    this.speedRimValue.textContent = formatSpeedRulerTick(speedKt);
  const speedTicks = speedRulerTicks(speedKt, this.speedRimTicks.length);
  this.speedRimTicks.forEach((element, index) => {
    const tick = speedTicks[index];
    element.hidden = !tick;
    if (!tick) return;
    element.style.setProperty('--slot', tick.slot.toFixed(4));
    element.style.setProperty('--depth', tick.depth.toFixed(4));
    element.style.setProperty(
      '--curve',
      altitudeRulerCurveInset(tick.slot).toFixed(5),
    );
    element.classList.toggle('major', tick.major);
    const label = element.querySelector('b');
    if (label) label.textContent = formatSpeedRulerTick(tick.valueKt);
  });
  const altitudeFt = cockpitAltitudeDisplayFt(info.altitudeM, info.onGround);
  if (this.altitude) {
    const displayedAltitudeFt = Number.isFinite(altitudeFt)
      ? Math.round(altitudeFt)
      : null;
    setCockpitRollingValue(
      this.altitude,
      displayedAltitudeFt !== null
        ? displayedAltitudeFt.toLocaleString('en-US')
        : '-----',
      displayedAltitudeFt,
      { immediate: forceContext },
    );
  }
  if (this.altitudeRim)
    this.altitudeRim.classList.toggle('unavailable', altitudeFt === null);
  if (this.altitudeRimValue) {
    this.altitudeRimValue.textContent = formatAltitudeRulerTick(altitudeFt);
  }
  const altitudeTicks = altitudeRulerTicks(
    altitudeFt,
    this.altitudeRimTicks.length,
  );
  this.altitudeRimTicks.forEach((element, index) => {
    const tick = altitudeTicks[index];
    element.hidden = !tick;
    if (!tick) return;
    element.style.setProperty('--slot', tick.slot.toFixed(4));
    element.style.setProperty('--depth', tick.depth.toFixed(4));
    element.style.setProperty(
      '--curve',
      altitudeRulerCurveInset(tick.slot).toFixed(5),
    );
    element.classList.toggle('major', tick.major);
    const label = element.querySelector('b');
    if (label) label.textContent = formatAltitudeRulerTick(tick.valueFt);
  });
  setCockpitRollingValue(
    this.headingValue,
    String(Math.round(heading) % 360).padStart(3, '0'),
    heading,
    { circularRange: 360, immediate: forceContext },
  );
  if (this.compassTape) {
    const divisions = compassDivisions(heading);
    const signature = divisions.join(',');
    if (signature !== this.lastCompassSignature) {
      this.lastCompassSignature = signature;
      this.compassTape.innerHTML = divisions
        .map((division, index) => {
          const slot = index - 3;
          return `<span class="${slot === 0 ? 'active' : ''}" style="--slot:${slot};--depth:${Math.abs(slot)}">${formatCompassDivision(division)}</span>`;
        })
        .join('');
    }
  }
  if (this.clock)
    this.clock.textContent = new Date().toISOString().slice(11, 19) + 'Z';
  if (this.position) {
    const lat = Number.isFinite(info.latitude)
      ? `${Math.abs(info.latitude).toFixed(3)}°${info.latitude >= 0 ? 'N' : 'S'}`
      : '--';
    const lon = Number.isFinite(info.longitude)
      ? `${Math.abs(info.longitude).toFixed(3)}°${info.longitude >= 0 ? 'E' : 'W'}`
      : '--';
    this.position.textContent = `${lat} · ${lon}`;
  }
  if (this.aircraftMeta) {
    const feedState = this.surfaceAcquiring
      ? t('cockpit.instruments.acquiringSurface')
      : this.surfaceFallback
        ? t('cockpit.instruments.surfaceFallback')
        : info.stale
          ? t('cockpit.instruments.staleFeed')
          : t('cockpit.instruments.liveTrack');
    this.aircraftMeta.textContent = `${
      info.layerId === 'military'
        ? t('cockpit.instruments.military')
        : t('cockpit.instruments.commercial')
    } · ${feedState} · ${t('cockpit.instruments.courseAligned')}`;
  }
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
  if (this.hud) this.hud.dataset.layer = info.layerId || 'flights';
}

export function updateRoute(info) {
  const origin = info?.route?.origin;
  const destination = info?.route?.destination;
  const validDestination =
    Number.isFinite(destination?.lat) && Number.isFinite(destination?.lon);
  const routeLabel = (airport) =>
    [airport?.code, airport?.name].filter(Boolean).join(' · ') ||
    t('cockpit.instruments.unknown');
  if (this.routeFrom) this.routeFrom.textContent = routeLabel(origin);
  if (this.routeTo) this.routeTo.textContent = routeLabel(destination);
  if (this.routeStatus) {
    this.routeStatus.textContent = validDestination
      ? t('cockpit.instruments.arrowEstimated')
      : t('cockpit.instruments.routeUnavailable');
  }
  if (this.route) this.route.hidden = !origin && !destination;
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
  if (this.routeDirection) {
    const displayedRelative = Math.max(-120, Math.min(120, relative));
    this.routeDirection.hidden = false;
    this.routeDirection.style.setProperty(
      '--route-angle',
      `${displayedRelative.toFixed(2)}deg`,
    );
  }
  if (this.routeDirectionLabel) {
    this.routeDirectionLabel.textContent = t('cockpit.instruments.dest', {
      n: String(Math.round(destinationBearing)).padStart(3, '0'),
    });
  }
}

export function syncWeatherToggle(enabled) {
  if (!this.weatherToggle) return;
  const active = !!enabled;
  this.weatherToggle.setAttribute('aria-pressed', String(active));
  const label = t(
    active
      ? 'cockpit.instruments.weatherDisable'
      : 'cockpit.instruments.weatherEnable',
  );
  this.weatherToggle.setAttribute('aria-label', label);
  this.weatherToggle.title = label;
  if (this.weatherState)
    this.weatherState.textContent = t(
      active ? 'cockpit.instruments.on' : 'cockpit.instruments.off',
    );
}

// DOM paint for the vision-mode presentation, split from setVisionMode so the
// locale refresh can re-apply the labels without re-triggering the shell's
// onVisionChange side effects.
export function paintVisionModePresentation(mode) {
  const next = normalizeCockpitVisionMode(mode);
  const labels = {
    optical: t('cockpit.vision.optical'),
    crt: t('cockpit.vision.crt'),
    nvg: t('cockpit.vision.nvg'),
    thermal: t('cockpit.vision.thermal'),
    anime: t('cockpit.vision.anime'),
    noir: t('cockpit.vision.noir'),
    snow: t('cockpit.vision.snow'),
  };
  const names = {
    optical: t('cockpit.vision.names.optical'),
    crt: t('cockpit.vision.names.crt'),
    nvg: t('cockpit.vision.names.nvg'),
    thermal: t('cockpit.vision.names.thermal'),
    anime: t('cockpit.vision.names.anime'),
    noir: t('cockpit.vision.names.noir'),
    snow: t('cockpit.vision.names.snow'),
  };
  if (this.visionCurrent) {
    this.visionCurrent.dataset.cockpitVision = next;
    this.visionCurrent.setAttribute(
      'aria-label',
      t('cockpit.vision.currentAria', { name: names[next] }),
    );
    this.visionCurrent.title = t('cockpit.vision.currentTitle', {
      name: names[next],
    });
  }
  if (this.visionCurrentLabel)
    this.visionCurrentLabel.textContent = labels[next];
}

export function setVisionMode(mode, { revealParameters = false } = {}) {
  const next = normalizeCockpitVisionMode(mode);
  this.visionMode = next;
  paintVisionModePresentation.call(this, next);
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
  if (this.routeDirection) this.routeDirection.hidden = true;
}
