/**
 * Cockpit view controller — the HUD's aircraft/vehicle cockpit mode.
 *
 * Extracted verbatim from src/ui.js (Batch 5): the controller is a
 * self-contained class instantiated once by StyleManager. StyleManager stays
 * the owner of cockpit MODE authority (voice actions call
 * styleManager.controlCockpit); this module owns the live HUD loop — camera
 * takeover, HUD/context readouts, vision modes, signal stream, and the
 * regional brief carousel.
 */
import * as Cesium from 'cesium';
import {
  altitudeRulerCurveInset,
  altitudeRulerTicks,
  bearingBetweenCoordinates,
  cockpitAltitudeDisplayFt,
  cockpitAnchorCorrectionStep,
  cockpitGroundSafeHeight,
  cockpitSurfaceWaitExpired,
  cockpitUiUpdateDue,
  compassTapeLayout,
  formatAltitudeRulerTick,
  formatCockpitContextScope,
  formatCompassDivision,
  formatSpeedRulerTick,
  normalizeHeading,
  relativeBearing,
  resolveCockpitContextReadout,
  resolveTrackedAircraftInfo,
  slewHeading,
  speedRulerTicks,
} from '../cockpitMath.js';
import {
  resolveCockpitUtilityAnchor,
  resolveCockpitUtilityLayout,
} from '../cockpitUtilityLayout.js';
import {
  COCKPIT_VISION_MODES,
  normalizeCockpitVisionMode,
} from '../cockpitVisionPolicy.js';
import { holdContinuousRender, releaseContinuousRender } from '../renderGovernor.js';
import flightsLayer from '../data/flights.js';
import militaryFlightsLayer from '../data/militaryFlights.js';
import { isTr3b, toggleTr3b } from '../data/tr3bRegistry.js';
import militaryAwarenessLayer from '../data/militaryAwareness.js';
import { formatAwarenessLabel } from '../data/militaryAwarenessEngine.js';
import {
  cachedGroundFloor,
  cachedMeshFloor,
  GROUND_FLOOR_LIFT_M,
  meshFloorPreferred,
  warmGroundFloor,
} from '../data/groundFloor.js';
import { sampleMeshFloorCells } from '../data/meshFloorSampler.js';
import {
  fetchRegionalBrief,
  regionalDistanceM,
  weatherCodeLabel,
} from '../data/regionalBrief.js';

const COCKPIT_HEADING_SLEW_DPS = 28;
const COCKPIT_FORWARD_OFFSET_M = 7;
const COCKPIT_UP_OFFSET_M = 2.6;
const COCKPIT_MIN_GROUND_CLEARANCE_M = 12;
const COCKPIT_VIEW_PITCH_DEG = -4;
const COCKPIT_CAMERA_UPDATE_MS = 50;
const COCKPIT_HUD_UPDATE_MS = 100;
const COCKPIT_CONTEXT_UPDATE_MS = 250;
export const COCKPIT_LAYOUT_SETTLE_MS = 240;
// Cockpit's Display/Radio strip hangs off the REC readout it shares the right
// margin with, and never touches the briefing card underneath it.
const COCKPIT_UTILITY_REC_GAP_PX = 12;
const COCKPIT_UTILITY_SIGNAL_GAP_PX = 8;
const COCKPIT_UTILITY_MIN_TOP_PX = 96;
const COCKPIT_UTILITY_MIN_TOP_RATIO = 0.12;
const COCKPIT_UTILITY_LAUNCHER_MIN_HEIGHT_PX = 50;
const COCKPIT_GROUND_PROBE_MS = 500;
const COCKPIT_GROUND_WAIT_TIMEOUT_MS = 5000;
const COCKPIT_BRIEF_ROTATE_MS = 9000;
const COCKPIT_BRIEF_CYCLE_OFF_HELP = 'Cycle briefing pages automatically every 9 seconds (Signals → News → Local). Pauses while you hover or focus the panel. Live signal data refreshes continuously either way.';
const COCKPIT_BRIEF_CYCLE_ON_HELP = 'Stop automatic page cycling. Previous, Next, and the SIG/NEWS/LOCAL tabs stay available.';
const COCKPIT_REGIONAL_REFRESH_MS = 5 * 60_000;
const COCKPIT_REGIONAL_REFRESH_DISTANCE_M = 25_000;
const COCKPIT_BRIEF_PAGES = [
  {
    id: 'signals',
    kicker: 'LIVE SIGNALS',
    subtitle: 'OBSERVED / MAPPED PINGS',
    source: 'SOURCE-BACKED EVENTS · NO SYNTHETIC NEWS',
  },
  {
    id: 'news',
    kicker: 'REGIONAL NEWS',
    subtitle: 'LATEST LOCATION-MATCHED REPORTING',
    source: 'GOOGLE NEWS RSS · LOCATION QUERY · RECENT',
  },
  {
    id: 'local',
    kicker: 'LOCAL INFO',
    subtitle: 'PLACE / CONDITIONS / POSITION',
    source: 'OPENSTREETMAP · OPEN-METEO · UTC',
  },
];
/**
 * Whether an element currently occupies screen space a layout must respect.
 *
 * A rect alone is not enough: `visibility: hidden` and `opacity: 0` (how the
 * Intel HUD retires as a whole) leave the rect intact, so anything anchoring to
 * a HUD readout must walk the ancestors as well.
 *
 * @param {Element|null|undefined} element - Candidate element.
 * @returns {boolean} True when the element is painted and has area.
 */
function isRenderedOnScreen(element) {
  if (!element) return false;
  for (let node = element; node instanceof Element; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
      return false;
    }
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
function formatCockpitBriefAge(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'TIME UNKNOWN';
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 60) return `${minutes}M AGO`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}H AGO` : `${Math.round(hours / 24)}D AGO`;
}

function formatCockpitWindDirection(value) {
  if (!Number.isFinite(value)) return 'DIR UNKNOWN';
  const labels = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const normalized = ((value % 360) + 360) % 360;
  return `${labels[Math.round(normalized / 45) % labels.length]} · ${Math.round(normalized)}°`;
}

function setCockpitRollingValue(element, text, numericValue, {
  circularRange = null,
  immediate = false,
} = {}) {
  if (!element) return;
  const nextText = String(text);
  const previousText = element.dataset.rollingText;
  const previousValue = Number(element.dataset.rollingValue);
  const nowMs = performance.now();
  const lastRollMs = Number(element.dataset.rollingAt);
  if (!immediate
    && previousText !== undefined
    && previousText !== nextText
    && Number.isFinite(lastRollMs)
    && nowMs - lastRollMs < 220) {
    return;
  }
  element.dataset.rollingText = nextText;
  element.dataset.rollingAt = String(nowMs);
  if (Number.isFinite(numericValue)) element.dataset.rollingValue = String(numericValue);
  else delete element.dataset.rollingValue;
  element.setAttribute('aria-label', nextText);

  if (immediate || previousText === undefined || previousText === nextText) {
    if (previousText !== nextText || !element.querySelector('.cockpit-roll-token')) {
      element.replaceChildren(...Array.from(nextText, (character) => {
        const token = document.createElement('span');
        token.className = 'cockpit-roll-token';
        token.setAttribute('aria-hidden', 'true');
        token.textContent = character;
        return token;
      }));
    }
    return;
  }

  let delta = Number.isFinite(numericValue) && Number.isFinite(previousValue)
    ? numericValue - previousValue
    : 0;
  if (Number.isFinite(circularRange) && circularRange > 0) {
    const halfRange = circularRange / 2;
    if (delta > halfRange) delta -= circularRange;
    else if (delta < -halfRange) delta += circularRange;
  }
  const direction = delta < 0 ? 'down' : 'up';
  const width = Math.max(previousText.length, nextText.length);
  const from = previousText.padStart(width, ' ');
  const to = nextText.padStart(width, ' ');
  const fragment = document.createDocumentFragment();

  for (let index = 0; index < width; index += 1) {
    const previousCharacter = from[index];
    const nextCharacter = to[index];
    const token = document.createElement('span');
    token.className = 'cockpit-roll-token';
    token.setAttribute('aria-hidden', 'true');

    if (previousCharacter === nextCharacter
      || !/\d/.test(previousCharacter)
      || !/\d/.test(nextCharacter)) {
      token.textContent = nextCharacter === ' ' ? '\u00a0' : nextCharacter;
      fragment.append(token);
      continue;
    }

    token.classList.add('is-rolling', `roll-${direction}`);
    const track = document.createElement('span');
    track.className = 'cockpit-roll-track';
    const first = document.createElement('span');
    const second = document.createElement('span');
    first.textContent = direction === 'up' ? previousCharacter : nextCharacter;
    second.textContent = direction === 'up' ? nextCharacter : previousCharacter;
    track.append(first, second);
    token.append(track);
    fragment.append(token);
  }

  element.replaceChildren(fragment);
}
export class CockpitViewController {
  constructor(viewer, {
    onVisionChange = null,
    onCameraTakeover = null,
    isEntryAllowed = null,
    onEntered = null,
    onExited = null,
    getInheritedVisionLabel = null,
    restoreTrackingFrame = null,
  } = {}) {
    this.viewer = viewer;
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
    this._tapeCenter = null;
    this._tapeSpans = null;
    this.entry = document.getElementById('cockpit-entry');
    this.tr3bToggle = document.getElementById('tr3b-toggle');
    this._tr3bSignature = null;
    this.mapViewButton = document.getElementById('map-view-switch');
    this.resetGlobeButton = document.getElementById('cockpit-reset-globe');
    this.hud = document.getElementById('cockpit-hud');
    this.entryFocusOrigin = null;
    this.callsign = document.getElementById('cockpit-callsign');
    this.speed = document.getElementById('cockpit-speed-value');
    this.speedRim = document.getElementById('cockpit-speed-rim');
    this.speedRimValue = document.getElementById('cockpit-speed-rim-value');
    this.speedRimTicks = Array.from(document.querySelectorAll('[data-speed-rim-tick]'));
    this.altitude = document.getElementById('cockpit-altitude-value');
    this.altitudeRim = document.getElementById('cockpit-altitude-rim');
    this.altitudeRimValue = document.getElementById('cockpit-altitude-rim-value');
    this.altitudeRimTicks = Array.from(document.querySelectorAll('[data-altitude-rim-tick]'));
    this.headingValue = document.getElementById('cockpit-heading-value');
    this.compassTape = document.getElementById('cockpit-compass-tape');
    this.clock = document.getElementById('cockpit-clock');
    this.position = document.getElementById('cockpit-position');
    this.aircraftMeta = document.getElementById('cockpit-aircraft-meta');
    this.route = document.getElementById('cockpit-route');
    this.routeFrom = document.getElementById('cockpit-route-from');
    this.routeTo = document.getElementById('cockpit-route-to');
    this.routeStatus = document.getElementById('cockpit-route-status');
    this.routeDirection = document.getElementById('cockpit-route-direction');
    this.routeDirectionLabel = document.getElementById('cockpit-route-direction-label');
    this.visionPrevious = document.getElementById('cockpit-vision-previous');
    this.visionCurrent = document.getElementById('cockpit-vision-current');
    this.visionCurrentLabel = document.getElementById('cockpit-vision-current-label');
    this.visionNext = document.getElementById('cockpit-vision-next');
    this.visionMode = 'optical';
    this.onVisionChange = onVisionChange;
    this.onCameraTakeover = onCameraTakeover;
    this.onEntered = onEntered;
    this.onExited = onExited;
    this.getInheritedVisionLabel = typeof getInheritedVisionLabel === 'function'
      ? getInheritedVisionLabel
      : () => 'NORMAL';
    this.restoreTrackingFrame = typeof restoreTrackingFrame === 'function'
      ? restoreTrackingFrame
      : () => false;
    this.isEntryAllowed = typeof isEntryAllowed === 'function' ? isEntryAllowed : () => true;
    this.context = document.getElementById('cockpit-context');
    this.contextSubject = document.getElementById('cockpit-context-subject');
    this.contextNearestLabel = document.getElementById('cockpit-context-nearest-label');
    this.contextBearing = document.getElementById('cockpit-context-bearing');
    this.contextDistance = document.getElementById('cockpit-context-distance');
    this.contextDirection = document.getElementById('cockpit-context-direction');
    this.contextUncertainty = document.getElementById('cockpit-context-uncertainty');
    this.contextUpdated = document.getElementById('cockpit-context-updated');
    this.contextCohorts = new Map(Array.from(document.querySelectorAll('[data-context-cohort]'))
      .map((element) => [element.dataset.contextCohort, element]));
    this.contextPrevious = document.getElementById('cockpit-context-previous');
    this.contextNext = document.getElementById('cockpit-context-next');
    this.contextToggle = document.getElementById('cockpit-context-toggle');
    this.weatherToggle = document.getElementById('cockpit-weather-toggle');
    this.weatherState = document.getElementById('cockpit-weather-state');
    this.contextCollapsed = false;
    this.signalStream = document.getElementById('cockpit-signal-stream');
    this.signalList = document.getElementById('cockpit-signal-list');
    this.signalToggle = document.getElementById('cockpit-signal-toggle');
    this.briefKicker = document.getElementById('cockpit-brief-kicker');
    this.briefSubtitle = document.getElementById('cockpit-brief-subtitle');
    this.briefPrevious = document.getElementById('cockpit-brief-previous');
    this.briefNext = document.getElementById('cockpit-brief-next');
    this.briefAutoToggle = document.getElementById('cockpit-brief-auto');
    this.briefPosition = document.getElementById('cockpit-brief-position');
    this.briefSource = document.getElementById('cockpit-brief-source');
    this.briefPages = Array.from(document.querySelectorAll('[data-cockpit-brief-page]'));
    this.briefTabs = Array.from(document.querySelectorAll('[data-cockpit-brief-index]'));
    this.newsStatus = document.getElementById('cockpit-news-status');
    this.newsList = document.getElementById('cockpit-news-list');
    this.localPlace = document.getElementById('cockpit-local-place');
    this.localCoordinates = document.getElementById('cockpit-local-coordinates');
    this.localTemperature = document.getElementById('cockpit-local-temperature');
    this.localWind = document.getElementById('cockpit-local-wind');
    this.localWindDirection = document.getElementById('cockpit-local-wind-direction');
    this.localCondition = document.getElementById('cockpit-local-condition');
    this.localCloud = document.getElementById('cockpit-local-cloud');
    this.localPrecipitation = document.getElementById('cockpit-local-precipitation');
    this.signalCollapsed = false;
    this.signalUserCollapsed = false;
    this.signalItems = [];
    this.signalSignatures = new Map();
    this.briefPageIndex = 0;
    this.briefAutoRotateEnabled = false;
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
    this._listenerRemovers = [];

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
    this._listen(this.contextPrevious, 'click', () => this.navigateContext(-1, { origin: 'user' }));
    this._listen(this.contextNext, 'click', () => this.navigateContext(1, { origin: 'user' }));
    this._listen(this.contextToggle, 'click', () => this.setContextCollapsed(!this.contextCollapsed));
    this._listen(this.weatherToggle, 'click', () => {
      const enabled = this.weatherToggle.getAttribute('aria-pressed') !== 'true';
      this.syncWeatherToggle(enabled);
      window.dispatchEvent(new CustomEvent('gev:cockpit-weather-toggle', {
        detail: { enabled },
      }));
    });
    this._listen(window, 'gev:cockpit-weather-state', (event) => {
      this.syncWeatherToggle(event?.detail?.enabled !== false);
    });
    this._listen(this.signalToggle, 'click', () => this.setSignalCollapsed(
      !this.signalCollapsed,
      { user: true },
    ));
    this._listen(this.signalList, 'click', (event) => {
      const target = event.target.closest('button[data-signal-layer][data-signal-id]');
      if (!target) return;
      event.preventDefault();
      militaryAwarenessLayer.focusTarget?.(
        target.dataset.signalLayer,
        target.dataset.signalId,
        { origin: 'user' },
      );
    });
    this._listen(this.briefPrevious, 'click', () => this.showBriefPage(this.briefPageIndex - 1, { manual: true }));
    this._listen(this.briefNext, 'click', () => this.showBriefPage(this.briefPageIndex + 1, { manual: true }));
    this._listen(this.briefAutoToggle, 'click', () => {
      this.setBriefAutoRotate(!this.briefAutoRotateEnabled);
    });
    this.briefTabs.forEach((button) => this._listen(button, 'click', () => {
      this.showBriefPage(Number(button.dataset.cockpitBriefIndex), { manual: true });
    }));
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
    this._listenerRemovers.push(() => target.removeEventListener(type, handler, options));
  }

  syncWeatherToggle(enabled) {
    if (!this.weatherToggle) return;
    const active = Boolean(enabled);
    this.weatherToggle.setAttribute('aria-pressed', String(active));
    this.weatherToggle.setAttribute(
      'aria-label',
      `${active ? 'Disable' : 'Enable'} cockpit weather effects`,
    );
    this.weatherToggle.title = `${active ? 'Disable' : 'Enable'} cockpit weather effects`;
    if (this.weatherState) this.weatherState.textContent = active ? 'ON' : 'OFF';
  }

  readAircraftInfo() {
    // In cockpit mode the controller takes the entity off `viewer.trackedEntity`
    // (see update()), so the cockpit's own handle is the tracked identity there.
    const trackedEntity = this.viewer?.trackedEntity || this.trackedEntity;
    return resolveTrackedAircraftInfo({
      civilian: flightsLayer.getTrackedInfo?.() || null,
      military: militaryFlightsLayer.getTrackedInfo?.() || null,
      trackedId: trackedEntity?.gevTrackedId || '',
    });
  }

  dispatchCockpitModeChanged(active, info = null) {
    const subjectId = active
      ? String(info?.icao24 || '').trim().toLowerCase() || null
      : null;
    const layerId = active && ['flights', 'military'].includes(info?.layerId)
      ? info.layerId
      : null;
    window.dispatchEvent(new CustomEvent('gev:cockpit-mode-changed', {
      detail: { active: active === true, subjectId, layerId },
    }));
  }

  /**
   * TR-3B Easter egg: flip the tracked contact between its real silhouette and
   * the black triangle. The registry owns the session state; the owning layer
   * re-derives what renders.
   * @returns {boolean} True when a tracked contact was converted/restored.
   */
  toggleTrackedTr3b() {
    const info = this.readAircraftInfo();
    const icao24 = String(info?.icao24 || '').trim();
    if (!icao24) return false;
    toggleTr3b(icao24);
    const layer = info.layerId === 'military' ? militaryFlightsLayer : flightsLayer;
    layer.refreshTr3b?.(icao24);
    this._tr3bSignature = null; // force the chip to repaint on the next sync
    this.syncTr3bToggle(info);
    return true;
  }

  /**
   * Show the 🛸 chip whenever a contact is tracked (its own gate — converting
   * does not depend on the cockpit entry policy) and mirror the conversion
   * state. Change-only DOM writes: this runs on the preUpdate cadence.
   * @param {object|null} info Tracked-aircraft descriptor, or null.
   */
  syncTr3bToggle(info) {
    if (!this.tr3bToggle) return;
    const icao24 = String(info?.icao24 || '').trim();
    const converted = Boolean(icao24) && isTr3b(icao24);
    const signature = icao24 ? `${icao24}:${converted ? 1 : 0}` : '';
    if (this._tr3bSignature === signature) return;
    this._tr3bSignature = signature;
    this.tr3bToggle.hidden = !icao24;
    this.tr3bToggle.setAttribute('aria-pressed', converted ? 'true' : 'false');
    this.tr3bToggle.title = converted ? 'Restore real aircraft' : 'Reclassify as TR-3B';
  }

  syncEntry() {
    if (this.active) return;
    const info = this.readAircraftInfo();
    const trackedContact = Boolean(info && this.viewer.trackedEntity?.position);
    this.syncTr3bToggle(trackedContact ? info : null);
    const available = Boolean(this.isEntryAllowed() && trackedContact);
    // Change-only DOM writes: this runs on a preUpdate cadence, and
    // unconditional `hidden` assignments invalidate style/layout every frame
    // even when nothing changed. (perf item 9)
    if (this._entryAvailable === available) return;
    this._entryAvailable = available;
    if (this.entry) this.entry.hidden = !available;
    if (this.mapViewButton) this.mapViewButton.hidden = true;
    if (this.resetGlobeButton) this.resetGlobeButton.hidden = true;
  }

  /**
   * Navigate Contacts through one Cockpit-owned funnel. A short grace window
   * covers feed-refresh handoffs where the old source releases before the new
   * source publishes its entity; trackedEntityChanged adopts synchronously as
   * soon as the replacement exists, so the normal path does not wait.
   */
  navigateContext(direction, options = {}) {
    const method = direction < 0 ? 'navigatePrevious' : 'navigateNext';
    const wasActive = this.active;
    if (wasActive) this.contextNavigationDeadlineMs = performance.now() + 1500;
    const navigationOptions = wasActive ? { ...options, aircraftOnly: true } : options;
    const changed = Boolean(militaryAwarenessLayer?.[method]?.(navigationOptions));
    if (!changed) {
      this.contextNavigationDeadlineMs = 0;
      return false;
    }
    if (wasActive) this._adoptTrackedEntity(performance.now());
    return true;
  }

  /** Adopt a newly selected aircraft without ever leaving Cockpit. */
  _adoptTrackedEntity(nowMs, suppliedInfo = null) {
    const nextEntity = this.viewer.trackedEntity;
    if (!this.active || !nextEntity?.position || nextEntity === this.trackedEntity) return false;
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

  setVisionMode(mode, { revealParameters = false } = {}) {
    const next = normalizeCockpitVisionMode(mode);
    this.visionMode = next;
    const inherited = String(this.getInheritedVisionLabel?.() || 'NORMAL').toUpperCase();
    const labels = { optical: inherited, crt: 'CRT', nvg: 'NVG', thermal: 'FLIR', noir: 'NOIR' };
    const names = { optical: inherited, crt: 'CRT', nvg: 'Night vision', thermal: 'Thermal', noir: 'Noir' };
    if (this.visionCurrent) {
      this.visionCurrent.dataset.cockpitVision = next;
      this.visionCurrent.setAttribute('aria-label', `Current cockpit vision style: ${names[next]}. Activate for next style.`);
      this.visionCurrent.title = `Current style: ${names[next]} — click for next`;
    }
    if (this.visionCurrentLabel) this.visionCurrentLabel.textContent = labels[next];
    this.onVisionChange?.(next, this.active, { revealParameters });
  }

  cycleVisionMode(direction = 1) {
    const modes = COCKPIT_VISION_MODES;
    const currentIndex = Math.max(0, modes.indexOf(this.visionMode));
    const step = direction < 0 ? -1 : 1;
    const nextIndex = (currentIndex + step + modes.length) % modes.length;
    this.setVisionMode(modes[nextIndex], { revealParameters: true });
  }

  clearPredictiveRoute() {
    if (this.routeDirection) this.routeDirection.hidden = true;
  }

  onKeyDown(event) {
    if (event.repeat || event.isComposing) return;
    if (event.key === 'Escape' && this.active) {
      if (document.getElementById('context-radio-dock')?.classList.contains('disclosure-open')) return;
      if (document.querySelector('#cockpit-utility-controls [aria-expanded="true"]')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.exit();
      return;
    }
    if (event.target?.closest?.('input, textarea, select, [contenteditable]')) return;
    const key = event.key?.toLowerCase();
    if (key === 'c' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (!this.active) {
        // eslint-disable-next-line no-implicit-coercion -- source-contract test pins the !! form (cockpitMarkup.test.mjs)
        const cockpitAttempt = !!(this.readAircraftInfo() && this.viewer.trackedEntity?.position);
        if (!cockpitAttempt) return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!this.active && !this.isEntryAllowed()) return;
      if (this.active) this.exit(); else this.enter();
      return;
    }
  }

  enter() {
    if (this.active) return false;
    if (!this.isEntryAllowed()) return false;
    const info = this.readAircraftInfo();
    const entity = this.viewer.trackedEntity;
    if (!info || !entity?.position) return false;
    this.entryFocusOrigin = document.activeElement instanceof HTMLElement
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
    this._tapeCenter = null;
    this.cockpitAnchorValid = false;
    this.lastCameraUpdateMs = 0;
    this.active = true;
    // Cockpit animates the camera from preUpdate every frame — preUpdate only
    // runs on rendered frames, so idle mode would freeze the cockpit solid.
    // (perf wave 2)
    holdContinuousRender('cockpit');
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
    const trackLabel = info.callsign || info.registration || info.icao24 || 'AIRCRAFT';
    const trackHeading = String(Math.round(normalizeHeading(info.track ?? 0))).padStart(3, '0');
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

  exit({ restoreTracking = true } = {}) {
    if (!this.active) return false;
    const entity = this.trackedEntity;
    this.active = false;
    releaseContinuousRender('cockpit');
    this.trackedEntity = null;
    this.heading = null;
    this.cockpitAnchorValid = false;
    this.surfaceWaitStartedMs = 0;
    this.surfaceAcquiring = false;
    this.surfaceFallback = false;
    this.lastHudUpdateMs = 0;
    this.lastContextUpdateMs = 0;
    this.contextNavigationDeadlineMs = 0;
    this._tapeCenter = null;
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
    if (entity && this.viewer.entities.contains(entity)) entity.show = this.trackedEntityWasShown;
    this.trackedEntityWasShown = true;
    this.dispatchCockpitModeChanged(false);
    if (restoreTracking && entity && this.viewer.entities.contains(entity)) {
      this.viewer.trackedEntity = entity;
      this.restoreTrackingFrame(entity);
    }
    this.syncEntry();
    const restoreTarget = this.entryFocusOrigin === this.entry
      ? this.entry
      : (this.entry || this.entryFocusOrigin);
    this.entryFocusOrigin = null;
    if (restoreTarget?.isConnected && !restoreTarget.hidden) {
      restoreTarget.focus({ preventScroll: true });
    }
    return true;
  }

  update() {
    if (!this.active) {
      // Entry availability changes on a human timescale (tracking start/stop,
      // info arriving after a poll) — polling it every rendered frame ran
      // readAircraftInfo() + DOM pokes at display rate in plain map mode.
      // 250 ms keeps the chip imperceptibly fresh; trackedEntityChanged still
      // fires syncEntry immediately on the events that matter. (perf item 9)
      const nowMs = performance.now();
      if (nowMs - (this._lastEntrySyncMs || 0) >= 250) {
        this._lastEntrySyncMs = nowMs;
        this.syncEntry();
      }
      return;
    }

    const nowMs = performance.now();
    const info = this.readAircraftInfo();

    // Adopt a newly selected track before the camera cadence gate. A context
    // NEXT/PREV selection can otherwise spend one frame driving the old
    // aircraft with the new aircraft's metadata.
    this._adoptTrackedEntity(nowMs, info);
    if (!info || !this.trackedEntity || !this.viewer.entities.contains(this.trackedEntity)) {
      if (nowMs < this.contextNavigationDeadlineMs) return;
      this.exit({ restoreTracking: false });
      return;
    }
    if (!cockpitUiUpdateDue(nowMs, this.lastCameraUpdateMs, COCKPIT_CAMERA_UPDATE_MS)) return;
    this.lastCameraUpdateMs = nowMs;

    const target = this.trackedEntity.position.getValue(this.viewer.clock.currentTime, this.scratchTarget);
    if (!target) return;
    const dtSec = Math.min(0.1, Math.max(0, (nowMs - this.lastFrameMs) / 1000));
    this.lastFrameMs = nowMs;
    if (Number.isFinite(info.track)) {
      this.heading = slewHeading(
        this.heading ?? info.track, info.track, COCKPIT_HEADING_SLEW_DPS * dtSec,
      );
    }

    if (!this.cockpitAnchorValid) {
      Cesium.Cartesian3.clone(target, this.cockpitAnchor);
      this.cockpitAnchorValid = true;
    }

    // First-person motion cannot use the delayed feed correction as a raw
    // camera destination: a harmless icon re-anchor becomes a whole-world
    // surge/reversal in cockpit view. Advance the camera anchor inertially
    // from the reported course/speed and converge on the authoritative layer
    // display position at a bounded rate. This preserves the layer's required
    // 15/30-second interpolation and per-frame cache without exposing its
    // sample-boundary corrections to the camera.
    const headingRad = Cesium.Math.toRadians(this.heading ?? 0);
    const pitchRad = Cesium.Math.toRadians(COCKPIT_VIEW_PITCH_DEG);
    const speedMps = Number.isFinite(info.velocityMps) ? Math.max(0, info.velocityMps) : 0;

    if (info.stale) {
      // A feed backoff has no authoritative velocity epoch to advance from.
      // Hold the cockpit on the exact layer-rendered position so the camera
      // cannot coast away while the icon correctly remains fixed.
      Cesium.Cartesian3.clone(target, this.cockpitAnchor);
    } else {
      Cesium.Transforms.eastNorthUpToFixedFrame(
        this.cockpitAnchor, Cesium.Ellipsoid.WGS84, this.scratchEnu,
      );
      this.scratchLocal.x = Math.sin(headingRad);
      this.scratchLocal.y = Math.cos(headingRad);
      this.scratchLocal.z = 0;
      Cesium.Matrix4.multiplyByPointAsVector(this.scratchEnu, this.scratchLocal, this.scratchHorizontal);
      Cesium.Cartesian3.normalize(this.scratchHorizontal, this.scratchHorizontal);
      Cesium.Cartesian3.multiplyByScalar(
        this.scratchHorizontal, speedMps * dtSec, this.scratchAdvance,
      );
      Cesium.Cartesian3.add(this.cockpitAnchor, this.scratchAdvance, this.cockpitAnchor);
      Cesium.Cartesian3.subtract(target, this.cockpitAnchor, this.scratchCorrection);
      const correctionDistanceM = Cesium.Cartesian3.magnitude(this.scratchCorrection);
      const correctionStepM = cockpitAnchorCorrectionStep(correctionDistanceM, speedMps, dtSec);
      if (correctionStepM > 0 && correctionDistanceM > 0) {
        Cesium.Cartesian3.multiplyByScalar(
          this.scratchCorrection, correctionStepM / correctionDistanceM, this.scratchCorrection,
        );
        Cesium.Cartesian3.add(this.cockpitAnchor, this.scratchCorrection, this.cockpitAnchor);
      }
    }

    // The inertial anchor is independent of the layer's render-floor clamp and
    // can otherwise coast into a photoreal mesh while a landing contact is
    // between fixes. Clamp it against the same mesh-first shared floor used by
    // aircraft rendering. For a slow contact whose floor cell is still cold,
    // its already-clamped render position is a conservative temporary floor.
    const anchorCartographic = Cesium.Cartographic.fromCartesian(
      this.cockpitAnchor, Cesium.Ellipsoid.WGS84, this.scratchAnchorCartographic,
    );
    const targetCartographic = Cesium.Cartographic.fromCartesian(
      target, Cesium.Ellipsoid.WGS84, this.scratchTargetCartographic,
    );
    let cockpitFloorM = cachedGroundFloor(info.latitude, info.longitude);
    if (info.onGround === true) {
      const groundPoint = [{ lat: info.latitude, lon: info.longitude }];
      warmGroundFloor(groundPoint);
      const meshFloorM = cachedMeshFloor(info.latitude, info.longitude);
      if (meshFloorPreferred() && !Number.isFinite(meshFloorM)) {
        if (cockpitUiUpdateDue(nowMs, this.lastGroundProbeMs, COCKPIT_GROUND_PROBE_MS)) {
          this.lastGroundProbeMs = nowMs;
          const viewerCartographic = this.viewer.camera.positionCartographic;
          sampleMeshFloorCells(this.viewer.scene, groundPoint, {
            excludeObjects: [this.trackedEntity],
            viewerLat: Cesium.Math.toDegrees(viewerCartographic.latitude),
            viewerLon: Cesium.Math.toDegrees(viewerCartographic.longitude),
          });
        }
        cockpitFloorM = cachedMeshFloor(info.latitude, info.longitude);
        if (!Number.isFinite(cockpitFloorM)) {
          if (!this.surfaceWaitStartedMs) this.surfaceWaitStartedMs = nowMs;
          if (!cockpitSurfaceWaitExpired(nowMs, this.surfaceWaitStartedMs, COCKPIT_GROUND_WAIT_TIMEOUT_MS)) {
            // Keep the already-safe map camera in place while the photoreal
            // surface under a parked aircraft is acquired. The bounded wait
            // prevents a permanently cold mesh cell from freezing cockpit.
            this.surfaceAcquiring = true;
            this.surfaceFallback = false;
            if (cockpitUiUpdateDue(nowMs, this.lastHudUpdateMs, COCKPIT_HUD_UPDATE_MS)) {
              this.lastHudUpdateMs = nowMs;
              this.updateHud(info, nowMs);
            }
            return;
          }
          this.surfaceAcquiring = false;
          this.surfaceFallback = true;
        } else {
          this.surfaceWaitStartedMs = 0;
          this.surfaceAcquiring = false;
          this.surfaceFallback = false;
        }
      }
    } else {
      this.surfaceWaitStartedMs = 0;
      this.surfaceAcquiring = false;
      this.surfaceFallback = false;
    }
    if (!Number.isFinite(cockpitFloorM)
        && speedMps < 90
        && Number.isFinite(targetCartographic?.height)) {
      cockpitFloorM = targetCartographic.height - GROUND_FLOOR_LIFT_M;
    }
    if (anchorCartographic && Number.isFinite(cockpitFloorM)) {
      const minimumAnchorHeightM = cockpitGroundSafeHeight(
        anchorCartographic.height,
        cockpitFloorM,
        COCKPIT_MIN_GROUND_CLEARANCE_M - COCKPIT_UP_OFFSET_M,
      );
      if (minimumAnchorHeightM !== anchorCartographic.height) {
        anchorCartographic.height = minimumAnchorHeightM;
        Cesium.Ellipsoid.WGS84.cartographicToCartesian(anchorCartographic, this.cockpitAnchor);
      }
    }

    // Rebuild the local frame at the stabilized anchor after advancing it.
    Cesium.Transforms.eastNorthUpToFixedFrame(
      this.cockpitAnchor, Cesium.Ellipsoid.WGS84, this.scratchEnu,
    );
    this.scratchLocal.x = Math.sin(headingRad);
    this.scratchLocal.y = Math.cos(headingRad);
    this.scratchLocal.z = 0;
    Cesium.Matrix4.multiplyByPointAsVector(this.scratchEnu, this.scratchLocal, this.scratchHorizontal);
    Cesium.Cartesian3.normalize(this.scratchHorizontal, this.scratchHorizontal);

    this.scratchLocal.x = Math.sin(headingRad) * Math.cos(pitchRad);
    this.scratchLocal.y = Math.cos(headingRad) * Math.cos(pitchRad);
    this.scratchLocal.z = Math.sin(pitchRad);
    Cesium.Matrix4.multiplyByPointAsVector(this.scratchEnu, this.scratchLocal, this.scratchForward);
    Cesium.Cartesian3.normalize(this.scratchForward, this.scratchForward);

    this.scratchLocal.x = -Math.sin(headingRad) * Math.sin(pitchRad);
    this.scratchLocal.y = -Math.cos(headingRad) * Math.sin(pitchRad);
    this.scratchLocal.z = Math.cos(pitchRad);
    Cesium.Matrix4.multiplyByPointAsVector(this.scratchEnu, this.scratchLocal, this.scratchUp);
    Cesium.Cartesian3.normalize(this.scratchUp, this.scratchUp);

    Cesium.Cartesian3.multiplyByScalar(
      this.scratchHorizontal, COCKPIT_FORWARD_OFFSET_M, this.scratchCamera,
    );
    Cesium.Cartesian3.add(this.cockpitAnchor, this.scratchCamera, this.scratchCamera);
    Cesium.Matrix4.getTranslation(this.scratchEnu, this.scratchTarget);
    Cesium.Cartesian3.normalize(this.scratchTarget, this.scratchTarget);
    Cesium.Cartesian3.multiplyByScalar(this.scratchTarget, COCKPIT_UP_OFFSET_M, this.scratchTarget);
    Cesium.Cartesian3.add(this.scratchCamera, this.scratchTarget, this.scratchCamera);

    // Recheck at the final forward-offset camera coordinate because a taxiing
    // aircraft can cross into an adjacent coarse floor cell between updates.
    const cameraCartographic = Cesium.Cartographic.fromCartesian(
      this.scratchCamera, Cesium.Ellipsoid.WGS84, this.scratchCameraCartographic,
    );
    if (cameraCartographic) {
      const cameraLat = Cesium.Math.toDegrees(cameraCartographic.latitude);
      const cameraLon = Cesium.Math.toDegrees(cameraCartographic.longitude);
      const cameraFloorM = cachedGroundFloor(cameraLat, cameraLon);
      if (Number.isFinite(cameraFloorM)) {
        cockpitFloorM = Math.max(cockpitFloorM ?? Number.NEGATIVE_INFINITY, cameraFloorM);
      }
      const safeHeightM = cockpitGroundSafeHeight(
        cameraCartographic.height,
        cockpitFloorM,
        COCKPIT_MIN_GROUND_CLEARANCE_M,
      );
      if (safeHeightM !== cameraCartographic.height) {
        cameraCartographic.height = safeHeightM;
        Cesium.Ellipsoid.WGS84.cartographicToCartesian(cameraCartographic, this.scratchCamera);
      }
    }

    this.viewer.camera.setView({
      destination: this.scratchCamera,
      orientation: { direction: this.scratchForward, up: this.scratchUp },
    });
    if (cockpitUiUpdateDue(nowMs, this.lastHudUpdateMs, COCKPIT_HUD_UPDATE_MS)) {
      this.lastHudUpdateMs = nowMs;
      this.updateHud(info, nowMs);
    }
  }

  updateHud(info, nowMs = performance.now(), forceContext = false) {
    this.lastAircraftInfo = info;
    const heading = normalizeHeading(this.heading ?? info.track ?? 0);
    if (this.callsign) {
      this.callsign.textContent = info.callsign || info.registration || info.icao24 || 'AIRCRAFT';
    }
    const speedKt = Number.isFinite(info.velocityMps) ? info.velocityMps * 1.94384 : null;
    setCockpitRollingValue(
      this.speed,
      formatSpeedRulerTick(speedKt),
      speedKt,
      { immediate: forceContext },
    );
    if (this.speedRim) this.speedRim.classList.toggle('unavailable', speedKt === null);
    if (this.speedRimValue) this.speedRimValue.textContent = formatSpeedRulerTick(speedKt);
    const speedTicks = speedRulerTicks(speedKt, this.speedRimTicks.length);
    this.speedRimTicks.forEach((element, index) => {
      const tick = speedTicks[index];
      element.hidden = !tick;
      if (!tick) return;
      element.style.setProperty('--slot', tick.slot.toFixed(4));
      element.style.setProperty('--depth', tick.depth.toFixed(4));
      element.style.setProperty('--curve', altitudeRulerCurveInset(tick.slot).toFixed(5));
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
    if (this.altitudeRim) this.altitudeRim.classList.toggle('unavailable', altitudeFt === null);
    if (this.altitudeRimValue) {
      this.altitudeRimValue.textContent = formatAltitudeRulerTick(altitudeFt);
    }
    const altitudeTicks = altitudeRulerTicks(altitudeFt, this.altitudeRimTicks.length);
    this.altitudeRimTicks.forEach((element, index) => {
      const tick = altitudeTicks[index];
      element.hidden = !tick;
      if (!tick) return;
      element.style.setProperty('--slot', tick.slot.toFixed(4));
      element.style.setProperty('--depth', tick.depth.toFixed(4));
      element.style.setProperty('--curve', altitudeRulerCurveInset(tick.slot).toFixed(5));
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
    this._updateCompassTape(heading);
    if (this.clock) this.clock.textContent = `${new Date().toISOString().slice(11, 19)  }Z`;
    if (this.position) {
      const lat = Number.isFinite(info.latitude)
        ? `${Math.abs(info.latitude).toFixed(3)}°${info.latitude >= 0 ? 'N' : 'S'}` : '--';
      const lon = Number.isFinite(info.longitude)
        ? `${Math.abs(info.longitude).toFixed(3)}°${info.longitude >= 0 ? 'E' : 'W'}` : '--';
      this.position.textContent = `${lat} · ${lon}`;
    }
    if (this.aircraftMeta) {
      const feedState = this.surfaceAcquiring
        ? 'ACQUIRING SURFACE'
        : (this.surfaceFallback ? 'SURFACE FALLBACK' : (info.stale ? 'STALE FEED' : 'LIVE TRACK'));
      this.aircraftMeta.textContent = `${info.layerId === 'military' ? 'MILITARY' : 'COMMERCIAL'} · ${feedState} · COURSE ALIGNED`;
    }
    this.updateRoute(info);
    if (forceContext
      || cockpitUiUpdateDue(nowMs, this.lastContextUpdateMs, COCKPIT_CONTEXT_UPDATE_MS)) {
      this.lastContextUpdateMs = nowMs;
      this.updateLocalPosition(info);
      this.maybeRefreshRegionalBrief(info);
      this.updateContext(info, heading);
    }
    if (this.hud) this.hud.dataset.layer = info.layerId || 'flights';
  }

  /**
   * Compass tape, built once (render-perf five). The seven division spans
   * are created on first use and live for the controller's lifetime; per
   * update only the tape's `--tape-shift` custom property (the smooth
   * sub-division slide) and — across a 30-degree boundary — the seven label
   * text nodes change. The old path re-parsed innerHTML on every boundary
   * crossing: 336 childList mutations over a 720-degree sweep, measured by
   * scripts/profile-render-perf.mjs.
   * @param {number} heading Slewed cockpit heading in degrees.
   */
  _updateCompassTape(heading) {
    if (!this.compassTape) return;
    if (!this._tapeSpans) {
      this._tapeSpans = [-3, -2, -1, 0, 1, 2, 3].map((slot) => {
        const span = document.createElement('span');
        if (slot === 0) span.className = 'active';
        span.style.setProperty('--slot', String(slot));
        span.style.setProperty('--depth', String(Math.abs(slot)));
        this.compassTape.appendChild(span);
        return span;
      });
    }
    const layout = compassTapeLayout(heading);
    this.compassTape.style.setProperty('--tape-shift', layout.shift.toFixed(4));
    if (layout.center !== this._tapeCenter) {
      this._tapeCenter = layout.center;
      layout.divisions.forEach((division, index) => {
        this._tapeSpans[index].textContent = formatCompassDivision(division);
      });
    }
  }

  updateRoute(info) {
    const origin = info?.route?.origin;
    const destination = info?.route?.destination;
    const validDestination = Number.isFinite(destination?.lat) && Number.isFinite(destination?.lon);
    const routeLabel = (airport) => [airport?.code, airport?.name].filter(Boolean).join(' · ') || 'UNKNOWN';
    if (this.routeFrom) this.routeFrom.textContent = routeLabel(origin);
    if (this.routeTo) this.routeTo.textContent = routeLabel(destination);
    if (this.routeStatus) {
      this.routeStatus.textContent = validDestination
        ? 'ARROW · ESTIMATED DIRECTION'
        : 'ROUTE DATA UNAVAILABLE';
    }
    if (this.route) this.route.hidden = !origin && !destination;
    if (!validDestination || !Number.isFinite(info?.longitude) || !Number.isFinite(info?.latitude)) {
      this.clearPredictiveRoute();
      return;
    }
    const destinationBearing = bearingBetweenCoordinates(
      info.latitude,
      info.longitude,
      destination.lat,
      destination.lon,
    );
    const relative = relativeBearing(destinationBearing, this.heading ?? info.track ?? 0);
    if (!Number.isFinite(destinationBearing) || !Number.isFinite(relative)) {
      this.clearPredictiveRoute();
      return;
    }
    if (this.routeDirection) {
      const displayedRelative = Math.max(-120, Math.min(120, relative));
      this.routeDirection.hidden = false;
      this.routeDirection.style.setProperty('--route-angle', `${displayedRelative.toFixed(2)}deg`);
    }
    if (this.routeDirectionLabel) {
      this.routeDirectionLabel.textContent = `DEST ${String(Math.round(destinationBearing)).padStart(3, '0')}°`;
    }
  }

  updateContext(info, heading) {
    if (!this.context) return;
    const snapshot = militaryAwarenessLayer.getContextSnapshot?.() || null;
    const trackedId = info.icao24 || info.id;
    const readout = resolveCockpitContextReadout({ snapshot, info });
    if (!readout.visible) {
      this.context.hidden = true;
      this.hud?.classList.remove('context-active');
      this.contextLayoutStamp = null;
      this.pushCockpitSignal(
        'context-status',
        'info',
        'CONTEXT STANDBY',
        'ENABLE GLOBAL CONTEXT FOR PROXIMITY PINGS',
      );
      return;
    }

    this.context.hidden = false;
    this.hud?.classList.add('context-active');
    if (this.contextSubject) {
      const installationCoverage = snapshot.cohorts
        .find((cohort) => cohort.id === 'military-installations')?.coverage;
      this.contextSubject.textContent = formatCockpitContextScope(
        snapshot.subject.label || trackedId,
        snapshot.radiusM,
        installationCoverage,
      );
    }
    // Navigation stays wired in every state — the operator must always be able
    // to step off the current contact from the panel that hosts the controls.
    if (this.contextPrevious) this.contextPrevious.disabled = !snapshot.navigation?.canPrevious;
    if (this.contextNext) this.contextNext.disabled = !snapshot.navigation?.canNext;

    if (readout.contactLost) {
      // The subject left its source. Every number below is measured against a
      // position that stopped updating, so hold the last rendered readout and
      // say so instead of re-deriving stale geometry as if it were live.
      const enteringLost = this.context.dataset.state !== 'lost';
      this.context.dataset.state = 'lost';
      if (this.contextUncertainty) {
        this.contextUncertainty.textContent = 'CONTACT LOST · LAST KNOWN READOUT · NOT AN ALL-CLEAR';
      }
      // The cue changes the footer's height; re-run layout once on the way in
      // rather than every frame the contact stays lost.
      if (enteringLost) this.scheduleContextLayout();
      this.pushCockpitSignal(
        'context-status',
        'warning',
        `CONTACT LOST · ${snapshot.subject.label || snapshot.subject.id || 'SUBJECT'}`,
        'SUBJECT LEFT ITS FEED · READOUT HOLDING LAST KNOWN',
      );
      return;
    }

    let unknownCount = 0;
    const nearest = [];
    for (const cohort of snapshot.cohorts) {
      const element = this.contextCohorts.get(cohort.id);
      const value = element?.querySelector('strong');
      if (value) value.textContent = cohort.count === null ? '?' : String(cohort.count);
      element?.classList.toggle('unknown', cohort.relationship === 'UNKNOWN');
      if (cohort.count === null) unknownCount += 1;
      for (const item of cohort.nearest) nearest.push({ ...item, cohort });
    }
    nearest.sort((a, b) => (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity));
    const closest = nearest[0] || null;
    const closestLabel = formatAwarenessLabel(closest);
    if (this.contextNearestLabel) {
      this.contextNearestLabel.textContent = closest
        ? `${closest.cohort.label.toUpperCase()} · ${closestLabel}` : 'NO AVAILABLE EXAMPLE';
      this.contextNearestLabel.setAttribute(
        'aria-label',
        closest && closestLabel === '—'
          ? `${closest.cohort.label}, Unavailable`
          : this.contextNearestLabel.textContent,
      );
    }
    if (this.contextDistance) {
      const distanceM = closest?.distanceM;
      this.contextDistance.textContent = Number.isFinite(distanceM)
        ? `${distanceM < 10000 ? (distanceM / 1000).toFixed(1) : Math.round(distanceM / 1000)} KM` : '—';
      this.contextDistance.setAttribute(
        'aria-label',
        Number.isFinite(distanceM) ? this.contextDistance.textContent : 'Unavailable',
      );
    }

    // The arrow and BRG are nose-relative to the tracked aircraft. When the
    // subject is a vessel, an installation, or another aircraft, the rest of
    // this row is measured from that subject — so the aircraft-frame half is
    // dashed rather than presented alongside subject-frame distances as if the
    // two shared an origin.
    let relative = null;
    if (readout.aircraftRelative
      && closest?.position && Number.isFinite(info.latitude) && Number.isFinite(info.longitude)) {
      const cartographic = Cesium.Cartographic.fromCartesian(closest.position);
      const bearing = cartographic ? bearingBetweenCoordinates(
        info.latitude,
        info.longitude,
        Cesium.Math.toDegrees(cartographic.latitude),
        Cesium.Math.toDegrees(cartographic.longitude),
      ) : null;
      relative = relativeBearing(bearing, heading);
    }
    if (this.contextDirection) {
      this.contextDirection.style.transform = `rotate(${relative ?? 0}deg)`;
      this.contextDirection.classList.toggle('unknown', relative === null);
    }
    if (this.contextBearing) {
      if (relative === null) this.contextBearing.textContent = 'BRG —';
      else if (Math.abs(relative) < 8) this.contextBearing.textContent = 'AHEAD';
      else this.contextBearing.textContent = `${relative < 0 ? 'L' : 'R'} ${String(Math.round(Math.abs(relative))).padStart(3, '0')}°`;
    }
    if (this.contextUncertainty) {
      this.contextUncertainty.textContent = unknownCount
        ? `${unknownCount} INPUT${unknownCount === 1 ? '' : 'S'} UNKNOWN · NOT AN ALL-CLEAR`
        : 'AVAILABLE INPUTS CURRENT · NOT AN ALL-CLEAR';
    }
    if (this.contextUpdated) {
      this.contextUpdated.textContent = Number.isFinite(snapshot.evaluatedAt)
        ? `${new Date(snapshot.evaluatedAt).toISOString().slice(11, 19)  }Z` : '--:--:--Z';
    }
    this.context.dataset.state = unknownCount ? 'uncertain' : 'current';
    this.updateCockpitSignals(snapshot, unknownCount);
    if (this.contextLayoutStamp !== snapshot.evaluatedAt) {
      this.contextLayoutStamp = snapshot.evaluatedAt;
      this.scheduleContextLayout();
    }
  }

  scheduleContextLayout() {
    const contextVisible = this.context && !this.context.hidden;
    const signalVisible = this.signalStream && !this.signalStream.hidden;
    if ((!contextVisible && !signalVisible) || this.contextLayoutFrame !== null) return;
    this.contextLayoutFrame = requestAnimationFrame(() => {
      this.contextLayoutFrame = null;
      this.syncContextLayout();
      this.syncSignalLayout();
    });
  }

  showBriefPage(index, { manual = false } = {}) {
    const count = COCKPIT_BRIEF_PAGES.length;
    this.briefPageIndex = ((Number(index) % count) + count) % count;
    const page = COCKPIT_BRIEF_PAGES[this.briefPageIndex];
    this.briefPages.forEach((element) => {
      element.hidden = element.dataset.cockpitBriefPage !== page.id;
    });
    this.briefTabs.forEach((button) => {
      const current = Number(button.dataset.cockpitBriefIndex) === this.briefPageIndex;
      button.setAttribute('aria-current', current ? 'true' : 'false');
    });
    if (this.briefKicker) {
      const indicator = this.briefKicker.querySelector('i');
      this.briefKicker.replaceChildren(...[indicator, document.createTextNode(` ${page.kicker}`)].filter(Boolean));
    }
    if (this.briefSubtitle) this.briefSubtitle.textContent = page.subtitle;
    if (this.briefPosition) this.briefPosition.textContent = `${this.briefPageIndex + 1} / ${count}`;
    if (this.briefSource) this.briefSource.textContent = page.source;
    if (this.signalStream) this.signalStream.dataset.briefPage = page.id;
    if (manual && this.briefAutoRotateEnabled) this.startBriefRotation({ reset: true });
    this.scheduleContextLayout();
  }

  setBriefAutoRotate(enabled) {
    this.briefAutoRotateEnabled = Boolean(enabled);
    if (this.briefAutoToggle) {
      this.briefAutoToggle.setAttribute('aria-pressed', String(this.briefAutoRotateEnabled));
      const label = this.briefAutoRotateEnabled ? 'CYCLE ON' : 'CYCLE OFF';
      this.briefAutoToggle.textContent = label;
      const help = this.briefAutoRotateEnabled
        ? COCKPIT_BRIEF_CYCLE_ON_HELP
        : COCKPIT_BRIEF_CYCLE_OFF_HELP;
      this.briefAutoToggle.setAttribute('aria-label', label);
      this.briefAutoToggle.title = help;
    }
    if (this.briefAutoRotateEnabled) this.startBriefRotation({ reset: true });
    else this.stopBriefRotation();
  }

  startBriefRotation({ reset = false } = {}) {
    if (reset) this.stopBriefRotation();
    if (!this.briefAutoRotateEnabled
      || this.briefTimer
      || !this.active
      || this.signalCollapsed
      || document.hidden) return;
    this.briefTimer = window.setTimeout(() => {
      this.briefTimer = null;
      const hasPointer = this.signalStream?.matches(':hover') === true;
      const hasFocus = this.signalStream?.contains(document.activeElement) === true;
      const isInteracting = hasPointer || hasFocus;
      if (!isInteracting) {
        this.showBriefPage(this.briefPageIndex + 1);
      }
      this.startBriefRotation();
    }, COCKPIT_BRIEF_ROTATE_MS);
  }

  stopBriefRotation() {
    if (this.briefTimer) window.clearTimeout(this.briefTimer);
    this.briefTimer = null;
  }

  updateLocalPosition(info) {
    if (!this.localCoordinates) return;
    if (!Number.isFinite(info.latitude) || !Number.isFinite(info.longitude)) {
      this.localCoordinates.textContent = 'POSITION UNAVAILABLE';
      return;
    }
    const lat = `${Math.abs(info.latitude).toFixed(3)}°${info.latitude >= 0 ? 'N' : 'S'}`;
    const lon = `${Math.abs(info.longitude).toFixed(3)}°${info.longitude >= 0 ? 'E' : 'W'}`;
    this.localCoordinates.textContent = `${lat} · ${lon}`;
  }

  maybeRefreshRegionalBrief(info) {
    if (!this.active || !Number.isFinite(info.latitude) || !Number.isFinite(info.longitude)) return;
    const subjectId = `${info.layerId || 'aircraft'}:${info.icao24 || info.registration || info.callsign || 'unknown'}`;
    if (subjectId !== this.regionalBriefSubjectId) {
      this.regionalBriefAbort?.abort();
      this.regionalBriefAbort = null;
      this.regionalBriefRequestToken += 1;
      this.regionalBriefSubjectId = subjectId;
      this.regionalBrief = null;
      this.regionalBriefAnchor = null;
      this.regionalBriefFetchedAt = 0;
    }
    const point = { latitude: info.latitude, longitude: info.longitude };
    const ageMs = Date.now() - this.regionalBriefFetchedAt;
    const distanceM = regionalDistanceM(this.regionalBriefAnchor, point);
    if (this.regionalBriefAbort || (ageMs < COCKPIT_REGIONAL_REFRESH_MS
      && distanceM < COCKPIT_REGIONAL_REFRESH_DISTANCE_M)) return;

    this.regionalBriefAnchor = point;
    this.regionalBriefFetchedAt = Date.now();
    const controller = new AbortController();
    const requestToken = ++this.regionalBriefRequestToken;
    this.regionalBriefAbort = controller;
    if (!this.regionalBrief) this.renderRegionalBriefStatus('loading', info);
    fetchRegionalBrief(point.latitude, point.longitude, { signal: controller.signal })
      .then((payload) => {
        if (!this.active
          || requestToken !== this.regionalBriefRequestToken
          || subjectId !== this.regionalBriefSubjectId) return;
        this.regionalBrief = payload;
        this.renderRegionalBrief(payload, info);
      })
      .catch((error) => {
        if (error?.name !== 'AbortError'
          && this.active
          && requestToken === this.regionalBriefRequestToken
          && subjectId === this.regionalBriefSubjectId) {
          this.renderRegionalBriefStatus('unavailable', info);
        }
      })
      .finally(() => {
        if (this.regionalBriefAbort === controller) this.regionalBriefAbort = null;
      });
  }

  renderRegionalBriefStatus(status, info) {
    if (this.newsStatus) {
      this.newsStatus.hidden = false;
      this.newsStatus.dataset.state = status;
      this.newsStatus.textContent = status === 'loading'
        ? 'ACQUIRING REGIONAL NEWS'
        : 'REGIONAL NEWS UNAVAILABLE';
    }
    if (status === 'unavailable') this.newsList?.replaceChildren();
    if (this.localPlace && status === 'loading') this.localPlace.textContent = 'RESOLVING REGION';
    if (this.localPlace && status === 'unavailable') this.localPlace.textContent = 'REGION UNAVAILABLE';
    this.updateLocalPosition(info);
  }

  renderRegionalBrief(payload, info) {
    const articles = Array.isArray(payload?.articles) ? payload.articles : [];
    if (this.newsStatus) {
      this.newsStatus.hidden = articles.length > 0;
      this.newsStatus.dataset.state = payload?.newsStatus || 'unavailable';
      this.newsStatus.textContent = payload?.newsStatus === 'empty'
        ? 'NO RECENT LOCATION MATCHES'
        : 'REGIONAL NEWS UNAVAILABLE';
    }
    if (this.newsList) {
      this.newsList.replaceChildren(...articles.slice(0, 4).map((article) => {
        const entry = document.createElement('li');
        const link = document.createElement('a');
        link.href = article.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        const title = document.createElement('strong');
        title.textContent = article.title;
        const metadata = document.createElement('span');
        metadata.textContent = `${article.domain || 'SOURCE'} · ${formatCockpitBriefAge(article.publishedAt)}`;
        link.append(title, metadata);
        entry.append(link);
        return entry;
      }));
    }

    const placeLabel = payload?.place?.label || payload?.place?.country || 'REGION UNAVAILABLE';
    if (this.localPlace) this.localPlace.textContent = placeLabel.toUpperCase();
    this.updateLocalPosition(info);
    const weather = payload?.weather;
    if (this.localTemperature) {
      this.localTemperature.textContent = Number.isFinite(weather?.temperatureC)
        ? `${Math.round(weather.temperatureC)}°C` : '—';
    }
    if (this.localWind) {
      this.localWind.textContent = Number.isFinite(weather?.windKph)
        ? `${Math.round(weather.windKph)} KM/H` : '—';
    }
    if (this.localWindDirection) {
      this.localWindDirection.textContent = formatCockpitWindDirection(weather?.windDirectionDeg);
    }
    if (this.localCondition) this.localCondition.textContent = weatherCodeLabel(weather?.weatherCode);
    if (this.localCloud) {
      this.localCloud.textContent = Number.isFinite(weather?.cloudCoverPct)
        ? `CLOUD ${Math.round(weather.cloudCoverPct)}%` : 'CLOUD UNKNOWN';
    }
    if (this.localPrecipitation) {
      this.localPrecipitation.textContent = Number.isFinite(weather?.precipitationMm)
        ? weather.precipitationMm.toFixed(1) : '—';
    }
    if (this.signalStream) this.signalStream.dataset.regionalStatus = payload?.status || 'partial';
    if (this.briefPageIndex === 1 && this.briefSource) {
      this.briefSource.textContent = `${String(payload?.newsSource || 'REGIONAL NEWS').toUpperCase()} · LOCATION QUERY`;
    }
    this.scheduleContextLayout();
  }

  renderCockpitSignals() {
    if (!this.signalList) return;
    this.signalList.replaceChildren(...this.signalItems.map((item) => {
      const entry = document.createElement('li');
      entry.className = item.tone;
      const time = document.createElement('time');
      time.textContent = `${new Date(item.timestamp).toISOString().slice(11, 19)  }Z`;
      const body = document.createElement('div');
      const heading = item.target ? document.createElement('button') : document.createElement('strong');
      if (item.target) {
        heading.type = 'button';
        heading.className = 'cockpit-signal-target';
        heading.dataset.signalLayer = item.target.layerId;
        heading.dataset.signalId = item.target.id;
        heading.setAttribute('aria-label', `Select flight ${item.title}`);
        const label = document.createElement('span');
        label.className = 'cockpit-signal-target-label';
        label.textContent = item.title;
        const rule = document.createElement('span');
        rule.className = 'cockpit-signal-target-rule';
        rule.setAttribute('aria-hidden', 'true');
        const chevron = document.createElement('span');
        chevron.className = 'material-symbols-outlined cockpit-signal-target-chevron';
        chevron.setAttribute('aria-hidden', 'true');
        chevron.textContent = 'chevron_right';
        heading.append(label, rule, chevron);
        entry.classList.add('actionable');
      } else {
        heading.textContent = item.title;
      }
      const copy = document.createElement('span');
      copy.textContent = item.detail;
      body.append(heading, copy);
      entry.append(time, body);
      return entry;
    }));
    this.scheduleContextLayout();
  }

  pushCockpitSignal(key, tone, title, detail, target = null) {
    if (!this.signalList || !title || !detail) return;
    const signature = `${title}|${detail}|${target?.layerId || ''}|${target?.id || ''}`;
    if (this.signalSignatures.get(key) === signature) return;
    this.signalSignatures.set(key, signature);
    this.signalItems.unshift({ key, tone, title, detail, target, timestamp: Date.now() });
    this.signalItems = this.signalItems.slice(0, 5);
    this.renderCockpitSignals();
  }

  updateCockpitSignals(snapshot, unknownCount) {
    const previous = new Map(this.signalItems.map((item) => [item.key, item]));
    const contacts = [];
    const subject = snapshot.subject;
    if (['flights', 'military'].includes(subject?.layerId) && subject?.id) {
      contacts.push({
        key: `flight:${subject.layerId}:${subject.id}`,
        tone: 'track',
        title: subject.label || subject.id,
        detail: `${subject.layerId === 'military' ? 'MILITARY FLIGHT' : 'COMMERCIAL FLIGHT'} · CURRENT`,
        target: { layerId: subject.layerId, id: String(subject.id) },
        distanceM: -1,
      });
    }
    for (const cohort of snapshot.cohorts) {
      if (!['flights', 'military'].includes(cohort.id)) continue;
      for (const item of cohort.nearest) {
        const id = item.icao24 || item.id;
        if (!id) continue;
        contacts.push({
          key: `flight:${cohort.id}:${id}`,
          tone: cohort.id === 'military' ? 'nearby military' : 'nearby',
          // `id` above is IDENTITY (the ICAO hex). Display must not reuse it:
          // the row's own `id` already carries the layer's label convention
          // (callsign → registration → hex), so a callsign-less enriched
          // contact reads as its registration here too. Same helper the
          // Context panel's nearest list uses.
          title: formatAwarenessLabel(item),
          detail: `${cohort.id === 'military' ? 'MILITARY FLIGHT' : 'COMMERCIAL FLIGHT'} · ${
            Number.isFinite(item.distanceM)
              ? `${item.distanceM < 10000 ? (item.distanceM / 1000).toFixed(1) : Math.round(item.distanceM / 1000)} KM`
              : 'DISTANCE UNKNOWN'
          }`,
          target: { layerId: cohort.id, id: String(id) },
          distanceM: item.distanceM ?? Infinity,
        });
      }
    }
    contacts.sort((a, b) => a.distanceM - b.distanceM);
    const nextItems = contacts.slice(0, 5).map((item) => ({
      ...item,
      timestamp: previous.get(item.key)?.timestamp || snapshot.evaluatedAt || Date.now(),
    }));
    if (unknownCount) {
      const sources = snapshot.cohorts
        .filter((cohort) => cohort.count === null)
        .map((cohort) => cohort.source)
        .join(' · ');
      nextItems.splice(4, Math.max(0, nextItems.length - 4), {
        key: 'input-status',
        tone: 'warning',
        title: `${unknownCount} INPUT${unknownCount === 1 ? '' : 'S'} UNKNOWN`,
        detail: sources || 'SOURCE STATUS UNAVAILABLE',
        target: null,
        timestamp: previous.get('input-status')?.timestamp || snapshot.evaluatedAt || Date.now(),
      });
    }
    this.signalItems = nextItems;
    this.signalSignatures.clear();
    this.renderCockpitSignals();
  }

  setContextCollapsed(collapsed) {
    const wasCollapsed = this.contextCollapsed;
    this.contextCollapsed = Boolean(collapsed);
    if (this.context) this.context.dataset.collapsed = String(this.contextCollapsed);
    if (this.contextToggle) {
      const expanded = !this.contextCollapsed;
      this.contextToggle.setAttribute('aria-expanded', String(expanded));
      this.contextToggle.setAttribute('aria-label', `${expanded ? 'Collapse' : 'Expand'} Contact panel`);
      this.contextToggle.title = `${expanded ? 'Collapse' : 'Expand'} contact panel`;
      const icon = this.contextToggle.querySelector('.material-symbols-outlined');
      if (icon) icon.textContent = expanded ? 'chevron_left' : 'chevron_right';
    }
    if (this.active && wasCollapsed && !this.contextCollapsed) {
      window.dispatchEvent(new CustomEvent('gev:cockpit-context-expanded'));
    }
    this.scheduleContextLayout();
  }

  setSignalCollapsed(collapsed, { user = false } = {}) {
    const wasCollapsed = this.signalCollapsed;
    this.signalCollapsed = Boolean(collapsed);
    if (user) this.signalUserCollapsed = this.signalCollapsed;
    if (this.signalStream) this.signalStream.dataset.collapsed = String(this.signalCollapsed);
    if (this.signalToggle) {
      const expanded = !this.signalCollapsed;
      this.signalToggle.setAttribute('aria-expanded', String(expanded));
      this.signalToggle.setAttribute('aria-label', `${expanded ? 'Collapse' : 'Expand'} cockpit briefing panel`);
      this.signalToggle.title = `${expanded ? 'Collapse' : 'Expand'} briefing panel`;
      const icon = this.signalToggle.querySelector('.material-symbols-outlined');
      if (icon) icon.textContent = expanded ? 'right_panel_close' : 'right_panel_open';
    }
    if (this.signalCollapsed) this.stopBriefRotation();
    else this.startBriefRotation({ reset: true });
    if (this.active && wasCollapsed && !this.signalCollapsed) {
      window.dispatchEvent(new CustomEvent('gev:cockpit-signal-expanded'));
    }
    this.scheduleContextLayout();
  }

  syncContextLayout() {
    if (!this.context || this.context.hidden) return;
    if (window.matchMedia('(max-width: 760px)').matches) {
      this.context.dataset.layoutMode = 'compact-bottom';
      this.context.style.removeProperty('--cockpit-context-left');
      this.context.style.removeProperty('--cockpit-context-top');
      this.context.style.removeProperty('--cockpit-context-max-height');
      return;
    }

    const desktopInset = Math.max(24, Math.min(58, window.innerWidth * 0.04));
    this.context.dataset.layoutMode = 'bottom-left';
    this.context.style.setProperty('--cockpit-context-left', `${desktopInset.toFixed(1)}px`);
    this.context.style.removeProperty('--cockpit-context-top');
    this.context.style.removeProperty('--cockpit-context-max-height');
  }

  syncSignalLayout() {
    if (!this.signalStream || this.signalStream.hidden) return;
    const utilityControls = document.getElementById('cockpit-utility-controls');
    if (window.matchMedia('(max-width: 760px)').matches) {
      this.signalStream.dataset.layoutMode = 'compact-top';
      utilityControls?.classList.remove('layout-primary-only');
      utilityControls?.querySelectorAll('.cockpit-utility-control').forEach((control) => {
        const hiddenSibling = Boolean(
          utilityControls.querySelector('.cockpit-utility-control.is-expanded')
          && !control.classList.contains('is-expanded')
        );
        control.setAttribute('aria-hidden', String(hiddenSibling));
      });
      this.hud?.style.removeProperty('--cockpit-utility-top');
      this.hud?.style.removeProperty('--cockpit-utility-max-height');
      this.hud?.style.removeProperty('--cockpit-utility-expanded-max-height');
      this.signalStream.style.removeProperty('--cockpit-signal-right');
      this.signalStream.style.removeProperty('--cockpit-signal-top');
      this.signalStream.style.removeProperty('--cockpit-signal-max-height');
      return;
    }

    const desktopInset = Math.max(24, Math.min(58, window.innerWidth * 0.04));
    this.signalStream.dataset.layoutMode = 'bottom-right';
    this.signalStream.style.setProperty('--cockpit-signal-right', `${desktopInset.toFixed(1)}px`);
    this.signalStream.style.removeProperty('--cockpit-signal-top');
    this.signalStream.style.removeProperty('--cockpit-signal-max-height');
    const signalBounds = this.signalStream.getBoundingClientRect();
    const utilityBounds = utilityControls?.getBoundingClientRect();
    if (utilityBounds) {
      const expandedControl = utilityControls?.querySelector('.cockpit-utility-control.is-expanded');
      const collapsedControl = utilityControls?.querySelector(
        '.cockpit-utility-control:not(.is-expanded)',
      );
      const collapsedLauncher = collapsedControl?.querySelector('.cockpit-utility-launcher');
      const expandedHeight = expandedControl
        ? Math.max(expandedControl.scrollHeight, expandedControl.getBoundingClientRect().height)
        : 0;
      const collapsedHeight = collapsedLauncher
        ? Math.max(COCKPIT_UTILITY_LAUNCHER_MIN_HEIGHT_PX, collapsedLauncher.scrollHeight)
        : 0;
      // Cockpit owns this anchor outright. The strip used to inherit the left
      // accordion's committed top, which is solved against left-lane obstacles
      // and dropped the strip straight through the briefing card below it.
      // The readout only anchors the strip while it is genuinely on screen:
      // the Minimal variant drops it with `display:none`, but HUD Off hides the
      // whole Intel HUD with `visibility`/`opacity`, which keeps its rect.
      const recReadout = document.querySelector('#intel-hud .hud-top-right');
      const recBounds = isRenderedOnScreen(recReadout) ? recReadout.getBoundingClientRect() : null;
      const utilityAnchor = resolveCockpitUtilityAnchor({
        recBottom: recBounds ? recBounds.bottom : 0,
        signalTop: signalBounds.top,
        stripHeight: utilityBounds.height,
        viewportHeight: window.innerHeight,
        collapsedHeight,
        recGap: COCKPIT_UTILITY_REC_GAP_PX,
        signalGap: COCKPIT_UTILITY_SIGNAL_GAP_PX,
        minTopFloor: COCKPIT_UTILITY_MIN_TOP_PX,
        minTopRatio: COCKPIT_UTILITY_MIN_TOP_RATIO,
      });
      const availableHeight = utilityAnchor.maxHeight;
      this.hud?.style.setProperty('--cockpit-utility-top', `${utilityAnchor.top.toFixed(1)}px`);
      this.hud?.style.setProperty('--cockpit-utility-max-height', `${availableHeight.toFixed(2)}px`);
      const utilityLayout = expandedControl && collapsedControl
        ? resolveCockpitUtilityLayout({ availableHeight, expandedHeight, collapsedHeight })
        : { primaryOnly: false, expandedMaxHeight: availableHeight };
      utilityControls?.classList.toggle('layout-primary-only', utilityLayout.primaryOnly);
      this.hud?.style.setProperty(
        '--cockpit-utility-expanded-max-height',
        `${utilityLayout.expandedMaxHeight.toFixed(2)}px`,
      );
      utilityControls?.querySelectorAll('.cockpit-utility-control').forEach((control) => {
        const hiddenSibling = utilityLayout.primaryOnly && control === collapsedControl;
        control.setAttribute('aria-hidden', String(hiddenSibling));
        if (hiddenSibling && control.contains(document.activeElement)) {
          expandedControl?.querySelector('.cockpit-utility-glyph')?.focus({ preventScroll: true });
        }
      });
    }
  }

  dispose() {
    this.exit({ restoreTracking: false });
    this.regionalBriefAbort?.abort();
    this.regionalBriefAbort = null;
    this.regionalBriefRequestToken += 1;
    this.stopBriefRotation();
    if (this.contextLayoutFrame !== null) cancelAnimationFrame(this.contextLayoutFrame);
    this.contextLayoutFrame = null;
    for (const removeListener of this._listenerRemovers.splice(0)) removeListener?.();
  }
}
