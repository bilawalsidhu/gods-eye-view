import { ContextControls } from './ui/context.js';
import { CctvControls } from './ui/cctv.js';
import { RadioControls } from './ui/radio.js';
import { LocationControls, LocationSearch } from './ui/location.js';
import { bindClearLayersControl } from './ui/layers.js';
import { createMapSourceControls } from './ui/mapSource.js';
import { VisualEffects, STYLES, GLOBAL_POST_DEFAULTS, STYLE_PRESET_DEFAULTS, MILITARY_DETECTION_PRESET } from './ui/effects.js';
import { bindDisplayControls } from './ui/displayControls.js';
import { bindApplicationShortcuts, createStyleParameters } from './ui/visualInput.js';
import { layoutLeftPanelRail, layoutRightPanelRail } from './ui/panelRails.js';
import { bindPanelDisclosure, collapsePanelOnEscape, createHoverDisclosure } from './ui/panelDisclosure.js';
import * as Cesium from 'cesium';
import {
  BLOOM_INTENSITY_DEFAULT,
  BLOOM_SCALE_VERSION,
  clampBloomIntensity,
  decodeBloomIntensity,
} from './bloom.js';
import { LOCATIONS, CITY_POIS, GLOBE_VIEW, flyToGlobeView, flyToPresetLocation, flyToPOI, searchAndFlyTo } from './locations.js';
import { interruptCameraMotion } from './cameraVerbs.js';
import {
  aircraftTrackingTarget,
  enterCockpitWithTracking,
} from './cockpitTracking.js';
import { IntelHUD } from './hud.js';
import { ShareLinkManager } from './sharelink.js';
import {
  isExplicitLayerStateOrigin,
  LayerStateCoordinator,
} from './data/layerState.js';
import { OrbitController } from './orbit.js';
import {
  CelestialRing,
  getKeyholeFadeTuning,
  isCelestialRingStyleSupported,
  setKeyholeFadeTuning,
} from './celestialRing.js';
import { destroyTrackedReadout, initTrackedReadout } from './data/trackedReadout.js';
import { destroyWorldOverlay, initWorldOverlay } from './overlays/worldOverlay.js';
import {
  destroyDetection,
  initDetection,
  cycleMode as cycleDetectionMode,
  getDetectionDiagnostics as readDetectionDiagnostics,
  getDetectionTuning,
  getMode as getDetectionMode,
  setMode as setDetectionModeByLabel,
  suspendDetection,
  resumeDetection,
  setDetectionStyle,
  setDetectionTuning,
} from './data/detection.js';
import {
  ALLOCATION_STRATEGIES,
  canonicalizeDensity,
  defaultDensityForProfile,
  normalizeAllocationStrategy,
  normalizeProfile,
  profileForDensity,
} from './data/detectionPolicy.js';
import trafficLayer from './data/traffic.js';
import flightsLayer from './data/flights.js';
import militaryFlightsLayer from './data/militaryFlights.js';
import { isTr3b, toggleTr3b } from './data/tr3bRegistry.js';
import satellitesLayer from './data/satellites.js';
import cctvLayer from './data/cctv.js';
import radioLayer from './data/radio.js';
import bikeshareLayer from './data/bikeshare.js';
import aisLiveVesselsLayer from './data/aisLiveVessels.js';
import militaryAwarenessLayer from './data/militaryAwareness.js';
import militaryInstallationsLayer from './data/militaryInstallations.js';
import rocketLaunchesLayer from './data/rocketLaunches.js';
import {
  aggregateLayerLoading,
  canPresentDeferredStatusNotice,
  createGlobalStatusNotice,
  createLoadingFeedbackState,
  createTrafficSyncFeedbackState,
  presentGlobalLoadingStatus,
  presentGlobalStatusNotice,
  presentLoadingFeedback,
  reduceLoadingFeedback,
  reduceTrafficSyncFeedback,
} from './loadingFeedback.js';
import { setSplitFlapText } from './splitFlap.js';
import { cockpitEntryAllowed } from './contextModePolicy.js';

import {
  resolveCockpitUtilityAnchor,
  resolveCockpitUtilityLayout,
} from './cockpitUtilityLayout.js';
import {
  applyCockpitVisionStageIntensities,
  captureCockpitVisionBaseline,
  COCKPIT_VISION_MODES,
  normalizeCockpitVisionMode,
} from './cockpitVisionPolicy.js';
import {
  applyContactsDetection,
  shareCacheNeedsHeal,
  shareableDetectionState,
} from './contactsDetectionPolicy.js';
import { formatAwarenessLabel } from './data/militaryAwarenessEngine.js';
import { runCctvLayerEnableTransition } from './cctvFocusPolicy.js';
import {
  registerCctvFocusRequestListener,
  routeCctvFocusRequest,
} from './cctvFocusRequest.js';
import {
  flyToWorldTarget,
  registerWorldFocusRequestListener,
  routeWorldFocusRequest,
} from './worldFocus.js';
import {
  beginDeferredNavigation,
  reassertNavigationHandoff,
  registerNavigationAuthorityListener,
  runExplicitNavigation,
  stampInitialShareGesture,
} from './navigationPolicy.js';
import {
  cachedGroundFloor,
  cachedMeshFloor,
  GROUND_FLOOR_LIFT_M,
  meshFloorPreferred,
  warmGroundFloor,
} from './data/groundFloor.js';
import { sampleMeshFloorCells } from './data/meshFloorSampler.js';
import { holdContinuousRender, releaseContinuousRender, governorRequestRender } from './renderGovernor.js';
import {
  setScopeMaskEnabled,
  isScopeMaskEnabled,
  setScopeMaskFeather,
  getScopeMaskFeather,
  setScopeTerminusOverride,
  getScopeTerminusOverride,
  clampScopeTerminusPct,
} from './scopeMask.js';
import {
  fetchRegionalBrief,
  regionalDistanceM,
  weatherCodeLabel,
} from './data/regionalBrief.js';
import {
  altitudeRulerCurveInset,
  altitudeRulerTicks,
  bearingBetweenCoordinates,
  cockpitAnchorCorrectionStep,
  cockpitAltitudeDisplayFt,
  cockpitGroundSafeHeight,
  cockpitSurfaceWaitExpired,
  cockpitUiUpdateDue,
  compassDivisions,
  formatAltitudeRulerTick,
  formatCockpitContextScope,
  formatCompassDivision,
  formatSpeedRulerTick,
  normalizeHeading,
  relativeBearing,
  resolveCockpitContextReadout,
  resolveHudRailLayout,
  resolveTrackedAircraftInfo,
  slewHeading,
  speedRulerTicks,
} from './cockpitMath.js';

/** Versioned localStorage namespace prefix to invalidate stale panel layouts. */
const PANEL_LAYOUT_STORAGE_VERSION = 'v6';
const SHARE_PANEL_STATE_SPECS = Object.freeze([
  { id: 'control-panel', pinnable: true },
  { id: 'location-bar', pinnable: true },
  { id: 'data-panel' },
  { id: 'cctv-panel' },
  { id: 'radio-panel' },
  { id: 'scene-panel' },
  { id: 'global-context-panel' },
  { id: 'pp-toggles' },
  { id: 'param-slider-panel' },
]);
/** Standard map-view panels cleared out of the way on a fresh Cockpit entry. */
const COCKPIT_ENTRY_COLLAPSE_PANEL_IDS = Object.freeze([
  'data-panel',
  'cctv-panel',
  'scene-panel',
  'pp-toggles',
  'global-context-panel',
  'radio-panel',
]);
/**
 * Position keys are versioned separately from collapsed-state keys so layout
 * default changes (e.g. right-rail origin) can reset positions without also
 * resetting every panel's open/closed preference.
 */
const PANEL_POSITION_STORAGE_VERSION = 'v8';
const DETECTION_ALLOCATION_STORAGE_KEY = 'gev:detection-allocation:v1';
/** Z ladder: panels promote within [100, 139]; voice pill 150, toast 200, clean-view-exit 300. */
const PANEL_Z_BASE = 100;
const PANEL_Z_MAX = 139;
const COCKPIT_HEADING_SLEW_DPS = 28;
const COCKPIT_FORWARD_OFFSET_M = 7;
const COCKPIT_UP_OFFSET_M = 2.6;
const COCKPIT_MIN_GROUND_CLEARANCE_M = 12;
const COCKPIT_VIEW_PITCH_DEG = -4;
const COCKPIT_CAMERA_UPDATE_MS = 50;
const COCKPIT_HUD_UPDATE_MS = 100;
const COCKPIT_CONTEXT_UPDATE_MS = 250;
const COCKPIT_LAYOUT_SETTLE_MS = 240;
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
 * Fixed UI regions that can occupy the left accordion's vertical lane.
 * Rectangles are filtered at runtime for visibility and horizontal overlap,
 * so right-side/center controls do not reduce the lane unless they actually
 * intersect it at the current viewport size.
 */
const LEFT_STACK_OBSTACLE_SELECTOR = [
  '#cockpit-hud .cockpit-topline',
  '#cockpit-hud .cockpit-topline > div',
  '#title-bar',
  '#style-indicator',
  '#top-center-actions',
  '#traffic-sync-chip',
  '#cctv-sync-chip',
  '#intel-hud .hud-top-left',
  '#intel-hud .hud-top-right',
  '#intel-hud .hud-bottom-left',
  '#intel-hud .hud-bottom-right',
  '#intel-hud .hud-top-bar',
  '#intel-hud .hud-bottom-bar',
  '#intel-hud .hud-left-edge',
  '#intel-hud .hud-right-edge',
  '#cockpit-context',
  '#cesium-credits .cesium-credit-logoContainer',
  '#cesium-credits .cesium-credit-textContainer',
  '#location-bar',
  '#control-panel',
  '#gev-voice-control',
  '#pp-toggles',
  '#param-slider-panel',
].join(', ');
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
/**
 * Fixed UI regions that can occupy the right control lane. Runtime rectangle
 * filtering keeps the rail clear of whichever HUD variant is currently
 * visible without tying the layout to one screen height.
 */
const RIGHT_STACK_OBSTACLE_SELECTOR = [
  '#cockpit-hud .cockpit-topline',
  '#cockpit-hud .cockpit-topline > div',
  '#title-bar',
  '#style-indicator',
  '#top-center-actions',
  '#traffic-sync-chip',
  '#cctv-sync-chip',
  '#intel-hud .hud-top-left',
  '#intel-hud .hud-top-right',
  '#intel-hud .hud-bottom-left',
  '#intel-hud .hud-bottom-right',
  '#intel-hud .hud-top-bar',
  '#intel-hud .hud-bottom-bar',
  '#intel-hud .hud-left-edge',
  '#intel-hud .hud-right-edge',
  '#cockpit-context',
  '#cockpit-signal-stream',
  '#cesium-credits .cesium-credit-logoContainer',
  '#cesium-credits .cesium-credit-textContainer',
  '#command-dock',
  '#gev-voice-control',
].join(', ');
/** Display labels shown in the mini-status readout for each active style. */
const STYLE_STATUS_LABELS = {
  normal: 'NORMAL',
  retro: 'CRT',
  surveillance: 'NVG',
  thermal: 'FLIR',
  anime: 'ANIME',
  noir: 'NOIR',
  snow: 'SNOW',
};

/**
 * Central UI orchestrator for the God's Eye View application.
 *
 * Responsibilities:
 * - Visual controls and presets backed by the VisualEffects controller.
 * - Bloom and sharpen post-processing toggle/intensity control.
 * - Draggable/collapsible panel system with localStorage persistence,
 *   z-order stacking, and viewport-clamped positioning.
 * - CCTV panel: camera selection, coverage toggle, projection, calibration
 *   sliders, auto-hop, and summary typewriter effect.
 * - Location bar with city/POI preset pills, QWERTY key navigation,
 *   geocoding search, and inter-city world-jump transitions.
 * - Orbit controller integration for POI fly-around.
 * - Recording mode with safe-frame overlay and HUD mode switching.
 * - Share link encoding/decoding (delegates to ShareLinkManager).
 * - Detection overlay mode cycling and density tuning.
 * - Toast notification system.
 * - Intel HUD lifecycle and variant switching.
 */

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

class CockpitViewController {
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
    this.lastCompassSignature = '';
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
    const active = !!enabled;
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
    const converted = !!icao24 && isTr3b(icao24);
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
      // The credit lightbox owns Escape while its Close control or links hold
      // focus. Its target handler closes the overlay and restores attribution
      // focus; Cockpit must stay active behind it.
      if (event.target?.closest?.('.cesium-credit-lightbox')) return;
      if (document.getElementById('context-radio-dock')?.classList.contains('disclosure-open')) return;
      if (document.querySelector('#cockpit-utility-controls [aria-expanded="true"]')) return;
      if (this.context?.contains(event.target) && !this.contextCollapsed) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.setContextCollapsed(true);
        if (event.target === this.contextToggle || this.contextToggle?.contains?.(event.target)) {
          this.contextToggle?.blur?.();
        } else {
          this.contextToggle?.focus({ preventScroll: true });
        }
        return;
      }
      if (this.signalStream?.contains(event.target) && !this.signalCollapsed) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.setSignalCollapsed(true, { user: true });
        if (event.target === this.signalToggle || this.signalToggle?.contains?.(event.target)) {
          this.signalToggle?.blur?.();
        } else {
          this.signalToggle?.focus({ preventScroll: true });
        }
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      this.exit();
      return;
    }
    if (event.target?.closest?.('input, textarea, select, [contenteditable]')) return;
    const key = event.key?.toLowerCase();
    if (key === 'c' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (!this.active) {
        const cockpitAttempt = !!(this.readAircraftInfo() && this.viewer.trackedEntity?.position);
        if (!cockpitAttempt) return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!this.active && !this.isEntryAllowed()) return;
      const changed = this.active ? this.exit() : this.enter();
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
    this.lastCompassSignature = '';
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
    if (this.clock) this.clock.textContent = new Date().toISOString().slice(11, 19) + 'Z';
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
        ? new Date(snapshot.evaluatedAt).toISOString().slice(11, 19) + 'Z' : '--:--:--Z';
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
    const existing = [...this.signalList.children];
    const focusedEntry = existing.find((entry) => entry.contains(document.activeElement));
    const entriesByKey = new Map();
    for (const entry of existing) {
      const key = entry.dataset.signalKey;
      if (!entriesByKey.has(key)) entriesByKey.set(key, []);
      entriesByKey.get(key).push(entry);
    }
    const setText = (element, value) => {
      if (element.textContent !== value) element.textContent = value;
    };
    const entries = this.signalItems.map((item) => {
      // Identity includes the action target: a reused status key must never
      // silently turn a focused flight button into a different selection.
      const key = JSON.stringify([
        item.key, Boolean(item.target), item.target?.layerId || '', String(item.target?.id ?? ''),
      ]);
      let entry = entriesByKey.get(key)?.shift();
      if (!entry) {
        entry = document.createElement('li');
        entry.dataset.signalKey = key;
        const time = document.createElement('time');
        const body = document.createElement('div');
        const heading = document.createElement(item.target ? 'button' : 'strong');
        if (item.target) {
          heading.type = 'button';
          heading.className = 'cockpit-signal-target';
          const label = document.createElement('span');
          label.className = 'cockpit-signal-target-label';
          const rule = document.createElement('span');
          rule.className = 'cockpit-signal-target-rule';
          rule.setAttribute('aria-hidden', 'true');
          const chevron = document.createElement('span');
          chevron.className = 'material-symbols-outlined cockpit-signal-target-chevron';
          chevron.setAttribute('aria-hidden', 'true');
          chevron.textContent = 'chevron_right';
          heading.append(label, rule, chevron);
        }
        body.append(heading, document.createElement('span'));
        entry.append(time, body);
      }
      const [time, body] = entry.children;
      const [heading, copy] = body.children;
      const className = item.target ? `${item.tone} actionable` : item.tone;
      if (entry.className !== className) entry.className = className;
      setText(time, new Date(item.timestamp).toISOString().slice(11, 19) + 'Z');
      if (item.target) {
        heading.dataset.signalLayer = item.target.layerId;
        heading.dataset.signalId = item.target.id;
        const label = `Select flight ${item.title}`;
        if (heading.getAttribute('aria-label') !== label) heading.setAttribute('aria-label', label);
        setText(heading.children[0], item.title);
      } else {
        setText(heading, item.title);
      }
      setText(copy, item.detail);
      return entry;
    });
    const retainedFocus = entries.includes(focusedEntry) ? focusedEntry : null;
    if (focusedEntry && !retainedFocus) {
      // A departed contact cannot remain selectable. Continue from the stable
      // briefing footer instead of dropping keyboard traversal to the page top.
      (this.briefTabs?.[this.briefPageIndex] || this.signalToggle)?.focus({ preventScroll: true });
    }
    for (const entry of existing) if (!entries.includes(entry)) entry.remove();

    // Ordinary insertBefore moves disconnect an element and lose its focus.
    // Reorder the other rows around the focused row, which stays connected.
    const focusIndex = retainedFocus ? entries.indexOf(retainedFocus) : -1;
    if (retainedFocus) {
      let anchor = retainedFocus;
      for (let index = focusIndex - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry.nextElementSibling !== anchor) this.signalList.insertBefore(entry, anchor);
        anchor = entry;
      }
    }
    let anchor = retainedFocus ? retainedFocus.nextElementSibling : this.signalList.firstElementChild;
    for (let index = focusIndex + 1; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry === anchor) anchor = anchor.nextElementSibling;
      else this.signalList.insertBefore(entry, anchor);
    }
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

export class StyleManager {
  /**
   * @param {Cesium.Viewer} viewer - The CesiumJS viewer instance.
   * @param {object} [options]
   */
  constructor(viewer, { mapStackController = null, placeSearch } = {}) {
    this.viewer = viewer;
    this.mapStackController = mapStackController;
    this.placeSearch = placeSearch;
    this._visualEffects = new VisualEffects({
      viewer,
      requestRender: governorRequestRender,
      holdRender: holdContinuousRender,
      releaseRender: releaseContinuousRender,
    });
    this.activeStyle = 'normal';
    document.documentElement.dataset.gevStyle = this.activeStyle;

    // True once the user manually changes detection (button/key/slider/voice).
    // Gates per-style detection defaults so they never stomp an explicit choice.
    this._detectionUserOverridden = false;

    // Bloom/sharpen state
    this._recordingMode = false;
    this._recordingConfig = { hidePanels: true, hudMode: 'minimal', safeFrame: '16:9' };
    this._preRecordingHudState = null;
    this._panelZCounter = PANEL_Z_BASE + 10;
    this._lastLoadingFeedbackUpdateAt = 0;
    this._loadingFeedbackState = createLoadingFeedbackState();
    this._loadingFeedbackEvent = null;
    this._loadingFeedbackTicker = null;
    this._globalStatusNotice = null;
    this._shareTrackingAcquiringKey = null;
    this._shareTrackingNoticeGeneration = 0;
    this._globeResetPromise = null;
    this._dataManager = null;

    this._leftStackLayoutFrame = null;
    this._leftStackReconsiderAutoCollapse = false;
    this._leftStackResizeObserver = null;
    this._leftStackMutationObserver = null;
    this._leftStackHudTransitionHandler = null;
    this._leftStackCollapsedHeights = new Map();
    this._leftStackPreferredPanelId = null;
    this._rightPanelStack = document.getElementById('right-context-rail');
    this._rightStackLayoutFrame = null;
    this._rightStackReconsiderAutoCollapse = false;
    this._rightStackResizeObserver = null;
    this._rightStackMutationObserver = null;
    this._rightStackHudTransitionHandler = null;
    this._rightStackPreferredPanelId = null;
    this._adaptivePanelSettleTimer = null;
    this._windowResizeHandler = null;
    this._loadingVisibilityHandler = null;
    this._cctvRequestFocusHandler = null;
    this._removeCctvRequestFocusListener = null;
    this._worldRequestFocusHandler = null;
    this._removeWorldRequestFocusListener = null;
    this._removeNavigationAuthorityListener = null;
    this._navigationOwnerChangedRemover = null;
    this._navigationGeneration = 0;
    this._activeLocationSearchGeneration = null;
    this._initialShareState = null;
    this._initialShareNavigationGeneration = null;
    this._initialShareRestoreTimeout = null;
    this._layerStateCoordinator = null;
    this._layerStateRestorePromise = null;
    this._awarenessSelectedHandler = null;
    this._awarenessClearedHandler = null;
    this._disposed = false;
    this._draggableResizeObserver = null;

    // DOM refs
    this._styleIndicator = document.getElementById('active-style-name');
    this._sliderPanel = document.getElementById('param-slider-panel');
    this._sliderContainer = document.getElementById('param-sliders');
    this._ppToggles = document.getElementById('pp-toggles');
    this._bloomBtn = document.getElementById('bloom-toggle');
    this._bloomSliderRow = document.getElementById('bloom-slider-row');
    this._bloomSlider = document.getElementById('bloom-intensity-slider');
    this._bloomSliderValue = document.getElementById('bloom-intensity-value');
    this._sharpenBtn = document.getElementById('sharpen-toggle');
    this._sharpenSliderRow = document.getElementById('sharpen-slider-row');
    this._sharpenSlider = document.getElementById('sharpen-intensity-slider');
    this._sharpenSliderValue = document.getElementById('sharpen-intensity-value');
    this._hudBtn = document.getElementById('hud-toggle');
    this._hudLayoutRow = document.getElementById('hud-layout-row');
    this._hudLayoutSelect = document.getElementById('hud-layout-select');
    this._detectionSliderRow = document.getElementById('detection-slider-row');
    this._detectionDensitySlider = document.getElementById('detection-density-slider');
    this._detectionDensityValue = document.getElementById('detection-density-value');
    this._detectionAllocationRow = document.getElementById('detection-allocation-row');
    this._detectionAllocationBtns = [
      document.getElementById('detection-allocation-elastic'),
      document.getElementById('detection-allocation-weighted'),
    ].filter(Boolean);
    this._detectionFadeRow = document.getElementById('detection-fade-row');
    this._detectionFadeSlider = document.getElementById('detection-fade-slider');
    this._detectionFadeValue = document.getElementById('detection-fade-value');
    this._detectionOpacityRow = document.getElementById('detection-opacity-row');
    this._detectionOpacitySlider = document.getElementById('detection-opacity-slider');
    this._detectionOpacityValue = document.getElementById('detection-opacity-value');
    let storedDetectionAllocation = 'ELASTIC';
    try {
      storedDetectionAllocation = localStorage.getItem(DETECTION_ALLOCATION_STORAGE_KEY) || 'ELASTIC';
    } catch { /* storage can be unavailable in privacy/test contexts */ }
    this._detectionAllocationPreference = normalizeAllocationStrategy(storedDetectionAllocation);
    this._celestialBtn = document.getElementById('celestial-toggle');
    this._scopeBtn = document.getElementById('scope-toggle');
    this._scopeFeatherSlider = document.getElementById('scope-feather-slider');
    this._scopeFeatherValue = document.getElementById('scope-feather-value');
    this._mapStackChips = document.getElementById('map-stack-chips');
    this._mapStackStatus = document.getElementById('map-stack-status');
    this._mapStackChangeHandler = null;
    this._cleanViewBtn = document.getElementById('clean-view-toggle');
    this._cleanViewExitBtn = document.getElementById('clean-view-exit');
    this._dataPanel = document.getElementById('data-panel');
    this._scenePanel = document.getElementById('scene-panel');
    this._cctvPanel = document.getElementById('cctv-panel');
    this._radioPanel = document.getElementById('radio-panel');
    this._contextRadioDock = document.getElementById('context-radio-dock');
    this._contextRadioToggleBtn = document.getElementById('context-radio-toggle-btn');
    this._contextRadioMini = document.getElementById('context-radio-mini');
    this._contextRadioMiniEnableBtn = document.getElementById('context-radio-mini-enable-btn');
    this._contextRadioDetailsBtn = document.getElementById('context-radio-details-btn');
    this._contextRadioMiniCloseBtn = document.getElementById('context-radio-mini-close-btn');
    this._contextRadioMiniStation = document.getElementById('context-radio-mini-station');
    this._contextRadioMiniPrevBtn = document.getElementById('context-radio-mini-prev-btn');
    this._contextRadioMiniPlayBtn = document.getElementById('context-radio-mini-play-btn');
    this._contextRadioMiniNextBtn = document.getElementById('context-radio-mini-next-btn');
    this._contextRadioMiniVolume = document.getElementById('context-radio-mini-volume');
    this._contextRadioMiniVolumeValue = document.getElementById('context-radio-mini-volume-value');
    this._cockpitUtilityControls = document.getElementById('cockpit-utility-controls');
    this._cockpitDisplayToggleBtn = document.getElementById('cockpit-display-toggle-btn');
    this._cockpitDisplayPanel = document.getElementById('cockpit-display-panel');
    this._cockpitDisplayPortalRecords = [];
    this._cockpitDisplayPortalActive = false;
    this._cockpitDisplayModeHandler = null;
    this._cockpitRadioToggleBtn = document.getElementById('cockpit-radio-toggle-btn');
    this._cockpitRadioPanel = document.getElementById('cockpit-radio-panel');
    this._cockpitRadioEnableBtn = document.getElementById('cockpit-radio-enable-btn');
    this._cockpitRadioStation = document.getElementById('cockpit-radio-station');
    this._cockpitRadioPrevBtn = document.getElementById('cockpit-radio-prev-btn');
    this._cockpitRadioPlayBtn = document.getElementById('cockpit-radio-play-btn');
    this._cockpitRadioNextBtn = document.getElementById('cockpit-radio-next-btn');
    this._cockpitRadioVolume = document.getElementById('cockpit-radio-volume');
    this._cockpitRadioVolumeValue = document.getElementById('cockpit-radio-volume-value');
    this._radioLayerState = document.getElementById('radio-layer-state');
    this._radioEnableBtn = document.getElementById('radio-enable-btn');
    this._radioFilter = document.getElementById('radio-filter');
    this._radioStationName = document.getElementById('radio-station-name');
    this._radioStationMeta = document.getElementById('radio-station-meta');
    this._radioStationTags = document.getElementById('radio-station-tags');
    this._radioTuner = document.getElementById('radio-tuner');
    this._radioTunerSlider = document.getElementById('radio-tuner-slider');
    this._radioTunerNeedle = document.getElementById('radio-tuner-needle');
    this._radioTunerBandLabel = document.getElementById('radio-tuner-band-label');
    this._radioTunerValue = document.getElementById('radio-tuner-value');
    this._radioTunerStation = document.getElementById('radio-tuner-station');
    this._radioPrevBtn = document.getElementById('radio-prev-btn');
    this._radioPlayBtn = document.getElementById('radio-play-btn');
    this._radioNextBtn = document.getElementById('radio-next-btn');
    this._radioStopBtn = document.getElementById('radio-stop-btn');
    this._radioVolume = document.getElementById('radio-volume');
    this._radioVolumeValue = document.getElementById('radio-volume-value');
    this._radioPlaybackState = document.getElementById('radio-playback-state');
    this._radioStationHomepage = document.getElementById('radio-station-homepage');
    this._globalContextFlightsBtn = document.getElementById('global-context-flights-btn');
    this._globalContextMissionsBtn = document.getElementById('global-context-missions-btn');
    this._contextModeStandby = document.getElementById('context-mode-standby');
    this._contextFlightsView = document.getElementById('context-flights-view');
    this._contextMissionsView = document.getElementById('context-missions-view');
    this._installationsSearchBtn = document.getElementById('installations-search-btn');
    this._leftPanelStack = document.getElementById('left-panel-stack');
    this._cctvEnableBtn = document.getElementById('cctv-enable-btn');
    this._cctvNearestBtn = document.getElementById('cctv-nearest-btn');
    this._cctvPrevBtn = document.getElementById('cctv-prev-btn');
    this._cctvNextBtn = document.getElementById('cctv-next-btn');
    this._cctvSelect = document.getElementById('cctv-camera-select');
    this._cctvFocusBtn = document.getElementById('cctv-focus-btn');
    this._cctvCoverageBtn = document.getElementById('cctv-coverage-btn');
    this._cctvAutoHopBtn = document.getElementById('cctv-auto-hop-btn');
    this._cctvProjectionBtn = document.getElementById('cctv-projection-btn');
    this._cctvQualityChip = document.getElementById('cctv-quality-chip');
    this._cctvAdjustBtn = document.getElementById('cctv-adjust-btn');
    this._cctvCalReadout = document.getElementById('cctv-cal-readout');
    this._cctvCalibSaveBtn = document.getElementById('cctv-calib-save-btn');
    this._cctvCalibResetBtn = document.getElementById('cctv-calib-reset-btn');
    this._cctvFrame = document.getElementById('cctv-frame');
    this._cctvFrameWrap = document.getElementById('cctv-frame-wrap');
    this._cctvSourceBadge = document.getElementById('cctv-source-badge');
    this._cctvMeta = document.getElementById('cctv-meta');
    this._cctvSummary = document.getElementById('cctv-summary');
    this._shareBtn = document.getElementById('share-btn');
    this._clearSelectedLayersBtn = document.getElementById('clear-selected-layers');
    this._globalLoadingStatus = document.getElementById('global-loading-status');
    this._globalLoadingLabel = document.getElementById('global-loading-label');
    this._globalLoadingDetail = document.getElementById('global-loading-detail');
    this._resetGlobeBtn = document.getElementById('reset-globe-view');
    this._cockpitResetGlobeBtn = document.getElementById('cockpit-reset-globe');
    this._styleButtons = document.getElementById('style-buttons');
    this._trafficSyncChip = document.getElementById('traffic-sync-chip');
    this._trafficSyncLabel = document.getElementById('traffic-sync-label');
    this._trafficSyncProgress = document.getElementById('traffic-sync-progress');
    this._cctvSyncChip = document.getElementById('cctv-sync-chip');
    this._cctvSyncLabel = document.getElementById('cctv-sync-label');
    this._cctvSyncProgress = document.getElementById('cctv-sync-progress');
    this._toast = document.getElementById('toast');
    this._locationSearch = document.getElementById('location-search');
    this._searchToggle = document.getElementById('search-toggle');
    this._locationPills = document.getElementById('location-pills');
    this._poiRow = document.getElementById('poi-row');
    this._locationBarDivider = document.getElementById('location-bar-divider');
    this._styleMiniValue = document.getElementById('style-mini-value');
    this._locationMiniCity = document.getElementById('location-mini-city');
    this._locationMiniPoi = document.getElementById('location-mini-poi');
    this._safeFrameOverlay = document.getElementById('safe-frame-overlay');
    this._safeFrameBox = document.getElementById('safe-frame-box');
    this._activeLocationId = null;
    this._expandedCityId = null;
    this._activePoiIndex = null;
    this._currentTarget = null; // Cesium.Cartesian3 of current POI target
    this._currentPoi = null;    // Current POI data object
    // Formatted address of the last free-text geocode search. Preset pills set
    // _activeLocationId instead; a search has no preset record, so this is the
    // only thing the mini-status can report for it.
    this._searchedLocationLabel = null;
    this._trafficSyncFeedbackState = createTrafficSyncFeedbackState();
    this._trafficTransitionTimer = null;
    this._lastTrafficChipUpdateAt = 0;

    // Orbit controller
    this.orbitController = new OrbitController(viewer);
    this._orbitIndicator = null;

    // Intel HUD
    this.hud = new IntelHUD(viewer);
    this._cockpitVisionMode = 'optical';
    this._cockpitVisionRestore = null;
    this._cockpitPanelRestore = null;
    // True only while the open Data Layers panel is the reason Cockpit's
    // Contact panel is collapsed. A user-collapsed Contact panel must remain
    // collapsed when Data Layers closes.
    this._cockpitContextCollapsedForDataPanel = false;
    /** Pre-Contacts detection state, restored on deactivation (see _syncContactsDetection). */
    this._contactsDetectionRestore = null;
    this.cockpitView = new CockpitViewController(viewer, {
      onVisionChange: (mode, active, options) => this._setCockpitVision(mode, active, options),
      onCameraTakeover: () => this._stampNavigation({ cancelPendingSelection: false }),
      getInheritedVisionLabel: () => (
        STYLE_STATUS_LABELS[this.activeStyle]
        || String(this.activeStyle || 'normal').toUpperCase()
      ),
      isEntryAllowed: () => cockpitEntryAllowed({
        contextMode: this._contextMode,
        contextModeChanging: this._contextModeChanging,
        flightsEnabled: !!this._dataManager?.isEnabled('flights'),
        militaryEnabled: !!this._dataManager?.isEnabled('military'),
      }),
      onEntered: () => {
        // A new Cockpit session owns both side rails. Clear standard map-view
        // panels once on entry; NEXT/PREVIOUS never reaches this callback, so
        // panels the operator opens while already inside remain untouched.
        this._cockpitPanelRestore = new Map();
        this._cockpitContextCollapsedForDataPanel = false;
        for (const panelId of COCKPIT_ENTRY_COLLAPSE_PANEL_IDS) {
          const panel = document.getElementById(panelId);
          if (panel) {
            this._cockpitPanelRestore.set(panelId, panel.classList.contains('collapsed'));
          }
          this.setPanelCollapsed(panelId, true, {
            persist: false,
            syncShare: false,
          });
        }
        this.cockpitView?.setContextCollapsed(false);
        this.cockpitView?.setSignalCollapsed(false, { user: true });
      },
      onExited: () => {
        const restore = this._cockpitPanelRestore;
        this._cockpitPanelRestore = null;
        this._cockpitContextCollapsedForDataPanel = false;
        if (!restore) return;
        for (const [panelId, wasCollapsed] of restore) {
          this.setPanelCollapsed(panelId, wasCollapsed, {
            persist: false,
            syncShare: false,
          });
        }
      },
      restoreTrackingFrame: (entity) => {
        const [layerId, ...idParts] = String(entity?.gevTrackedId || '').split(':');
        const trackedId = idParts.join(':');
        if (!trackedId) return false;
        if (layerId === 'flights') return flightsLayer.refocusTrackedById?.(trackedId) === true;
        if (layerId === 'military') return militaryFlightsLayer.refocusTrackedById?.(trackedId) === true;
        return false;
      },
    });

    // Full-globe sun/moon ring. It is a crisp screen-space overlay above the
    // Cesium canvas but below the HUD/detection/readout z ladder.
    this.celestialRing = new CelestialRing(viewer, {
      enabled: false,
      onAutoDisable: () => this.setCelestialRingEnabled(false, {
        syncShare: !!this.shareLinkManager,
        focus: false,
      }),
    });

    // Share Link Manager
    this.shareLinkManager = new ShareLinkManager(viewer, {
      onRestore: async (state) => {
        const {
          style,
          bloom,
          sharpen,
          bloomIntensity,
          bloomVersion,
          sharpenIntensity,
          hudVariant,
          hudVisible,
          detectionMode,
          detectionDensity,
          detectionAllocation,
          detectionFadePct,
          detectionOutsideOpacityPct,
          celestialRing,
          scopeEnabled,
          scopeFeatherPct,
          scopeTerminusPct,
          mapStack,
          panelState,
          styleParams,
        } = state || {};
        // Ignore the retired 'ai-edit' style from older share links.
        if (style && style !== 'normal' && style !== 'ai-edit') {
          this.setStyle(style, { applyPreset: true, revealParameters: false, restore: true });
        }
        if (styleParams && style && this.stages[style] && STYLES[style]?.uniforms) {
          for (const [uniformName, uniformValue] of Object.entries(styleParams)) {
            if (!Object.hasOwn(STYLES[style].uniforms, uniformName)) continue;
            this.stages[style].uniforms[uniformName] = uniformValue;
          }
          this._updateSliderPanel(style, { reveal: false });
        }
        if (typeof bloomIntensity === 'number' && this._bloomSlider) {
          const intensity = decodeBloomIntensity(bloomIntensity, bloomVersion);
          this._setBloomIntensity(intensity, { syncShare: false });
        }
        if (typeof sharpenIntensity === 'number' && this._sharpenSlider) {
          const pct = Math.max(0, Math.min(100, Math.round(sharpenIntensity)));
          this._sharpenSlider.value = String(pct);
          this._sharpenSliderValue.textContent = `${pct}%`;
          this._applySharpenIntensity(pct / 100);
        }
        if (typeof bloom === 'boolean') this._setBloomEnabled(bloom);
        if (typeof sharpen === 'boolean') this._setSharpenEnabled(sharpen);
        if (hudVariant) this._setHudVariant(hudVariant);
        if (typeof hudVisible === 'boolean') {
          this.hud.setMode(hudVisible ? 'on' : 'off');
          this._updateHudButtonState();
        }
        if (typeof detectionDensity === 'number' && this._detectionDensitySlider) {
          const pct = canonicalizeDensity(detectionDensity);
          this._detectionDensitySlider.value = String(pct);
          this._detectionDensityValue.textContent = `${pct}%`;
          this._applyDetectionDensityFromUi();
        }
        if (detectionAllocation) {
          this._setDetectionAllocation(detectionAllocation, { syncShare: false, persist: false });
        }
        if (typeof detectionFadePct === 'number' && this._detectionFadeSlider) {
          this._detectionFadeSlider.value = String(detectionFadePct);
        }
        if (typeof detectionOutsideOpacityPct === 'number' && this._detectionOpacitySlider) {
          this._detectionOpacitySlider.value = String(detectionOutsideOpacityPct);
        }
        this._applyDetectionFadeFromUi();
        if (detectionMode) this._setDetectionMode(detectionMode);
        if (typeof celestialRing === 'boolean') {
          this.setCelestialRingEnabled(celestialRing, { syncShare: false, focus: false });
        }
        if (typeof scopeEnabled === 'boolean') {
          setScopeMaskEnabled(scopeEnabled);
          this._scopeBtn?.classList.toggle('active', scopeEnabled);
          this._scopeBtn?.setAttribute('aria-pressed', String(scopeEnabled));
        }
        if (typeof scopeFeatherPct === 'number' && this._scopeFeatherSlider) {
          const pct = Math.max(0, Math.min(100, Math.round(scopeFeatherPct)));
          this._scopeFeatherSlider.value = String(pct);
          if (this._scopeFeatherValue) this._scopeFeatherValue.textContent = `${pct}%`;
          setScopeMaskFeather(pct / 100);
        }
        // null restores the altitude-adaptive ramp; a number pins the terminus
        // (clamped to the supported 94..100 band, same as the `sce` hash key).
        if (scopeTerminusPct === null) setScopeTerminusOverride(null);
        else if (typeof scopeTerminusPct === 'number') {
          const pinned = clampScopeTerminusPct(scopeTerminusPct);
          setScopeTerminusOverride(pinned == null ? null : pinned / 100);
        }
        const mapStackRestore = mapStack
          ? this._setMapStack(mapStack, { syncShare: false })
          : Promise.resolve();
        if (panelState) this._restorePanelState(panelState);
        await mapStackRestore;
        this._syncShareState();
      },
      isNavigationCurrent: (generation) => generation === this._navigationGeneration,
      cancelOwnedNavigation: () => this.viewer.camera.cancelFlight(),
    });
    this.shareLinkManager.setPanelStateProvider(() => this._buildSharePanelState());
    this.shareLinkManager.setStyleParamStateProvider((styleName) => {
      const shader = STYLES[styleName];
      const stage = this.stages[styleName];
      if (!shader?.uniforms || !stage) return null;
      return Object.fromEntries(
        Object.keys(shader.uniforms).map((uniformName) => [uniformName, stage.uniforms[uniformName]]),
      );
    });
    // Parse before panel chrome initializes so every valid share URL starts
    // from deterministic markup defaults instead of recipient-local panel
    // preferences. Encoded panel fields are applied after all panels exist.
    this._initialShareState = this.shareLinkManager.parseInitialHash();

    this._detectionBtn = document.getElementById('detection-toggle');
    this._models3dBtn = document.getElementById('models3d-toggle');
    this._models3dModeRow = document.getElementById('models3d-mode-row');
    this._models3dModeBtns = [
      document.getElementById('models3d-mode-proximity'),
      document.getElementById('models3d-mode-all'),
    ];
    // DISPLAY-rail 3D-aircraft toggle (flights layer param). DEFAULT-ON in
    // PROXIMITY (owner directive 2026-08-22) — mirrors the `models3d` default in
    // layerState.js and `_models3dEnabled` in both flight layers, and the `active`
    // class the button carries in index.html. A fresh boot skips layer-state
    // restoration, so these initializers are the only thing keeping the lit
    // button and the armed layer in agreement.
    this._models3dEnabled = true;
    this._models3dMode = 'proximity'; // 'proximity' (nearest in view) | 'all' (every in-view plane)

    // The shared world-overlay host must own its one postRender lane before
    // detection and tracked-readout initialize. It stays transparent until a
    // production source explicitly registers entries.
    initWorldOverlay(viewer);

    // Initialize detection overlay BEFORE style stages so the composite
    // stage is first in the post-process pipeline
    initDetection(viewer, [trafficLayer, flightsLayer, militaryFlightsLayer, satellitesLayer, cctvLayer, bikeshareLayer, aisLiveVesselsLayer], (modeLabel) => {
      this._updateDetectionButton(modeLabel);
    });
    initTrackedReadout(viewer);
    setDetectionStyle(this.activeStyle);
    this._applyDetectionDensityFromUi();

    this._initStages();
    this._initBloomSharpen();
    this._initUI();
    this._initMapStackControl();
    this._initPanelChrome();
    this._initLeftPanelAdaptiveLayout();
    this._initRightPanelAdaptiveLayout();
    this._initRadioPanel();
    this._initCctvPanel();
    this._initGlobalContextPanel();
    this._initLocationBar();
    this._initShareButton();
    this._initClearSelectedLayersButton();
    this._initHUDToggle();
    this._initModels3dToggle();
    this._applyGlobalPostDefaults();
    this._initOrbit();
    this._initRecordingOverlay();
    this._startAnimationLoop();
    this._startTrafficChipTicker();
    this._updateStyleMiniStatus();
    this._updateLocationMiniStatus();

    // Restore from URL hash if present
    const savedState = this._initialShareState;
    this._initialShareRestorePromise = savedState
      ? new Promise((resolve) => { this._resolveInitialShareRestore = resolve; })
      : Promise.resolve({ status: 'not-requested', share: null, layers: [] });
    if (savedState) {
      this._hasShareState = true;
      // Reserve camera authority now; the delayed mesh-friendly flight may
      // run only if no newer user, voice, or tracking navigation has won.
      this._initialShareNavigationGeneration = this._beginDeferredNavigation(
        'shared view',
        { cancelPendingSelection: false },
      );
      this._initialShareRestoreTimeout = setTimeout(() => {
        this._initialShareRestoreTimeout = null;
        if (this._disposed) return;
        const generation = this._initialShareNavigationGeneration;
        const applyCamera = Number.isInteger(generation)
          && this._reassertNavigationHandoff(generation);
        void (async () => {
          try {
            const share = await this.shareLinkManager.applyState(savedState, {
              applyCamera,
              navigationToken: generation,
            });
            const layers = await (this._layerStateRestorePromise || Promise.resolve([]));
            const tracking = share.camera === 'applied'
              ? await this._layerStateCoordinator?.restoreShareTrackingSelection?.()
              : {
                  status: 'superseded',
                  cleared: this._layerStateCoordinator?.cancelPendingShareTracking?.(
                    'shared-camera-superseded',
                    { clearSelection: true },
                  ) === true,
                };
            this.shareLinkManager.completeInitialRestore();
            this._settleInitialShareRestore({ status: 'settled', share, layers, tracking });
          } catch (error) {
            this.shareLinkManager.completeInitialRestore();
            this._settleInitialShareRestore({
              status: 'failed',
              error: String(error?.message || error),
              share: null,
              layers: [],
            });
          }
        })();
      }, 1500);
    } else {
      this._syncShareState();
    }
    // A recipient can orbit before or during the delayed share flight. That
    // gesture keeps ordinary layer state but revokes the passive base camera
    // and selected-subject Follow so delayed work cannot seize navigation.
    this._initialShareGestureHandler = () => {
      if (
        this._disposed
        || !this._hasShareState
        || !this._resolveInitialShareRestore
      ) return;
      stampInitialShareGesture((options) => this._stampNavigation(options));
    };
    this.viewer?.canvas?.addEventListener('pointerdown', this._initialShareGestureHandler, {
      passive: true,
    });
    this.viewer?.canvas?.addEventListener('wheel', this._initialShareGestureHandler, {
      passive: true,
    });

    // Keep the parameter panel from overlapping toggle controls.
    this._layoutRightPanels();
    this._syncCctvPanelViewport();
    this._windowResizeHandler = () => {
      this._scheduleRightPanelLayout({ reconsiderAutoCollapse: true });
      this._syncCctvPanelViewport();
      this._scheduleLeftPanelLayout({ reconsiderAutoCollapse: true });
    };
    window.addEventListener('resize', this._windowResizeHandler);
    // The loading-chip ticker is stopped while the tab is hidden (it can do no
    // useful work off-screen and must not hold a 60ms timer there). Resample on
    // return so the time-driven reducer catches up on real elapsed time — and
    // re-arms its own ticker if the batch is still running.
    this._loadingVisibilityHandler = () => {
      if (!document.hidden) this._updateGlobalLoadingFeedback();
    };
    document.addEventListener('visibilitychange', this._loadingVisibilityHandler);
    this._cctvRequestFocusHandler = (event) => routeCctvFocusRequest(
      event,
      (activate, focus) => this._runExplicitCctvFocus(activate, focus),
      (cameraId, durationSec) => cctvLayer.focusCamera(cameraId, durationSec),
    );
    this._removeCctvRequestFocusListener = registerCctvFocusRequestListener(
      window,
      this._cctvRequestFocusHandler,
    );
    this._worldRequestFocusHandler = (event) => routeWorldFocusRequest(
      event,
      (detail, fly) => this._runExplicitWorldFocus(detail, fly),
      (detail) => flyToWorldTarget(this.viewer, detail),
    );
    this._removeWorldRequestFocusListener = registerWorldFocusRequestListener(
      window,
      this._worldRequestFocusHandler,
    );
    this._navigationOwnerChangedRemover = viewer.trackedEntityChanged.addEventListener((entity) => {
      if (entity && !this._disposed) this._stampNavigation({ cancelPendingSelection: false });
    });
    // Vessel/installation focus flies without ever assigning a tracked entity,
    // so it cannot reach the listener above. It announces instead.
    this._removeNavigationAuthorityListener = registerNavigationAuthorityListener(
      window,
      (event) => {
        if (this._disposed) return;
        this._stampNavigation({
          cancelPendingSelection: event?.detail?.cancelPendingSelection !== false,
        });
      },
    );
  }

  // Compatibility reads for existing controls, scene snapshots and Cockpit.
  get stages() { return this._visualEffects.stages; }
  get transitions() { return this._visualEffects.transitions; }
  get bloomEnabled() { return this._visualEffects.bloomEnabled; }
  get sharpenEnabled() { return this._visualEffects.sharpenEnabled; }
  get _bloomStage() { return this._visualEffects.bloomStage; }
  get _sharpenStage() { return this._visualEffects.sharpenStage; }

  /** Advance camera authority and settle any older search UI immediately. */
  _stampNavigation({ cancelPendingSelection = true, clearSearchedLocation = true } = {}) {
    this._navigationGeneration += 1;
    // A newer destination owns the camera, so the last free-text search is no
    // longer where we are. DEFERRED navigation opts out here and clears at the
    // reassert seam instead: a geocode that never resolves moves no camera, and
    // a lookup that fails must not blank a readout that is still true.
    if (clearSearchedLocation) this.clearSearchedLocation();
    if (cancelPendingSelection) {
      if (this._hasShareState && this._resolveInitialShareRestore && !this._layerStateCoordinator) {
        this._initialShareSelectionSuperseded = true;
      }
      const passivelyClearedShareSelection = this._layerStateCoordinator
        ?.cancelPendingShareTracking?.(
          'superseded-by-explicit-navigation',
          { clearSelection: true },
        ) === true;
      try { flightsLayer.cancelPendingTrackingRestore?.(); } catch { /* best effort */ }
      try { militaryFlightsLayer.cancelPendingTrackingRestore?.(); } catch { /* best effort */ }
      try { satellitesLayer.cancelPendingTrackingRestore?.(); } catch { /* best effort */ }
      // A deliberate destination supersedes share-selected entities that have
      // not arrived yet. Active owners publish their clear when released.
      if (!passivelyClearedShareSelection && !flightsLayer.getTrackedInfo?.()) {
        this._dataManager?.setLayerParams('flights', {
          selectedFlightsTrackingId: null,
        }, { origin: 'tool' });
      }
      if (!passivelyClearedShareSelection && !militaryFlightsLayer.getTrackedInfo?.()) {
        this._dataManager?.setLayerParams('military', {
          selectedMilitaryTrackingId: null,
        }, { origin: 'tool' });
      }
      if (!passivelyClearedShareSelection && !satellitesLayer.getTrackedInfo?.()) {
        this._dataManager?.setLayerParams('satellites', {
          selectedSatTrackingId: null,
        }, { origin: 'tool' });
      }
    }
    if (this._activeLocationSearchGeneration !== null) {
      this._settleLocationSearchUi(this._activeLocationSearchGeneration);
    }
    return this._navigationGeneration;
  }

  /** Settle only the search generation that still owns the shared input UI. */
  _settleLocationSearchUi(generation) {
    if (this._activeLocationSearchGeneration !== generation) return;
    this._activeLocationSearchGeneration = null;
    this._locationSearch?.classList.remove('searching', 'expanded');
    if (this._locationSearch) this._locationSearch.value = '';
    this._locationSearch?.blur();
  }

  /** Release every follow owner while preserving Contact and vessel selection. */
  _releaseFollowCamera({
    preserveVesselSelection = true,
    preserveCameraFlight = false,
    trackingOrigin = 'tool',
  } = {}) {
    let contactSelected = false;
    try {
      contactSelected = Boolean(
        militaryAwarenessLayer.releaseCameraOwnership?.({
          preserveVesselSelection,
          origin: trackingOrigin,
        }),
      );
    } catch {
      try { flightsLayer.stopTracking?.({ origin: trackingOrigin }); } catch { /* best-effort release */ }
      try { militaryFlightsLayer.stopTracking?.({ origin: trackingOrigin }); } catch { /* best-effort release */ }
      if (!preserveVesselSelection) {
        try { aisLiveVesselsLayer.clearSelection?.(); } catch { /* best-effort release */ }
      }
    }
    try { satellitesLayer.stopTracking?.({ origin: trackingOrigin }); } catch { /* best-effort release */ }
    try { rocketLaunchesLayer.releaseCameraOwnership?.(); } catch { /* best-effort release */ }
    this.viewer.trackedEntity = undefined;
    interruptCameraMotion('explicit-navigation');
    this._stopOrbit();
    if (!preserveCameraFlight) this.viewer.camera.cancelFlight();
    try {
      this.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    } catch { /* teardown race */ }
    return contactSelected;
  }

  /** Run one immediate destination through the shared ownership policy. */
  _runExplicitNavigation(noun, navigate, releaseOptions = undefined) {
    return runExplicitNavigation({
      disposed: this._disposed,
      cockpitActive: !!this.cockpitView?.active,
      noun,
      showToast: (text) => this._showToast(text),
      stamp: () => this._stampNavigation(),
      release: () => this._releaseFollowCamera(releaseOptions),
      navigate,
    });
  }

  /** Accept a delayed lookup without releasing its current camera owner. */
  _beginDeferredNavigation(noun = 'location', { cancelPendingSelection = true } = {}) {
    return beginDeferredNavigation({
      disposed: this._disposed,
      cockpitActive: !!this.cockpitView?.active,
      noun,
      showToast: (text) => this._showToast(text),
      // The searched-location readout survives the STAMP; only a flight that
      // actually starts invalidates it (see the release hook below).
      stamp: () => this._stampNavigation({ cancelPendingSelection, clearSearchedLocation: false }),
    });
  }

  /** Final authority check and release immediately before a delayed flight. */
  _reassertNavigationHandoff(generation) {
    return reassertNavigationHandoff({
      generation,
      currentGeneration: this._navigationGeneration,
      cockpitActive: !!this.cockpitView?.active,
      disposed: this._disposed,
      showToast: (text) => this._showToast(text),
      // Reached only once the handoff is granted, immediately before the
      // deferred flight starts — so a lookup that failed, was superseded, or
      // was refused by the cockpit leaves the old readout standing.
      release: () => {
        this.clearSearchedLocation();
        return this._releaseFollowCamera();
      },
    });
  }

  /** Public lifecycle seam used by voice location navigation. */
  beginDeferredLocationNavigation() {
    return this._beginDeferredNavigation('location');
  }

  /** Public final-authority seam used by voice geocoding. */
  reassertDeferredLocationNavigation(generation) {
    return this._reassertNavigationHandoff(generation);
  }

  /** Public immediate route used by voice destinations. */
  runImmediateLocationNavigation(navigate) {
    return this.runImmediateNavigation('location', navigate);
  }

  /** Public authority facade used by validated voice camera destinations. */
  runImmediateNavigation(noun, navigate, releaseOptions = undefined) {
    return this._runExplicitNavigation(noun, navigate, releaseOptions);
  }

  /** Supersede deferred work when an owner-specific route handles release. */
  supersedeDeferredNavigation() {
    return this._stampNavigation();
  }

  /** Route a valid vessel/fire request through the shared navigation policy. */
  _runExplicitWorldFocus(detail, fly) {
    return this._runExplicitNavigation(detail?.kind || 'target', fly);
  }

  /** Return the aircraft tracker owned before a multi-step Cockpit transaction. */
  getAircraftTrackingTarget() {
    return aircraftTrackingTarget(this.cockpitView?.readAircraftInfo?.());
  }

  /**
   * On window resize, keep the draggable panel on-screen — a panel positioned near an edge can fall
   * outside a now-smaller viewport (audit U2). pp-toggles is right-pinned, so re-pin (horizontal) and
   * clamp its top. No-op until the panel has been positioned (explicit inline top).
   * @returns {void}
   */
  _reclampDraggablePanels() {
    const el = this._ppToggles;
    if (!el || !el.style.top || el.style.top === 'auto') return;
    const top = parseInt(el.style.top, 10);
    if (!Number.isFinite(top)) return;
    el.style.top = `${this._clampToViewport(0, top, el).top}px`;
    this._pinPanelToRight(el);
  }

  /**
   * Creates one CesiumJS PostProcessStage per visual style and registers
   * it with the scene. Each stage starts with intensity 0 (invisible)
   * so crossfade transitions can animate it in later.
   * @returns {void}
   */
  _initStages() {
    this._visualEffects.initStyles();
  }

  /**
   * Single write path for style-stage intensity: keeps `enabled` in
   * lockstep so zero-intensity stages cost nothing (safe now that the
   * scope is explicit — see _initStages). The stage enables on the same
   * frame the first non-zero intensity lands, so crossfades never pop.
   * @param {Cesium.PostProcessStage} stage - Style post-process stage.
   * @param {number} value - Intensity in [0, 1].
   * @returns {void}
   */
  _setStageIntensity(stage, value) {
    this._visualEffects.setStageIntensity(stage, value);
  }

  /**
   * Re-sync every stage's `enabled` flag from its CURRENT intensity.
   *
   * The cockpit-vision policy helpers (src/cockpitVisionPolicy.js) are pure
   * intensity math — they write `uniforms.intensity` directly and know
   * nothing about the enabled/intensity lockstep _setStageIntensity owns.
   * Without this sweep a stage the policy raised to 1 would stay DISABLED
   * and cockpit NVG/FLIR/CRT would render nothing at all. (Inert while the
   * chain is permanently enabled; load-bearing again once the explicit
   * scope frees the zero-intensity stages — see _initStages.)
   * @returns {void}
   */
  _syncStagesEnabledFromIntensity() {
    this._visualEffects.syncStagesEnabledFromIntensity();
  }

  /**
   * Contacts-scoped detection (owner playtest 2026-08-18: "when you click on
   * Contacts, detections should just turn on, and they should stay on in
   * Cockpit or in third-person tracking inside Contacts").
   *
   * The scope is the CONTACTS SESSION, not Cockpit. Cockpit enter/exit and
   * third-person tracking are moves WITHIN that session and deliberately do not
   * touch detection — an earlier build hooked this to cockpit enter/exit, which
   * is exactly what turned detections off when the owner left the cockpit.
   *
   * Called from `_syncContextModeButtons`, the single funnel every
   * `_contextMode` mutation routes through, and gated on the transaction having
   * SETTLED (`!_contextModeChanging`) so a failed activation can never strand
   * detection on.
   * @returns {void}
   */
  _syncContactsDetection() {
    if (this._contextModeChanging) return;
    const result = applyContactsDetection({
      active: this._contextMode === 'flights',
      restore: this._contactsDetectionRestore,
      // A map style picked DURING the session owns detection on the way out —
      // its auto-enable preset is younger than the entry snapshot.
      styleOwnsDetection: !this._detectionUserOverridden
        && Boolean(STYLE_PRESET_DEFAULTS[this.activeStyle]?.detection),
      // The snapshot must cover everything activation mutates — the preset
      // writes DENSITY as well as mode, so a mode-only snapshot returned
      // OFF @ 25% as OFF @ 75% and the next manual enable came back Dense.
      getState: () => {
        const state = this.getDetectionState();
        return { mode: state.detectionMode, densityPct: state.densityPct };
      },
      // Owner playtest: the force-on lands on the tactical look the military
      // styles apply — the SAME preset object — not on whatever profile the
      // operator last happened to leave detection at.
      applyPreset: () => this._applyDetectionPreset(MILITARY_DETECTION_PRESET),
      // The preset applier IS the state replayer: same density-then-mode order,
      // same slider writes, so a restore round-trips exactly.
      restoreState: (state) => this._applyDetectionPreset(state),
    });
    const hadOwnership = Boolean(this._contactsDetectionRestore);
    this._contactsDetectionRestore = result.restore;
    // Serialization reads that ownership: while Contacts holds it the link
    // carries the SAVED snapshot, and once released it carries live state. The
    // share cache therefore goes stale on any ownership transition, whether or
    // not the detection engine itself moved — and it does not always move.
    // Exiting while a military style owns detection returns changed:false (the
    // style's preset already matches), and returning early there left a copied
    // link claiming the operator's pre-Contacts values while the map showed
    // Dense @ 75%.
    if (!shareCacheNeedsHeal({
      changed: result.changed,
      hadOwnership,
      hasOwnership: Boolean(result.restore),
    })) return;
    if (result.changed) this._syncDetectionUiFromEngine();
    this._syncShareState();
  }

  /** Apply a temporary cockpit-only CRT/NVG/FLIR/NOIR post-process override. */
  _setCockpitVision(mode, active, { revealParameters = false } = {}) {
    const next = active ? normalizeCockpitVisionMode(mode) : 'optical';
    if (!this.stages) return;
    if (!active) {
      if (this._cockpitVisionRestore) {
        for (const [name, intensity] of Object.entries(this._cockpitVisionRestore)) {
          if (this.stages[name]) this._setStageIntensity(this.stages[name], intensity);
        }
      }
      this._cockpitVisionRestore = null;
      this._cockpitVisionMode = 'optical';
      this._syncIrBoost(); // Cockpit exit: fall back to the map preset's IR state
      this._updateSliderPanel(this.activeStyle, { reveal: false });
      this._revealCockpitStyleParameters({ openDisplay: revealParameters });
      return;
    }
    if (!this._cockpitVisionRestore) {
      this._cockpitVisionRestore = captureCockpitVisionBaseline(this.stages, this.transitions);
    }
    if (next === 'optical') {
      applyCockpitVisionStageIntensities(this.stages, next, this._cockpitVisionRestore);
      this._syncStagesEnabledFromIntensity();
      this._cockpitVisionMode = next;
      this._syncIrBoost();
      this._updateSliderPanel(this.activeStyle, { reveal: false });
      this._revealCockpitStyleParameters({ openDisplay: revealParameters });
      return;
    }
    const target = applyCockpitVisionStageIntensities(this.stages, next, this._cockpitVisionRestore);
    this._syncStagesEnabledFromIntensity();
    this._cockpitVisionMode = next;
    this._syncIrBoost(); // Cockpit vision override ('nvg'/'thermal' boost; CRT/NOIR clear)
    this._updateSliderPanel(target || null, { reveal: false });
    this._revealCockpitStyleParameters({ openDisplay: revealParameters });
  }

  /** IR hot-target boost (owner playtest 2026-08-16): under the luminance-
   *  mapped NVG/FLIR looks the 3D fleets flip to flat white so contacts read
   *  HOT instead of vanishing mid-gray; restored when the look exits. The
   *  EFFECTIVE look is Cockpit's vision override while Cockpit is active
   *  ('nvg'/'thermal', which can differ from the map preset in BOTH
   *  directions), otherwise the map preset ('surveillance'/'thermal'). */
  _syncIrBoost() {
    const cockpitMode = this.cockpitView?.active ? this._cockpitVisionMode : null;
    const effective = cockpitMode && cockpitMode !== 'optical' ? cockpitMode : this.activeStyle;
    const irBoost = effective === 'surveillance' || effective === 'thermal' || effective === 'nvg';
    this._dataManager?.setLayerParams('flights', { irBoost });
    this._dataManager?.setLayerParams('military', { irBoost });
    // Fog blends distant geometry toward an effectively-BLACK color in this
    // app (the Cesium globe is hidden), so beyond ~100 km every 3D aircraft
    // fogs to a black silhouette — lighting and shaders can't reach past it
    // (owner cockpit-FLIR field rounds, 2026-08-16). IR sensors see through
    // haze, so the boost styles simply turn fog off; the prior state restores
    // on exit. Transition-guarded so repeated syncs don't clobber the saved value.
    const scene = this.viewer?.scene;
    if (scene?.fog && irBoost !== this._irBoostActive) {
      this._irBoostActive = irBoost;
      if (irBoost) {
        this._irFogWasEnabled = scene.fog.enabled;
        scene.fog.enabled = false;
      } else if (this._irFogWasEnabled != null) {
        scene.fog.enabled = this._irFogWasEnabled;
        this._irFogWasEnabled = null;
      }
      scene.requestRender?.();
    }
  }

  /** Keep Cockpit's inherited label and restore target aligned with the active map preset. */
  _syncCockpitInheritedStyle() {
    if (!this.cockpitView?.active || !this.stages) return;
    this._cockpitVisionRestore = Object.fromEntries(
      Object.keys(this.stages).map((name) => [name, name === this.activeStyle ? 1 : 0]),
    );
    for (const name of Object.keys(this.stages)) this.transitions.delete(name);
    this.cockpitView.setVisionMode(this.cockpitView.visionMode);
  }

  /** Reveal shared style parameters, optionally opening Cockpit Display first. */
  _revealCockpitStyleParameters({ openDisplay = false } = {}) {
    if (!this.cockpitView?.active || !this._sliderPanel?.classList.contains('active')) return;
    if (openDisplay && this._cockpitDisplayToggleBtn?.getAttribute('aria-expanded') !== 'true') {
      this._setCockpitDisclosure?.('display', true);
      return;
    }
    if (this._cockpitDisplayToggleBtn?.getAttribute('aria-expanded') !== 'true') return;
    this._sliderPanel.classList.remove('collapsed');
    this._syncPanelCollapseButton(this._sliderPanel);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      this._sliderPanel?.scrollIntoView?.({ block: 'nearest' });
    }));
  }

  /**
   * Configures Cesium's built-in bloom stage and adds a custom unsharp-mask
   * sharpen stage to the post-process pipeline. Both start disabled.
   * @returns {void}
   */
  _initBloomSharpen() {
    this._visualEffects.initPostProcess(this._sharpenSlider ? parseInt(this._sharpenSlider.value, 10) / 100 : 0.6);
  }

  /**
   * Reads the current bloom intensity percentage from the effects controller.
   * @returns {number} Clamped bloom intensity (0-200).
   */
  _getBloomIntensity() {
    return this._visualEffects.bloomIntensity;
  }

  /**
   * Enables or disables the Cesium bloom stage based on both the user toggle
   * and whether the computed strength exceeds the perceptual threshold (0.06).
   * @returns {void}
   */
  _syncBloomStageEnabled() {
    this._visualEffects.syncBloomEnabled();
  }

  /**
   * Sets the bloom intensity, updates the slider UI, and applies the value.
   * @param {number} intensity - Raw intensity percentage.
   * @param {object} [options]
   * @param {boolean} [options.syncShare=true] - Whether to push state to the share link.
   * @returns {void}
   */
  _setBloomIntensity(intensity, { syncShare = true } = {}) {
    governorRequestRender('bloom');
    const clamped = clampBloomIntensity(intensity);
    if (this._bloomSlider) this._bloomSlider.value = String(clamped);
    if (this._bloomSliderValue) this._bloomSliderValue.textContent = `${clamped}%`;
    this._applyBloomIntensity(clamped);
    if (syncShare) this._syncShareState();
  }

  /**
   * Maps a bloom intensity percentage to Cesium bloom stage uniforms.
   * Uses smoothstep easing (Hermite interpolation: 3t^2 - 2t^3) to
   * produce a perceptually linear glow ramp from zero to full strength.
   * @param {number} intensity - Bloom intensity percentage (0-200).
   * @returns {void}
   */
  _applyBloomIntensity(intensity) {
    this._visualEffects.applyBloomIntensity(intensity);
  }

  /**
   * Toggles bloom on/off, syncs button state, and reveals/hides the intensity slider row.
   * @param {boolean} enabled - Whether bloom should be active.
   * @returns {void}
   */
  _setBloomEnabled(enabled) {
    governorRequestRender('bloom');
    this._visualEffects.setBloomEnabled(enabled);
    this._syncBloomStageEnabled();
    this._bloomBtn.classList.toggle('active', this.bloomEnabled);
    this._bloomSliderRow.classList.toggle('visible', this.bloomEnabled);
    if (this.bloomEnabled) {
      this._applyBloomIntensity(this._getBloomIntensity());
    }
    this._syncShareState();
    this._layoutRightPanels();
  }

  /**
   * Maps a normalized sharpen value (0-1) to the unsharp-mask `amount` uniform.
   * Range: 0.1 (subtle) to 2.1 (aggressive edge enhancement).
   * @param {number} val - Normalized sharpen intensity (0.0 to 1.0).
   * @returns {void}
   */
  _applySharpenIntensity(val) {
    this._visualEffects.applySharpenIntensity(val);
  }

  /**
   * Toggles sharpening on/off, syncs button state, and reveals/hides the intensity slider row.
   * @param {boolean} enabled - Whether sharpening should be active.
   * @returns {void}
   */
  _setSharpenEnabled(enabled) {
    governorRequestRender('sharpen');
    this._visualEffects.setSharpenEnabled(enabled);
    this._sharpenBtn.classList.toggle('active', this.sharpenEnabled);
    if (this._sharpenSliderRow) {
      this._sharpenSliderRow.classList.toggle('visible', this.sharpenEnabled);
    }
    if (this.sharpenEnabled && this._sharpenSlider) {
      this._applySharpenIntensity(parseInt(this._sharpenSlider.value, 10) / 100);
    }
    this._syncShareState();
    this._layoutRightPanels();
  }

  /**
   * Wires up all primary UI event listeners: style buttons, keyboard shortcuts
   * (1-8 style keys, H/O/V/F/D/C hotkeys, Escape), AI prompt input with
   * debounce, bloom/sharpen/HUD toggles, detection density slider, and
   * clean-view toggle.
   * @returns {void}
   */
  _initUI() {
    this._applicationShortcuts?.destroy();
    this._applicationShortcuts = bindApplicationShortcuts({
      documentRef: document,
      searchInput: this._locationSearch,
      actions: {
        setStyle: (style) => this.setStyle(style),
        dismissSearch: () => {
          if (this._locationSearch.classList.contains('expanded')) {
            this._locationSearch.classList.remove('expanded');
            this._locationSearch.value = '';
            this._locationSearch.blur();
          }
        },
        toggleHud: () => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          this.hud.toggle();
          this._updateHudButtonState();
          this._syncShareState();
        },
        toggleOrbit: () => this._toggleOrbit(),
        toggleCleanView: () => this.toggleCleanView(),
        toggleLayers: () => document.getElementById('data-panel').classList.toggle('active'),
        cycleDetection: () => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          this._detectionUserOverridden = true;
          cycleDetectionMode();
          this._syncShareState();
        },
        toggleCctv: () => this._toggleCctvEnabled(),
      },
    });

    this._displayControls?.destroy();
    this._displayControls = bindDisplayControls({
      elements: {
        styleButtons: document.querySelectorAll('.style-btn'),
        bloomButton: this._bloomBtn, bloomSlider: this._bloomSlider,
        sharpenButton: this._sharpenBtn, sharpenSlider: this._sharpenSlider,
        scopeButton: this._scopeBtn, scopeFeatherSlider: this._scopeFeatherSlider,
        hudLayout: this._hudLayoutSelect, hudButton: this._hudBtn,
        cleanViewButton: this._cleanViewBtn, cleanViewExitButton: this._cleanViewExitBtn,
        densitySlider: this._detectionDensitySlider, detectionButton: this._detectionBtn,
        allocationButtons: this._detectionAllocationBtns,
        fadeSliders: [this._detectionFadeSlider, this._detectionOpacitySlider],
        celestialButton: this._celestialBtn,
        modelsButton: this._models3dBtn,
        modelModeButtons: this._models3dBtn ? this._models3dModeBtns : [],
      },
      actions: {
        setStyle: (style) => this.setStyle(style),
        toggleBloom: () => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          this._setBloomEnabled(!this.bloomEnabled);
        },
        setBloomIntensity: (value) => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          this._setBloomIntensity(value);
        },
        toggleSharpen: () => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          this._setSharpenEnabled(!this.sharpenEnabled);
        },
        toggleScope: () => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          const next = !isScopeMaskEnabled();
          setScopeMaskEnabled(next);
          this._scopeBtn.classList.toggle('active', next);
          this._scopeBtn.setAttribute('aria-pressed', String(next));
          this._syncShareState();
        },
        setScopeFeather: (value) => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          const pct = Math.max(0, Math.min(100, value || 0));
          if (this._scopeFeatherValue) this._scopeFeatherValue.textContent = `${pct}%`;
          setScopeMaskFeather(pct / 100);
          this._syncShareState();
        },
        setSharpenIntensity: (pct) => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          if (this._sharpenSliderValue) this._sharpenSliderValue.textContent = `${pct}%`;
          this._applySharpenIntensity(pct / 100);
          this._syncShareState();
        },
        setHudLayout: (value) => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          this._setHudVariant(value);
        },
        toggleCleanView: () => this.toggleCleanView(),
        exitCleanView: () => this.toggleCleanView(false),
        setDensity: (value) => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          this._detectionUserOverridden = true;
          const pct = canonicalizeDensity(value);
          this._detectionDensitySlider.value = String(pct);
          if (this._detectionDensityValue) this._detectionDensityValue.textContent = `${pct}%`;
          this._applyDetectionDensityFromUi();
          this._syncShareState();
        },
        setAllocation: (value) => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          this._detectionUserOverridden = true;
          this._setDetectionAllocation(value);
        },
        setFade: () => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          this._applyDetectionFadeFromUi();
          this._syncShareState();
        },
        toggleCelestial: () => {
          const ringIsVisible = !!this.celestialRing?.visible;
          if (!this.celestialRingEnabled || !ringIsVisible) {
            this.setCelestialRingEnabled(true, { focus: true });
          } else {
            this.setCelestialRingEnabled(false);
          }
        },
        toggleHud: () => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          this.hud.toggle();
          this._updateHudButtonState();
          this._syncShareState();
        },
        cycleDetection: () => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          this._detectionUserOverridden = true;
          cycleDetectionMode();
          this._syncShareState();
        },
        toggleModels: () => {
          this._setModels3dEnabled(!this._models3dEnabled);
          this._syncModels3dModeRow();
        },
        setModelsMode: (mode) => this._setModels3dMode(mode),
      },
    });
  }

  /**
   * Renders the owner-approved map stack chip row from the matching controller
   * entries. Cesium ion/Bing chips remain keyboard-focusable but unavailable,
   * with an accessible explanation, until a CESIUM_ION_TOKEN is configured.
   * @returns {void}
   */
  _initMapStackControl() {
    if (!this.mapStackController) return;
    this._mapSourceControls?.destroy();
    this._mapSourceControls = createMapSourceControls({
      container: this._mapStackChips,
      statusElement: this._mapStackStatus,
      controller: this.mapStackController,
      subscribe: (onChange) => {
        window.addEventListener('gev:map-stack-changed', onChange);
        return () => window.removeEventListener('gev:map-stack-changed', onChange);
      },
      claimSelection: () => this.shareLinkManager?.claimRestoreLane?.('map'),
      onStateChanged: () => this._syncShareState(),
      onError: (message) => this._showToast(message),
    });
  }

  /**
   * Switches the active map/globe source stack.
   * @param {string} stackId - Map stack id.
   * @param {object} [options]
   * @param {boolean} [options.syncShare=true] - Whether to update the share link.
   * @returns {Promise<void>}
   */
  async _setMapStack(stackId, { syncShare = true } = {}) {
    if (!this.mapStackController) return;
    return this._mapSourceControls.select(stackId, { syncShare });
  }

  /**
   * Syncs the map stack chip row and status chip with controller state. The
   * lit chip always follows `state.activeId`, never the click — a rejected or
   * superseded switch therefore leaves the genuinely active stack lit.
   * @param {object} state - Map stack controller state.
   * @returns {void}
   */
  _renderMapStackState(state) {
    this._mapSourceControls?.render(state);
  }

  /**
   * Reads and canonicalizes the five-stop density control. The engine derives
   * Sparse/Balanced/Dense from the same stop.
   * @returns {void}
   */
  _applyDetectionDensityFromUi() {
    if (!this._detectionDensitySlider) return;
    const pct = canonicalizeDensity(this._detectionDensitySlider.value);
    this._detectionDensitySlider.value = String(pct);
    if (this._detectionDensityValue) this._detectionDensityValue.textContent = `${pct}%`;
    setDetectionTuning({ densityPct: pct });
    this._updateDetectionButton(getDetectionMode());
  }

  /** Apply responsive keyhole fade controls from normalized UI percentages. */
  _applyDetectionFadeFromUi() {
    const fadePct = Math.max(0, Math.min(40, Math.round(Number(this._detectionFadeSlider?.value) || 0)));
    const outsideOpacityValue = this._detectionOpacitySlider?.value;
    const outsideOpacityPct = Math.max(
      0,
      Math.min(100, Math.round(outsideOpacityValue == null ? 3 : Number(outsideOpacityValue) || 0)),
    );
    if (this._detectionFadeSlider) this._detectionFadeSlider.value = String(fadePct);
    if (this._detectionFadeValue) this._detectionFadeValue.textContent = `${fadePct}%`;
    if (this._detectionOpacitySlider) this._detectionOpacitySlider.value = String(outsideOpacityPct);
    if (this._detectionOpacityValue) this._detectionOpacityValue.textContent = `${outsideOpacityPct}%`;
    setKeyholeFadeTuning({
      fadeRatio: fadePct / 100,
      outsideOpacity: outsideOpacityPct / 100,
    });
    this.viewer.scene.requestRender?.();
  }

  _setDetectionAllocation(strategy, { syncShare = true, persist = true } = {}) {
    const raw = String(strategy || '').trim().toUpperCase();
    if (!ALLOCATION_STRATEGIES.includes(raw)) return false;
    const normalized = normalizeAllocationStrategy(raw);
    this._detectionAllocationPreference = normalized;
    setDetectionTuning({ allocationStrategy: normalized });
    for (const button of this._detectionAllocationBtns) {
      const active = button.dataset.allocation === normalized;
      button.classList.toggle('active', active);
      button.setAttribute('aria-checked', String(active));
    }
    if (persist) {
      try { localStorage.setItem(DETECTION_ALLOCATION_STORAGE_KEY, normalized); } catch { /* best effort */ }
    }
    if (syncShare) this._syncShareState();
    return true;
  }

  _syncDetectionUiFromEngine() {
    const tuning = getDetectionTuning();
    if (this._detectionDensitySlider) this._detectionDensitySlider.value = String(tuning.densityPct);
    if (this._detectionDensityValue) this._detectionDensityValue.textContent = `${tuning.densityPct}%`;
    this._setDetectionAllocation(tuning.allocationStrategy, { syncShare: false, persist: false });
    const fadeTuning = getKeyholeFadeTuning();
    if (this._detectionFadeSlider) this._detectionFadeSlider.value = String(Math.round(fadeTuning.fadeRatio * 100));
    if (this._detectionOpacitySlider) {
      this._detectionOpacitySlider.value = String(Math.round(fadeTuning.outsideOpacity * 100));
    }
    this._applyDetectionFadeFromUi();
    this._updateDetectionButton(getDetectionMode());
  }

  /**
   * Activates a detection overlay mode by label (e.g. 'OFF', 'SPARSE', 'PANOPTIC').
   * @param {string} modeLabel - Detection mode label to set.
   * @returns {void}
   */
  _setDetectionMode(modeLabel) {
    if (!modeLabel) return;
    setDetectionModeByLabel(modeLabel);
    this._syncDetectionUiFromEngine();
    this._syncShareState();
  }

  /**
   * Switches the HUD layout variant (e.g. 'tactical', 'minimal') and syncs
   * the layout dropdown if present.
   * @param {string} variantName - HUD variant identifier.
   * @returns {void}
   */
  _setHudVariant(variantName) {
    if (!variantName) return;
    this.hud.setVariant(variantName);
    if (this._hudLayoutSelect && this._hudLayoutSelect.value !== this.hud.getVariant()) {
      this._hudLayoutSelect.value = this.hud.getVariant();
    }
    this._syncShareState();
    this._scheduleAdaptivePanelLayout({ settle: true });
  }

  /**
   * Keeps both responsive panel lanes and Cockpit's utility strip on the same
   * measured layout commit. HUD visibility transitions can outlive the first
   * animation frame, so variant changes receive one bounded settling pass.
   * @param {{settle?: boolean}} [options] Whether to remeasure after transitions.
   * @returns {void}
   */
  _scheduleAdaptivePanelLayout({ settle = false } = {}) {
    this._scheduleLeftPanelLayout({ reconsiderAutoCollapse: true });
    this._scheduleRightPanelLayout({ reconsiderAutoCollapse: true });
    this.cockpitView?.scheduleContextLayout();
    if (!settle) return;
    clearTimeout(this._adaptivePanelSettleTimer);
    this._adaptivePanelSettleTimer = setTimeout(() => {
      this._adaptivePanelSettleTimer = null;
      this._scheduleLeftPanelLayout({ reconsiderAutoCollapse: true });
      this._scheduleRightPanelLayout({ reconsiderAutoCollapse: true });
      this.cockpitView?.scheduleContextLayout();
    }, COCKPIT_LAYOUT_SETTLE_MS);
  }

  /**
   * Applies preset defaults (bloom, sharpen, shader uniforms, HUD variant)
   * when a military-class style (CRT, NVG, FLIR) is selected. Does nothing
   * for styles without entries in STYLE_PRESET_DEFAULTS.
   * @param {string} styleName - The style whose defaults to apply.
   * @returns {void}
   */
  _applyStylePresetDefaults(styleName) {
    const preset = STYLE_PRESET_DEFAULTS[styleName];
    if (!preset) return;

    if (preset.styleParams && typeof preset.styleParams === 'object') {
      for (const [targetStyle, params] of Object.entries(preset.styleParams)) {
        const stage = this.stages[targetStyle];
        if (!stage || !params || typeof params !== 'object') continue;
        for (const [uniformName, uniformValue] of Object.entries(params)) {
          if (stage.uniforms[uniformName] === undefined) continue;
          stage.uniforms[uniformName] = uniformValue;
          governorRequestRender('style-param');
        }
      }
    }

    const bloomInput = preset.bloom || {};
    if (typeof bloomInput.intensity === 'number' && this._bloomSlider) {
      this._setBloomIntensity(clampBloomIntensity(bloomInput.intensity), { syncShare: false });
    }
    if (typeof bloomInput.enabled === 'boolean') {
      this._setBloomEnabled(bloomInput.enabled);
    }

    const sharpenInput = preset.sharpen || {};
    if (typeof sharpenInput.intensity === 'number' && this._sharpenSlider) {
      const sharpenPct = Math.max(0, Math.min(100, Math.round(sharpenInput.intensity)));
      this._sharpenSlider.value = String(sharpenPct);
      this._sharpenSliderValue.textContent = `${sharpenPct}%`;
      this._applySharpenIntensity(sharpenPct / 100);
    }
    if (typeof sharpenInput.enabled === 'boolean') {
      this._setSharpenEnabled(sharpenInput.enabled);
    }

    if (preset.hudVariant) {
      this._setHudVariant(preset.hudVariant);
    }
    if (typeof preset.hudVisible === 'boolean') {
      this.hud.setMode(preset.hudVisible ? 'on' : 'off');
      this._updateHudButtonState();
    }

    // A style may set a detection default (e.g. military styles -> Dense for
    // the "epic" default view), but ONLY if the user hasn't manually changed
    // detection this session. Detection is user-controlled and persists across
    // style switches, so an explicit Sparse/Off choice is never stomped.
    if (preset.detection && !this._detectionUserOverridden) {
      this._applyDetectionPreset(preset.detection);
    }
  }

  /**
   * Apply a detection preset's density and mode through the real UI path.
   *
   * Deliberately does NOT consult `_detectionUserOverridden` — the CALLER owns
   * that decision. The style path checks it (an explicit Sparse/Off must
   * survive a style switch); Cockpit entry does not (owner: detection is on in
   * the cockpit "regardless").
   * @param {{mode?: string, densityPct?: number}} det Preset detection config.
   * @returns {void}
   */
  _applyDetectionPreset(det) {
    if (!det) return;
    if (typeof det.densityPct === 'number' && this._detectionDensitySlider) {
      const pct = canonicalizeDensity(det.densityPct);
      this._detectionDensitySlider.value = String(pct);
      if (this._detectionDensityValue) this._detectionDensityValue.textContent = `${pct}%`;
      this._applyDetectionDensityFromUi();
    }
    if (det.mode) this._setDetectionMode(String(det.mode).toUpperCase());
  }

  /**
   * Applies the global post-processing baseline (GLOBAL_POST_DEFAULTS) at
   * startup before any share-link restore runs. Sets bloom, sharpen, HUD,
   * and detection to their factory defaults.
   * @returns {void}
   */
  _applyGlobalPostDefaults() {
    const defaults = GLOBAL_POST_DEFAULTS;
    if (typeof defaults.bloom?.intensity === 'number' && this._bloomSlider) {
      this._setBloomIntensity(clampBloomIntensity(defaults.bloom.intensity), { syncShare: false });
    }
    if (typeof defaults.bloom?.enabled === 'boolean') {
      this._setBloomEnabled(defaults.bloom.enabled);
    }

    if (typeof defaults.sharpen?.intensity === 'number' && this._sharpenSlider) {
      const sharpenPct = Math.max(0, Math.min(100, Math.round(defaults.sharpen.intensity)));
      this._sharpenSlider.value = String(sharpenPct);
      this._sharpenSliderValue.textContent = `${sharpenPct}%`;
      this._applySharpenIntensity(sharpenPct / 100);
    }
    if (typeof defaults.sharpen?.enabled === 'boolean') {
      this._setSharpenEnabled(defaults.sharpen.enabled);
    }

    if (defaults.hudVariant) {
      this._setHudVariant(defaults.hudVariant);
    }
    if (typeof defaults.hudVisible === 'boolean') {
      this.hud.setMode(defaults.hudVisible ? 'on' : 'off');
      this._updateHudButtonState();
    }

    if (defaults.detectionMode) {
      this._setDetectionMode(defaults.detectionMode);
    }
    if (typeof defaults.detectionDensity === 'number' && this._detectionDensitySlider) {
      const density = canonicalizeDensity(defaults.detectionDensity);
      this._detectionDensitySlider.value = String(density);
      this._detectionDensityValue.textContent = `${density}%`;
      this._applyDetectionDensityFromUi();
    }
    this._setDetectionAllocation(
      this._detectionAllocationPreference || defaults.detectionAllocation || 'ELASTIC',
      { syncShare: false, persist: false },
    );
    if (this._detectionFadeSlider) {
      this._detectionFadeSlider.value = String(defaults.detectionFadePct ?? 7);
    }
    if (this._detectionOpacitySlider) {
      this._detectionOpacitySlider.value = String(defaults.detectionOutsideOpacityPct ?? 1);
    }
    this._applyDetectionFadeFromUi();
    if (typeof defaults.celestialRing === 'boolean') {
      this.setCelestialRingEnabled(defaults.celestialRing, { syncShare: false, focus: false });
    }
  }

  /**
   * Pushes the current visual state (bloom, sharpen, HUD, detection) to
   * the ShareLinkManager so the URL hash stays in sync.
   * @returns {void}
   */
  /**
   * Detection as a DURABLE preference, for serialization into a share link.
   *
   * While Contacts is active it OWNS detection and forces Dense @ 75%. That is
   * a session-scoped override, not something the operator chose: it is undone
   * verbatim on deactivation. Serializing the forced values shipped a link that
   * pinned Dense @ 75% on the recipient — as a durable preference, with no
   * Contacts mode present to explain or undo it — even though the author's own
   * setting was (say) OFF @ 50%. Publish what deactivation would restore.
   *
   * `_contactsDetectionRestore` is exactly that snapshot and is null whenever
   * Contacts does not own detection, so the live values are used normally.
   */
  _shareableDetectionState() {
    return shareableDetectionState({
      owned: this._contactsDetectionRestore,
      liveMode: getDetectionMode(),
      liveDensityPct: parseInt(this._detectionDensitySlider?.value || '50', 10),
    });
  }

  _syncShareState() {
    const detection = this._shareableDetectionState();
    this.shareLinkManager.onToggleChange(this.bloomEnabled, this.sharpenEnabled, {
      bloomIntensity: this._getBloomIntensity(),
      bloomVersion: BLOOM_SCALE_VERSION,
      sharpenIntensity: parseInt(this._sharpenSlider?.value || '49', 10),
      hudVariant: this.hud.getVariant(),
      hudVisible: this.hud.visible,
      detectionMode: detection.mode,
      detectionDensity: detection.densityPct,
      detectionAllocation: getDetectionTuning().allocationStrategy,
      detectionFadePct: parseInt(this._detectionFadeSlider?.value || '7', 10),
      detectionOutsideOpacityPct: parseInt(this._detectionOpacitySlider?.value || '1', 10),
      celestialRingEnabled: this.celestialRingEnabled,
      scopeEnabled: isScopeMaskEnabled(),
      scopeFeatherPct: Math.round(getScopeMaskFeather() * 100),
      // null when adaptive — the share layer omits `sce` entirely in that case.
      scopeTerminusPct: getScopeTerminusOverride() == null
        ? null
        : Math.round(getScopeTerminusOverride() * 100),
      mapStack: this.mapStackController?.getActiveId?.() || 'photoreal',
    });
  }

  /**
   * Updates the traffic sync status chip with loading phase label and progress.
   * Auto-hides after 1.5s when loading completes; stays visible while busy.
   * @param {boolean} [forceShow=false] - Force the chip visible regardless of busy state.
   * @returns {void}
   */
  _updateTrafficSyncChip(forceShow = false, now = performance.now()) {
    if (!this._trafficSyncChip || !this._trafficSyncLabel || !this._trafficSyncProgress) return;
    const layers = this._dataManager?.getAll?.();
    const traffic = Array.isArray(layers) ? layers.find((layer) => layer.id === 'traffic') : null;
    this._trafficSyncFeedbackState = reduceTrafficSyncFeedback(
      this._trafficSyncFeedbackState,
      { enabled: traffic?.enabled === true, stats: traffic?.stats || {}, forceShow },
      now,
    );
    const presentation = this._trafficSyncFeedbackState;
    // setSplitFlapText carries the same unchanged-text guard internally, and
    // the flap keeps textContent equal to the settled label throughout, so
    // this stays a no-op on the repeat ticks exactly as it did before.
    if (presentation.label) setSplitFlapText(this._trafficSyncLabel, presentation.label);
    // Written on every change INCLUDING the empty settled value — the reducer
    // clears the progress number once the sync lands, and a truthiness guard
    // here would strand the last "..." beside the settled label.
    if (this._trafficSyncProgress.textContent !== presentation.progressText) {
      this._trafficSyncProgress.textContent = presentation.progressText;
    }
    this._trafficSyncChip.classList.toggle('visible', presentation.visible);
  }

  /**
   * Initializes panel collapse buttons and restores persisted collapsed state.
   * Also sets up hover-expand behavior for the style presets and location bar panels.
   * @returns {void}
   */
  _initPanelChrome() {
    for (const control of this._panelDisclosureControls || []) control.destroy();
    this._panelDisclosureControls = [];
    const targets = new Map();
    document.querySelectorAll('.panel-collapse-btn[data-collapse-target]').forEach((button) => {
      const targetId = button.dataset.collapseTarget;
      if (!targetId) return;
      if (!targets.has(targetId)) targets.set(targetId, []);
      targets.get(targetId).push(button);
    });
    for (const [targetId, buttons] of targets) {
      const panel = document.getElementById(targetId);
      if (!panel) continue;
      this._panelDisclosureControls.push(bindPanelDisclosure({
        panel,
        buttons,
        onChange: (collapsed, options) => this.setPanelCollapsed(targetId, collapsed, options),
        onEscape: (event) => this._collapsePanelOnEscape(event, targetId),
      }));
      this._restorePanelCollapsedState(targetId, {
        allowStored: !this._initialShareState,
      });
    }
    // The command dock always starts compact; either wing reveals on hover,
    // focus, or click and collapses again after the interaction moves away.
    this.setPanelCollapsed('control-panel', true, { syncShare: false, persist: false });
    this.setPanelCollapsed('location-bar', true, { syncShare: false, persist: false });
    this._initAutoHoverPanel('control-panel', { openDelayMs: 140, closeDelayMs: 420 });
    this._initAutoHoverPanel('location-bar', { openDelayMs: 140, closeDelayMs: 420 });
    this._initCommandDockPins();
    this._initCommandDockTrayMetrics();
    this._maybeNotifyLayoutReset();
  }

  /**
   * Collapses the nearest expanded panel that owns keyboard focus on Escape.
   * Nested panels consume the event first, so one key closes one level and
   * returns focus to that level's disclosure. If Escape was pressed on the
   * disclosure itself, remove focus after closing so the collapsed button does
   * not keep a stale keyboard ring.
   * @param {KeyboardEvent} event - Candidate Escape key event.
   * @param {string} panelId - Collapsible panel containing the listener.
   * @returns {boolean} Whether this panel handled the key.
   */
  _collapsePanelOnEscape(event, panelId) {
    return collapsePanelOnEscape(event, {
      panel: document.getElementById(panelId),
      onChange: (collapsed, options) => this.setPanelCollapsed(panelId, collapsed, options),
      beforeCollapse: () => {
        if (panelId !== 'location-bar' || !this._locationSearch) return;
        this._locationSearch.classList.remove('expanded');
        this._locationSearch.value = '';
        this._locationSearch.blur();
      },
    });
  }

  /**
   * Allows either command-dock tray to remain open until explicitly unpinned.
   * Both trays may be pinned; transient and error trays stack above them.
   * @returns {void}
   */
  _initCommandDockPins() {
    document.querySelectorAll('.dock-pin-btn[data-pin-target]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const panelId = button.dataset.pinTarget;
        this._setCommandDockPanelPinState(panelId);
      });
    });
  }

  _setCommandDockPanelPinState(panelId, pin, {
    restore = false,
    persist = true,
    syncShare = true,
  } = {}) {
    const panelEl = document.getElementById(panelId);
    const button = document.querySelector(`.dock-pin-btn[data-pin-target="${panelId}"]`);
    if (!panelEl || !button) return undefined;
    const shouldPin = typeof pin === 'boolean'
      ? pin
      : !panelEl.classList.contains('dock-pinned');
    panelEl.classList.toggle('dock-pinned', shouldPin);
    button.setAttribute('aria-pressed', String(shouldPin));
    document.querySelectorAll('#command-dock .dock-pinned-top').forEach((pinnedPanel) => {
      pinnedPanel.classList.remove('dock-pinned-top');
    });
    if (shouldPin) {
      panelEl.classList.add('dock-pinned-top');
      this.setPanelCollapsed(panelId, false, {
        explicit: !restore,
        restore,
        persist,
        syncShare: false,
      });
    } else {
      const remainingPinnedPanel = document.querySelector('#command-dock .dock-pinned');
      remainingPinnedPanel?.classList.add('dock-pinned-top');
      if (!restore && !panelEl.matches(':hover')) {
        this.setPanelCollapsed(panelId, true, {
          explicit: true,
          persist,
          syncShare: false,
        });
      }
    }
    this._updateCommandDockTrayStack();
    if (syncShare) {
      if (!restore) this.shareLinkManager?.claimRestoreLane?.('panel', panelId);
      this.shareLinkManager?.onPanelStateChange?.();
    }
    return shouldPin;
  }

  /**
   * Tracks the live pinned-tray height so a hovered sibling can stack above it
   * without hardcoded content dimensions.
   * @returns {void}
   */
  _initCommandDockTrayMetrics() {
    const dock = document.getElementById('command-dock');
    if (!dock) return;
    this._commandDockTrayObserver?.disconnect?.();
    if (typeof ResizeObserver === 'function') {
      this._commandDockTrayObserver = new ResizeObserver(() => this._updateCommandDockTrayStack());
      dock.querySelectorAll('.dock-popover-content').forEach((tray) => {
        this._commandDockTrayObserver.observe(tray);
      });
    }
    this._updateCommandDockTrayStack();
  }

  /**
   * Writes each pinned tray height and their combined stack height as CSS
   * variables. The most recently pinned tray forms the upper level.
   * @returns {void}
   */
  _updateCommandDockTrayStack() {
    const dock = document.getElementById('command-dock');
    if (!dock) return;
    const locationPanel = dock.querySelector('#location-bar.dock-pinned:not(.collapsed)');
    const presetsPanel = dock.querySelector('#control-panel.dock-pinned:not(.collapsed)');
    const locationHeight = locationPanel?.querySelector('.dock-popover-content')?.getBoundingClientRect().height || 0;
    const presetsHeight = presetsPanel?.querySelector('.dock-popover-content')?.getBoundingClientRect().height || 0;
    const pinnedCount = Number(locationHeight > 0) + Number(presetsHeight > 0);
    const locationHeightPx = Math.ceil(locationHeight);
    const presetsHeightPx = Math.ceil(presetsHeight);
    const topPinnedPanel = dock.querySelector('.dock-pinned-top.dock-pinned:not(.collapsed)');
    const lowerPinnedPanel = topPinnedPanel?.id === 'location-bar' ? presetsPanel : locationPanel;
    const lowerPinnedHeight = lowerPinnedPanel
      ?.querySelector('.dock-popover-content')
      ?.getBoundingClientRect().height || 0;
    const stackHeight = pinnedCount > 1
      ? `calc(${locationHeightPx}px + ${presetsHeightPx}px + 1.2rem)`
      : `${locationHeightPx + presetsHeightPx}px`;
    dock.style.setProperty('--dock-location-pinned-height', `${locationHeightPx}px`);
    dock.style.setProperty('--dock-presets-pinned-height', `${presetsHeightPx}px`);
    dock.style.setProperty('--dock-lower-pinned-height', `${Math.ceil(lowerPinnedHeight)}px`);
    dock.style.setProperty('--dock-pinned-stack-height', stackHeight);
    dock.classList.toggle('dock-has-pinned-tray', pinnedCount > 0);
    dock.classList.toggle('dock-has-two-pinned-trays', pinnedCount > 1);
  }

  /**
   * One-time toast when stored v6 panel positions are superseded by the v7
   * layout defaults (positions reset; collapsed states are preserved).
   * @returns {void}
   */
  _maybeNotifyLayoutReset() {
    try {
      const marker = `godsEyeView.${PANEL_POSITION_STORAGE_VERSION}.layoutResetNotified`;
      if (localStorage.getItem(marker)) return;
      localStorage.setItem(marker, '1');
      const hadOldPositions = Object.keys(localStorage)
        .some((key) => key.startsWith('godsEyeView.v6.panelPos.'));
      if (hadOldPositions) {
        this._showToast('Panel layout updated — positions reset to new defaults');
      }
    } catch {
      // storage unavailable
    }
  }

  /**
   * Configures intentional hover-expand / leave-collapse behavior on a panel.
   * Uses separate open/close timers to prevent accidental flicker from fast
   * mouse passes. Wheel events cancel pending opens to avoid surprise expansion
   * during scroll-through.
   * @param {string} panelId - DOM id of the panel element.
   * @param {object} [options]
   * @param {number} [options.openDelayMs=850] - Hover dwell time before auto-expanding.
   * @param {number} [options.closeDelayMs=1000] - Delay after pointer leaves before collapsing.
   * @returns {void}
   */
  _initAutoHoverPanel(panelId, { openDelayMs = 850, closeDelayMs = 1000 } = {}) {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    this._hoverPanelControls ??= new Map();
    this._hoverPanelControls.get(panelId)?.destroy();
    const controller = createHoverDisclosure({
      panel,
      documentRef: document,
      disclosure: panel.querySelector(`[data-dock-toggle-target="${panelId}"]`),
      openDelayMs,
      closeDelayMs,
      isActive: () => !this._disposed,
      onChange: (collapsed, options) => this.setPanelCollapsed(panelId, collapsed, options),
      onEscape: (event) => this._collapsePanelOnEscape(event, panelId),
      focusTarget: panelId === 'control-panel' ? () => (
        panel.querySelector('.map-stack-chip.active') || panel.querySelector('.map-stack-chip')
      ) : null,
    });
    this._hoverPanelControls.set(panelId, controller);
    if (panelId === 'control-panel') {
      this._cancelMapSourceFocus?.();
      this._cancelMapSourceFocus = controller.cancelPendingFocus;
    }
  }

  /**
   * Sets up drag-to-reposition for legacy floating controls. The right rail
   * and left accordion remain fixed so their HUD alignment is deterministic.
   * @returns {void}
   */
  _initPanelDrag() {
    const dragSpecs = [
      {
        id: 'pp-toggles',
        panel: this._ppToggles,
        handle: this._ppToggles?.querySelector('.panel-drag-handle.compact'),
      },
    ].filter(Boolean);

    for (const spec of dragSpecs) {
      if (!spec.panel || !spec.handle) continue;
      this._restorePanelPosition(spec.id, spec.panel);
      this._makePanelDraggable(spec.id, spec.panel, spec.handle);
    }
    // Keep a positioned panel on-screen when its HEIGHT changes after restore — it expands to its
    // full row set a frame or two later, so the restore-time clamp used a stale (shorter) height and
    // the panel could still hang off the bottom (audit U2). Re-clamp on every size change.
    if (this._ppToggles && typeof ResizeObserver !== 'undefined') {
      this._draggableResizeObserver = new ResizeObserver(() => this._reclampDraggablePanels());
      this._draggableResizeObserver.observe(this._ppToggles);
    }
  }

  _persistAwarenessSelection(event, cleared = false) {
    if (!this._dataManager) return;
    const origin = String(event?.detail?.origin || 'programmatic');
    if (!isExplicitLayerStateOrigin(origin)) return;
    const layerId = String(event?.detail?.layerId || '');
    const config = {
      flights: {
        key: 'selectedFlightsTrackingId',
        normalize: (value) => String(value ?? '').trim().toLowerCase() || null,
      },
      military: {
        key: 'selectedMilitaryTrackingId',
        normalize: (value) => String(value ?? '').trim().toLowerCase() || null,
      },
      satellites: {
        key: 'selectedSatTrackingId',
        normalize: (value) => {
          const candidate = Number(value);
          return Number.isFinite(candidate) && candidate > 0 ? Math.trunc(candidate) : null;
        },
      },
    }[layerId];
    if (!config) return;
    const selectedValue = cleared ? null : config.normalize(event?.detail?.id);
    if (cleared || selectedValue === null) {
      this._dataManager.adoptLayerParams?.(layerId, {
        [config.key]: selectedValue,
      }, { origin });
      return;
    }
    // A direct selection promotes a Context-owned tracker dependency into
    // durable visibility before its selected ID is normalized. Context exit
    // also keeps this adopted layer instead of tearing down the user's track.
    const visibilityAdopted = this._dataManager.adoptLayerVisibility?.(
      layerId,
      true,
      { origin, adoptedFromSelection: true },
    );
    if (visibilityAdopted === false) return;
    // Clear the prior family before publishing the replacement. Otherwise the
    // coordinator briefly sees two IDs and correctly treats them as an
    // ambiguous incoming state, which would discard the new durable target.
    for (const [otherLayerId, otherKey] of [
      ['flights', 'selectedFlightsTrackingId'],
      ['military', 'selectedMilitaryTrackingId'],
      ['satellites', 'selectedSatTrackingId'],
    ]) {
      if (otherLayerId === layerId) continue;
      this._dataManager.setLayerParams(otherLayerId, { [otherKey]: null }, { origin });
    }
    this._dataManager.adoptLayerParams?.(layerId, {
      [config.key]: selectedValue,
    }, { origin });
  }

  /**
   * Connects the layer data manager for traffic sync, CCTV state subscription,
   * and layer enable/disable operations.
   * @param {object|null} dataManager - The DataManager instance, or null to detach.
   * @returns {void}
   */
  attachDataManager(dataManager) {
    this._dataManager = dataManager || null;
    this.hud.attachDataManager(this._dataManager);
    this._updateTrafficSyncChip();
    if (this._dataManagerUnsubscribe) {
      this._dataManagerUnsubscribe();
      this._dataManagerUnsubscribe = null;
    }
    this._contextControls.connect(this._dataManager);
    if (typeof this._dataManager?.subscribe === 'function') {
      this._dataManagerUnsubscribe = this._dataManager.subscribe((change) => {
        this._loadingFeedbackEvent = change;
        this._updateGlobalLoadingFeedback(performance.now());
      });
    }
    this._updateGlobalLoadingFeedback(performance.now());
    this._syncContextModeButtons();
    this._cctvControls.connect();
    this._radioControls.connect();
    if (!this._awarenessSelectedHandler) {
      this._awarenessSelectedHandler = (event) => this._persistAwarenessSelection(event, false);
      this._awarenessClearedHandler = (event) => this._persistAwarenessSelection(event, true);
      window.addEventListener('gev:awareness-subject-selected', this._awarenessSelectedHandler);
      window.addEventListener('gev:awareness-subject-cleared', this._awarenessClearedHandler);
    }
    this._layerStateCoordinator?.destroy();
    this._layerStateCoordinator = null;
    this._layerStateRestorePromise = null;
    if (this._dataManager) {
      this._layerStateCoordinator = new LayerStateCoordinator(
        this._dataManager,
        this.shareLinkManager,
        {
          onDurableStateChange: (state) => this._syncModels3dFromLayerState(state),
          onTrackingRestoreStatus: (result) => this._handleShareTrackingRestoreStatus(result),
        },
      );
      this._layerStateRestorePromise = this._layerStateCoordinator.start({
        shareLayerState: this._initialShareState?.layerState || null,
        shareCreatedAtMs: this._initialShareState?.sharedAtMs ?? null,
        // Any valid camera/style share isolates recipient-local preferences,
        // including legacy and malformed-v2 layer payloads.
        allowLocalState: !this._initialShareState,
      });
      if (this._initialShareSelectionSuperseded) {
        this._layerStateCoordinator.cancelPendingShareTracking(
          'superseded-before-layer-coordinator-start',
          { clearSelection: true },
        );
      }
      void this._layerStateRestorePromise.then(() => {
        this._syncModels3dFromLayerState(this._layerStateCoordinator?.getDurableState());
      });
    }
  }

  _handleShareTrackingRestoreStatus(result) {
    if (!result || this._disposed) return;
    const trackingKey = `${result.layerId || ''}:${result.targetId ?? ''}`;
    if (result.classification === 'pending') {
      this._shareTrackingNoticeGeneration += 1;
      this._shareTrackingAcquiringKey = trackingKey;
      this._showGlobalStatusNotice('ACQUIRING', {
        state: 'acquiring',
        detail: `SHARED ${String(result.label || 'SUBJECT').toUpperCase()}`,
        persistent: true,
      });
      return;
    }
    const ownsAcquiringNotice = this._shareTrackingAcquiringKey === trackingKey;
    if (ownsAcquiringNotice) {
      this._shareTrackingNoticeGeneration += 1;
      this._shareTrackingAcquiringKey = null;
      if (this._globalStatusNotice?.state === 'acquiring') {
        this._globalStatusNotice = null;
        this._updateGlobalLoadingFeedback();
      }
    }
    if (result.classification === 'followed' || result.classification === 'cancelled') return;
    // A stale terminal result must never replace a newer target's acquisition.
    if (this._shareTrackingAcquiringKey) return;
    const noticeGeneration = ownsAcquiringNotice
      ? this._shareTrackingNoticeGeneration
      : ++this._shareTrackingNoticeGeneration;
    const subject = result.label || 'entity';
    const message = result.classification === 'expired'
      ? `Shared ${subject} follow expired`
      : result.classification === 'source-unavailable'
        ? `Shared ${subject} could not be restored — feed unavailable`
        : `Shared ${subject} is unavailable`;
    const showAfterStartupCover = () => {
      requestAnimationFrame(() => {
        if (!canPresentDeferredStatusNotice(
          noticeGeneration,
          this._shareTrackingNoticeGeneration,
          this._disposed,
        )) return;
        const startupCover = document.getElementById('loading-screen');
        if (!startupCover || getComputedStyle(startupCover).visibility === 'hidden') {
          this._showGlobalStatusNotice(message);
          return;
        }
        let fallbackTimer = null;
        const showOnce = () => {
          startupCover.removeEventListener('transitionend', showOnce);
          if (fallbackTimer) clearTimeout(fallbackTimer);
          if (canPresentDeferredStatusNotice(
            noticeGeneration,
            this._shareTrackingNoticeGeneration,
            this._disposed,
          )) this._showGlobalStatusNotice(message);
        };
        startupCover.addEventListener('transitionend', showOnce, { once: true });
        fallbackTimer = setTimeout(showOnce, 1000);
      });
    };
    if (this._resolveInitialShareRestore) {
      void this.initialRestorePromise.then(showAfterStartupCover);
      return;
    }
    showAfterStartupCover();
  }

  get _contextMode() { return this._contextControls?._contextMode ?? null; }
  get _contextModeChanging() { return this._contextControls?._contextModeChanging ?? false; }
  get _preservePanelStateDuringLayerClear() { return this._contextControls?._preservePanelStateDuringLayerClear ?? false; }

  _initGlobalContextPanel() {
    this._contextControls = new ContextControls({
      elements: {
        _globalContextPanel: document.getElementById('global-context-panel'),
        _globalContextFlightsBtn: this._globalContextFlightsBtn,
        _globalContextMissionsBtn: this._globalContextMissionsBtn,
        _contextModeStandby: this._contextModeStandby,
        _contextFlightsView: this._contextFlightsView,
        _contextMissionsView: this._contextMissionsView,
        _installationsSearchBtn: this._installationsSearchBtn,
      },
      installations: militaryInstallationsLayer,
      actions: {
        getCockpit: () => this.cockpitView,
        refreshRadio: () => this._renderRadioState(radioLayer.getUIState()),
        claimVisualAuthority: () => this.shareLinkManager?.claimRestoreLane?.('visual'),
        syncDetection: () => this._syncContactsDetection(),
        scheduleLayout: () => this._scheduleRightPanelLayout(),
        setPanelCollapsed: (...args) => this.setPanelCollapsed(...args),
        showToast: (message) => { if (!this._disposed) this._showToast(message); },
        setClearBusy: (busy) => { if (!this._disposed) this._clearLayersControl?.setBusy(busy); },
      },
    });
  }

  _runUserFacingContextAction(...args) { return this._contextControls?._runUserFacingContextAction(...args); }

  _waitForContextLayerSettlement(...args) { return this._contextControls?._waitForContextLayerSettlement(...args); }

  _syncContextModeButtons(...args) { return this._contextControls?._syncContextModeButtons(...args); }

  /** Wire the independent Radio companion controls. */
  _initRadioPanel() {
    this._radioControls?.destroy();
    this._radioControls = new RadioControls({
      elements: {
        _cockpitDisplayPanel: this._cockpitDisplayPanel,
        _cockpitDisplayToggleBtn: this._cockpitDisplayToggleBtn,
        _cockpitRadioEnableBtn: this._cockpitRadioEnableBtn,
        _cockpitRadioNextBtn: this._cockpitRadioNextBtn,
        _cockpitRadioPanel: this._cockpitRadioPanel,
        _cockpitRadioPlayBtn: this._cockpitRadioPlayBtn,
        _cockpitRadioPrevBtn: this._cockpitRadioPrevBtn,
        _cockpitRadioStation: this._cockpitRadioStation,
        _cockpitRadioToggleBtn: this._cockpitRadioToggleBtn,
        _cockpitRadioVolume: this._cockpitRadioVolume,
        _cockpitRadioVolumeValue: this._cockpitRadioVolumeValue,
        _cockpitUtilityControls: this._cockpitUtilityControls,
        _contextRadioDetailsBtn: this._contextRadioDetailsBtn,
        _contextRadioDock: this._contextRadioDock,
        _contextRadioMini: this._contextRadioMini,
        _contextRadioMiniCloseBtn: this._contextRadioMiniCloseBtn,
        _contextRadioMiniEnableBtn: this._contextRadioMiniEnableBtn,
        _contextRadioMiniNextBtn: this._contextRadioMiniNextBtn,
        _contextRadioMiniPlayBtn: this._contextRadioMiniPlayBtn,
        _contextRadioMiniPrevBtn: this._contextRadioMiniPrevBtn,
        _contextRadioMiniStation: this._contextRadioMiniStation,
        _contextRadioMiniVolume: this._contextRadioMiniVolume,
        _contextRadioMiniVolumeValue: this._contextRadioMiniVolumeValue,
        _contextRadioToggleBtn: this._contextRadioToggleBtn,
        _radioEnableBtn: this._radioEnableBtn,
        _radioFilter: this._radioFilter,
        _radioLayerState: this._radioLayerState,
        _radioNextBtn: this._radioNextBtn,
        _radioPanel: this._radioPanel,
        _radioPlayBtn: this._radioPlayBtn,
        _radioPlaybackState: this._radioPlaybackState,
        _radioPrevBtn: this._radioPrevBtn,
        _radioStationHomepage: this._radioStationHomepage,
        _radioStationMeta: this._radioStationMeta,
        _radioStationName: this._radioStationName,
        _radioStationTags: this._radioStationTags,
        _radioStopBtn: this._radioStopBtn,
        _radioTuner: this._radioTuner,
        _radioTunerBandLabel: this._radioTunerBandLabel,
        _radioTunerNeedle: this._radioTunerNeedle,
        _radioTunerSlider: this._radioTunerSlider,
        _radioTunerStation: this._radioTunerStation,
        _radioTunerValue: this._radioTunerValue,
        _radioVolume: this._radioVolume,
        _radioVolumeValue: this._radioVolumeValue,
      },
      radio: radioLayer,
      canvas: this.viewer?.canvas,
      actions: {
        isRegistered: () => this._dataManager?.layers?.has('radio'),
        isEnabled: () => this._dataManager?.isEnabled('radio'),
        setEnabled: (enabled, options) => this._dataManager.setEnabled('radio', enabled, options),
        setParams: (params, options) => this._dataManager?.setLayerParams('radio', params, options),
        getLifecycle: () => this._dataManager?.getLayerLifecycleState?.('radio'),
        runUserAction: (...args) => this._runUserFacingContextAction(...args),
        setPanelCollapsed: (...args) => this.setPanelCollapsed(...args),
        revealStyleParameters: () => this._revealCockpitStyleParameters(),
        setSignalCollapsed: (value) => this.cockpitView?.setSignalCollapsed(value),
        isCockpitActive: () => this.cockpitView?.active,
        signalUserCollapsed: () => this.cockpitView?.signalUserCollapsed,
        layoutCockpit: () => this.cockpitView?.scheduleContextLayout(),
        preservePanelStateDuringClear: () => this._preservePanelStateDuringLayerClear,
        scheduleLayout: () => this._scheduleRightPanelLayout(),
      },
    });
  }

  _setCockpitDisclosure(...args) { return this._radioControls?._setCockpitDisclosure?.(...args); }

  _setRadioDisclosure(...args) { return this._radioControls?._setRadioDisclosure?.(...args); }

  _syncContextRadioLauncherState(...args) { return this._radioControls?._syncContextRadioLauncherState?.(...args); }

  _renderRadioState(...args) { return this._radioControls?._renderRadioState?.(...args); }

  /**
   * Activates an explicit CCTV target, then releases tracking before its camera
   * flight. Cockpit mode keeps tracking and suppresses only the flight.
   * @param {Function} activate CCTV target activation returning its camera ID.
   * @param {Function} focus CCTV camera flight receiving the activated ID.
   * @returns {*} Focus operation result.
   */
  _runExplicitCctvFocus(activate, focus) {
    if (this._disposed) return false;
    const cameraId = activate();
    if (!cameraId) return false;
    return this._runExplicitNavigation('camera', () => focus(cameraId));
  }

  /** Compose camera panel controls from the existing camera port and application actions. */
  _initCctvPanel() {
    this._cctvControls?.destroy();
    this._cctvControls = new CctvControls({
      elements: {
        _cctvAdjustBtn: this._cctvAdjustBtn,
        _cctvAutoHopBtn: this._cctvAutoHopBtn,
        _cctvCalReadout: this._cctvCalReadout,
        _cctvCalibResetBtn: this._cctvCalibResetBtn,
        _cctvCalibSaveBtn: this._cctvCalibSaveBtn,
        _cctvCoverageBtn: this._cctvCoverageBtn,
        _cctvEnableBtn: this._cctvEnableBtn,
        _cctvFocusBtn: this._cctvFocusBtn,
        _cctvFrame: this._cctvFrame,
        _cctvFrameWrap: this._cctvFrameWrap,
        _cctvMeta: this._cctvMeta,
        _cctvNearestBtn: this._cctvNearestBtn,
        _cctvNextBtn: this._cctvNextBtn,
        _cctvPanel: this._cctvPanel,
        _cctvPrevBtn: this._cctvPrevBtn,
        _cctvProjectionBtn: this._cctvProjectionBtn,
        _cctvQualityChip: this._cctvQualityChip,
        _cctvSelect: this._cctvSelect,
        _cctvSourceBadge: this._cctvSourceBadge,
        _cctvSummary: this._cctvSummary,
        _cctvSyncChip: this._cctvSyncChip,
        _cctvSyncLabel: this._cctvSyncLabel,
        _cctvSyncProgress: this._cctvSyncProgress,
      },
      cctv: cctvLayer,
      actions: {
        isEnabled: () => this._dataManager?.isEnabled('cctv'),
        setParams: (params, options) => this._dataManager?.setLayerParams('cctv', params, options),
        toggleEnabled: (...args) => this._toggleCctvEnabled(...args),
        runExplicitFocus: (...args) => this._runExplicitCctvFocus(...args),
        setPanelCollapsed: (...args) => this.setPanelCollapsed(...args),
        showToast: (message) => this._showToast(message),
        syncViewport: () => this._syncCctvPanelViewport(),
        setSplitFlapText,
      },
    });
  }

  /**
   * Toggles the CCTV layer enabled state. When enabling and no camera is active,
   * auto-focuses on the nearest camera.
   * @param {boolean} [forceState] - Explicit on/off. Omit to toggle.
   * @returns {Promise<boolean>} True if the layer is now in the requested state.
   */
  async _toggleCctvEnabled(forceState) {
    if (this._disposed) return false;
    if (!this._dataManager || !this._dataManager.layers?.has('cctv')) {
      this._showToast('CCTV layer unavailable');
      return false;
    }
    const enabled = this._dataManager.isEnabled('cctv');
    const target = typeof forceState === 'boolean' ? forceState : !enabled;
    if (target === enabled) return true;
    await runCctvLayerEnableTransition({
      target,
      setEnabled: (next) => this._dataManager.setEnabled('cctv', next, { origin: 'user' }),
      readOwnership: () => ({
        trackedEntity: this.viewer?.trackedEntity,
        cockpitActive: !!this.cockpitView?.active,
      }),
      shouldFocus: () => !this._disposed && this._dataManager.isEnabled('cctv')
        && !this._cctvControls?.getState()?.activeCameraId,
      activate: () => cctvLayer.focusNearest({ focus: false }),
      fly: (cameraId) => this._runExplicitCctvFocus(
        () => cameraId,
        (selectedId) => cctvLayer.focusCamera(selectedId, 1.6),
      ),
    });
    return true;
  }

  /**
   * Returns the versioned localStorage key for a panel's saved position.
   * @param {string} panelId - DOM id of the panel.
   * @returns {string} localStorage key.
   */
  _panelStorageKey(panelId) {
    return `godsEyeView.${PANEL_POSITION_STORAGE_VERSION}.panelPos.${panelId}`;
  }

  /**
   * Returns the versioned localStorage key for a panel's collapsed state.
   * @param {string} panelId - DOM id of the panel.
   * @returns {string} localStorage key.
   */
  _panelCollapseStorageKey(panelId) {
    return `godsEyeView.${PANEL_LAYOUT_STORAGE_VERSION}.panelCollapsed.${panelId}`;
  }

  /**
   * Restores a panel's collapsed/expanded state from localStorage.
   * Falls back to the CSS class default if no saved state exists.
   * @param {string} panelId - DOM id of the panel.
   * @returns {void}
   */
  _restorePanelCollapsedState(panelId, { allowStored = true } = {}) {
    const panelEl = document.getElementById(panelId);
    if (!panelEl) return;
    let collapsed = panelEl.classList.contains('collapsed');
    let stored = null;
    if (allowStored) {
      try {
        stored = localStorage.getItem(this._panelCollapseStorageKey(panelId));
        if (stored === '1') collapsed = true;
        if (stored === '0') collapsed = false;
      } catch {
        // storage unavailable
      }
    }
    // DISPLAY starts COLLAPSED for a first-time visitor, then respects the
    // user's persisted choice like every other panel.
    //
    // It used to start expanded, to advertise the HUD / DETECT / 3D toggles.
    // That reason expired when those became ON by default: the rail now opens
    // to offer controls for things already happening, while competing with the
    // first-run mission card for the one first impression there is. A stored
    // choice still wins in both directions, so anyone who opens it keeps it.
    if (panelId === 'pp-toggles' && stored === null) collapsed = true;
    panelEl.classList.toggle('collapsed', collapsed);
    this._syncPanelCollapseButton(panelEl);
  }

  /**
   * Persists a panel's collapsed state ('1' or '0') to localStorage.
   * @param {string} panelId - DOM id of the panel.
   * @param {boolean} collapsed - Whether the panel is collapsed.
   * @returns {void}
   */
  _savePanelCollapsedState(panelId, collapsed) {
    try {
      localStorage.setItem(this._panelCollapseStorageKey(panelId), collapsed ? '1' : '0');
    } catch {
      // storage unavailable
    }
  }

  /**
   * Builds one fixed right-side rail from Display, CCTV, its parameter
   * controls, and Global Context (which owns the nested Radio companion).
   * The rail then measures the live HUD chrome at runtime so it can stay
   * aligned and within the available vertical corridor.
   * @returns {void}
   */
  _initRightPanelAdaptiveLayout() {
    const stack = this._rightPanelStack;
    if (!stack || !this._ppToggles) return;

    this._ppToggles.style.removeProperty('top');
    this._ppToggles.style.removeProperty('right');
    this._ppToggles.style.removeProperty('bottom');
    this._ppToggles.style.removeProperty('left');
    this._ppToggles.style.removeProperty('z-index');
    this._ppToggles.classList.remove('panel-draggable', 'panel-dragging');
    this._ppToggles.querySelector('.pp-header-row')?.removeAttribute('title');
    stack.prepend(this._ppToggles);
    const globalContextPanel = document.getElementById('global-context-panel');
    if (this._cctvPanel) {
      this._cctvPanel.style.removeProperty('top');
      this._cctvPanel.style.removeProperty('right');
      this._cctvPanel.style.removeProperty('bottom');
      this._cctvPanel.style.removeProperty('left');
      this._cctvPanel.style.removeProperty('z-index');
      this._cctvPanel.classList.remove('panel-draggable', 'panel-dragging');
      stack.insertBefore(this._cctvPanel, globalContextPanel);
      this._syncPanelCollapseButton(this._cctvPanel);
    }
    if (this._sliderPanel) {
      this._sliderPanel.style.removeProperty('top');
      this._sliderPanel.style.removeProperty('right');
      this._sliderPanel.style.removeProperty('bottom');
      this._sliderPanel.style.removeProperty('left');
      this._sliderPanel.style.removeProperty('max-height');
      const detectionGroup = this._detectionBtn?.closest('.pp-toggle-group');
      if (detectionGroup) detectionGroup.after(this._sliderPanel);
      else this._ppToggles.append(this._sliderPanel);
    }
    if (typeof ResizeObserver !== 'undefined') {
      this._rightStackResizeObserver = new ResizeObserver(() => {
        this._scheduleRightPanelLayout();
      });
      this._rightStackResizeObserver.observe(stack);
      for (const panel of [this._ppToggles, this._cctvPanel, globalContextPanel]) {
        if (panel) this._rightStackResizeObserver.observe(panel);
      }
      document.querySelectorAll(RIGHT_STACK_OBSTACLE_SELECTOR).forEach((element) => {
        this._rightStackResizeObserver.observe(element);
      });
    }

    if (typeof MutationObserver !== 'undefined') {
      this._rightStackMutationObserver = new MutationObserver(() => {
        this._scheduleRightPanelLayout();
      });
      this._rightStackMutationObserver.observe(stack, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['class', 'hidden', 'data-variant'],
      });
      const hud = document.getElementById('intel-hud');
      if (hud) {
        this._rightStackMutationObserver.observe(hud, {
          subtree: true,
          attributes: true,
          attributeFilter: ['class', 'hidden', 'data-variant'],
        });
      }
    }

    const transitionHud = document.getElementById('intel-hud');
    if (transitionHud) {
      this._rightStackHudTransitionHandler = (event) => {
        if (event.propertyName === 'opacity' || event.propertyName === 'visibility') {
          this._scheduleRightPanelLayout({ reconsiderAutoCollapse: true });
        }
      };
      transitionHud.addEventListener('transitionend', this._rightStackHudTransitionHandler);
    }

    this._scheduleRightPanelLayout();
  }

  _scheduleRightPanelLayout({ reconsiderAutoCollapse = false } = {}) {
    if (reconsiderAutoCollapse) this._rightStackReconsiderAutoCollapse = true;
    if (!this._rightPanelStack || this._rightStackLayoutFrame !== null) return;
    this._rightStackLayoutFrame = requestAnimationFrame(() => {
      this._rightStackLayoutFrame = null;
      if (this._rightStackReconsiderAutoCollapse) {
        this._rightStackReconsiderAutoCollapse = false;
        for (const panel of this._rightPanelStack.querySelectorAll('.layout-auto-collapsed')) {
          panel.classList.remove('collapsed', 'layout-auto-collapsed');
          this._syncPanelCollapseButton(panel);
        }
      }
      this._syncRightPanelAdaptiveLayout();
    });
  }

  /**
   * Places the right rail inside the visible HUD-safe corridor. When the
   * corridor is too short, the expanded panel receives the remaining height
   * with internal scrolling. Tactical HUD hides collapsed sibling launchers
   * while a panel is expanded; other HUD layouts keep them visible.
   * @returns {void}
   */
  _syncRightPanelAdaptiveLayout() {
    layoutRightPanelRail({
      stack: this._rightPanelStack,
      obstacles: document.querySelectorAll(RIGHT_STACK_OBSTACLE_SELECTOR),
      windowRef: window,
      hud: { visible: this.hud.visible, variant: this.hud.getVariant() },
      preferredPanelId: this._rightStackPreferredPanelId,
      onCollapse: (panel) => this._syncPanelCollapseButton(panel),
      onRetry: () => this._scheduleRightPanelLayout(),
      leftStack: this._leftPanelStack,
      displayPanel: this._ppToggles,
      readDisplayScrollTop: () => this._displayPortalScrollRestoreOwner === 'standard'
        ? this._standardDisplayScrollTop
        : (this._ppToggles?.scrollTop || 0),
    });
  }

  /**
   * Initializes the adaptive left accordion. The layout engine measures the
   * actual HUD/chrome rectangles that intersect the left lane, then decides
   * whether collapsed sibling labels can remain visible beside the expanded
   * panel. No decision is keyed to a specific panel or HUD variant.
   * @returns {void}
   */
  _initLeftPanelAdaptiveLayout() {
    const stack = this._leftPanelStack;
    if (!stack) return;

    if (typeof ResizeObserver !== 'undefined') {
      this._leftStackResizeObserver = new ResizeObserver(() => {
        this._scheduleLeftPanelLayout();
      });
      this._leftStackResizeObserver.observe(stack);
      stack.querySelectorAll(':scope > [data-panel-id]').forEach((panel) => {
        this._leftStackResizeObserver.observe(panel);
        const inner = [...panel.children].find((child) => !child.classList.contains('panel-glow'));
        if (inner) this._leftStackResizeObserver.observe(inner);
      });
      document.querySelectorAll(LEFT_STACK_OBSTACLE_SELECTOR).forEach((element) => {
        this._leftStackResizeObserver.observe(element);
      });
    }

    if (typeof MutationObserver !== 'undefined') {
      this._leftStackMutationObserver = new MutationObserver(() => {
        this._scheduleLeftPanelLayout();
      });
      this._leftStackMutationObserver.observe(stack, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['class'],
      });
      const hud = document.getElementById('intel-hud');
      if (hud) {
        this._leftStackMutationObserver.observe(hud, {
          attributes: true,
          attributeFilter: ['class', 'data-variant'],
        });
      }
      const credits = document.getElementById('cesium-credits');
      if (credits) {
        this._leftStackMutationObserver.observe(credits, {
          subtree: true,
          childList: true,
        });
      }
    }

    const transitionHud = document.getElementById('intel-hud');
    if (transitionHud) {
      this._leftStackHudTransitionHandler = (event) => {
        if (event.propertyName === 'opacity' || event.propertyName === 'visibility') {
          this._scheduleLeftPanelLayout({ reconsiderAutoCollapse: true });
          // The Cockpit strip hangs off the HUD's REC readout, so it has to
          // remeasure on the same event: the readout keeps its rect through
          // the whole fade and only stops counting once the HUD has retired.
          this.cockpitView?.scheduleContextLayout();
        }
      };
      transitionHud.addEventListener('transitionend', this._leftStackHudTransitionHandler);
    }

    this._leftStackCockpitModeHandler = () => {
      // Cockpit mode repositions the peripheral HUD and reveals its own
      // bottom-left context card. Measure after those styles have committed so
      // the accordion remains in the same obstacle-safe lane instead of
      // jumping to a cockpit-specific top anchor.
      this._scheduleLeftPanelLayout();
      requestAnimationFrame(() => this._scheduleLeftPanelLayout());
      setTimeout(() => this._scheduleLeftPanelLayout(), 300);
    };
    window.addEventListener('gev:cockpit-mode-changed', this._leftStackCockpitModeHandler);

    this._scheduleLeftPanelLayout();
  }

  /**
   * Batches adaptive accordion work into one animation frame.
   * @returns {void}
   */
  _scheduleLeftPanelLayout({ reconsiderAutoCollapse = false } = {}) {
    if (reconsiderAutoCollapse) this._leftStackReconsiderAutoCollapse = true;
    if (!this._leftPanelStack || this._leftStackLayoutFrame !== null) return;
    this._leftStackLayoutFrame = requestAnimationFrame(() => {
      this._leftStackLayoutFrame = null;
      if (this._leftStackReconsiderAutoCollapse) {
        this._leftStackReconsiderAutoCollapse = false;
        for (const panel of this._leftPanelStack.querySelectorAll('.layout-auto-collapsed')) {
          panel.classList.remove('collapsed', 'layout-auto-collapsed');
          this._syncPanelCollapseButton(panel);
        }
      }
      this._syncLeftPanelAdaptiveLayout();
    });
  }

  /**
   * Measures a live obstacle-free corridor for the left accordion and toggles
   * focus mode only when the expanded panel plus sibling labels cannot fit.
   * Safe boundaries are written as viewport-relative CSS values.
   * @returns {void}
   */
  _syncLeftPanelAdaptiveLayout() {
    layoutLeftPanelRail({
      stack: this._leftPanelStack,
      obstacles: document.querySelectorAll(LEFT_STACK_OBSTACLE_SELECTOR),
      windowRef: window,
      hud: { visible: this.hud.visible, variant: this.hud.getVariant() },
      preferredPanelId: this._leftStackPreferredPanelId,
      onCollapse: (panel) => this._syncPanelCollapseButton(panel),
      onRetry: () => this._scheduleLeftPanelLayout(),
      collapsedHeights: this._leftStackCollapsedHeights,
      onAligned: () => this._scheduleRightPanelLayout(),
    });
  }

  /**
   * Updates collapse button glyphs based on panel state. Right-rail panels
   * use directional arrows; left-stack panels use +/- symbols.
   * @param {HTMLElement} panelEl - The panel DOM element.
   * @returns {void}
   */
  _syncPanelCollapseButton(panelEl) {
    const isRightRail = ['pp-toggles', 'cctv-panel', 'global-context-panel'].includes(panelEl?.id);
    const collapsed = panelEl.classList.contains('collapsed');
    panelEl.querySelectorAll('.panel-collapse-btn[data-collapse-target]').forEach((btn) => {
      const owner = btn.closest('[data-panel-id], #param-slider-panel');
      if (owner !== panelEl) return;
      if (isRightRail) {
        btn.textContent = collapsed ? '◀' : '▶';
      } else {
        btn.textContent = collapsed ? '+' : '−';
      }
      btn.setAttribute('aria-expanded', String(!collapsed));
      const panelName = panelEl.querySelector('.panel-title, .pp-header-label')?.textContent?.trim() || 'panel';
      const action = collapsed ? 'Expand' : 'Collapse';
      btn.title = `${action} ${panelName}`;
      btn.setAttribute('aria-label', `${action} ${panelName}`);
      if (panelEl.id === 'radio-panel') {
        const action = collapsed ? 'Expand' : 'Collapse';
        btn.title = `${action} Radio`;
        btn.setAttribute('aria-label', `${action} Radio section`);
      }
    });
    const dockToggle = panelEl.querySelector(`[data-dock-toggle-target="${panelEl.id}"]`);
    if (dockToggle) {
      const panelName = panelEl.querySelector('.panel-title, .location-toolbar-label')?.textContent?.trim() || 'panel';
      const action = collapsed ? 'Expand' : 'Collapse';
      dockToggle.setAttribute('aria-expanded', String(!collapsed));
      dockToggle.setAttribute('aria-label', `${action} ${panelName}`);
      dockToggle.title = `${action} ${panelName}`;
    }
    if (panelEl.id === 'radio-panel' && this._contextRadioDetailsBtn) {
      this._contextRadioDetailsBtn.setAttribute('aria-expanded', String(!collapsed));
    }
    if (panelEl.id === 'radio-panel' || panelEl.id === 'global-context-panel') {
      this._syncContextRadioLauncherState();
    }
  }

  /**
   * Converts a panel from left-positioned to right-anchored so it expands
   * leftward on resize. Used for the right-rail parameter panel.
   * @param {HTMLElement} panelEl - The panel to re-anchor.
   * @returns {void}
   */
  _pinPanelToRight(panelEl) {
    if (!panelEl) return;
    const rect = panelEl.getBoundingClientRect();
    const rightOffset = Math.max(6, Math.round(window.innerWidth - rect.right));
    panelEl.style.right = `${rightOffset}px`;
    panelEl.style.left = 'auto';
  }

  /**
   * Restores a panel's top/left position from localStorage.
   * Right-rail panels are additionally pinned to the right edge.
   * @param {string} panelId - DOM id of the panel.
   * @param {HTMLElement} panelEl - The panel DOM element.
   * @returns {void}
   */
  _restorePanelPosition(panelId, panelEl) {
    try {
      const raw = localStorage.getItem(this._panelStorageKey(panelId));
      if (!raw) return;
      const pos = JSON.parse(raw);
      if (!pos || typeof pos.left !== 'number' || typeof pos.top !== 'number') return;
      // Clamp to the viewport: a position saved at one window size would otherwise land off-screen at
      // another (audit U2 — observed a panel at x:-192). The drag handler clamps; restore must too.
      const { left, top } = this._clampToViewport(Math.round(pos.left), Math.round(pos.top), panelEl);
      panelEl.style.left = `${left}px`;
      panelEl.style.top = `${top}px`;
      panelEl.style.right = 'auto';
      panelEl.style.bottom = 'auto';
      if (panelId === 'pp-toggles') {
        this._pinPanelToRight(panelEl);
      }
    } catch {
      // ignore malformed saved panel position
    }
  }

  /**
   * Clamp a desired left/top so the panel stays fully on-screen (6px inset), matching the drag
   * clamp (ui.js ~1822). Width/height are position-independent, so reading the rect first is safe.
   * @param {number} left - desired left (px)
   * @param {number} top - desired top (px)
   * @param {HTMLElement} panelEl - the panel element
   * @returns {{left:number, top:number}}
   */
  _clampToViewport(left, top, panelEl) {
    const rect = panelEl.getBoundingClientRect();
    const maxLeft = Math.max(6, window.innerWidth - rect.width - 6);
    const maxTop = Math.max(6, window.innerHeight - rect.height - 6);
    return {
      left: Math.max(6, Math.min(maxLeft, left)),
      top: Math.max(6, Math.min(maxTop, top)),
    };
  }

  /**
   * Persists a panel's current bounding-rect position to localStorage.
   * @param {string} panelId - DOM id of the panel.
   * @param {HTMLElement} panelEl - The panel DOM element.
   * @returns {void}
   */
  _savePanelPosition(panelId, panelEl) {
    const rect = panelEl.getBoundingClientRect();
    try {
      localStorage.setItem(this._panelStorageKey(panelId), JSON.stringify({
        left: Math.round(rect.left),
        top: Math.round(rect.top),
      }));
    } catch {
      // storage unavailable
    }
  }

  /**
   * Makes a panel draggable via its handle element. Implements:
   * - Z-order promotion: each pointerdown increments the global z-counter
   *   so the clicked panel floats above siblings.
   * - Viewport clamping: drag moves are clamped to a 6px inset from all edges.
   * - Right-rail pinning: pp-toggles panel is re-anchored right after drag.
   * - CCTV viewport sync: cctv-panel recalculates scroll height after drag.
   * @param {string} panelId - DOM id of the panel.
   * @param {HTMLElement} panelEl - The panel DOM element.
   * @param {HTMLElement} handleEl - The drag handle element within the panel.
   * @returns {void}
   */
  /**
   * Promotes a panel to the top of the panel z band [PANEL_Z_BASE, PANEL_Z_MAX].
   * Renormalizes all promoted panels when the band is exhausted so panels can
   * never climb above the voice pill (150), toasts (200), or clean-view exit (300).
   * @param {HTMLElement} panelEl - Panel to bring to front.
   * @returns {void}
   */
  _promotePanelZ(panelEl) {
    this._panelZCounter += 1;
    if (this._panelZCounter > PANEL_Z_MAX) {
      const promoted = [...document.querySelectorAll('.panel-draggable')]
        .filter((el) => el.style.zIndex)
        .sort((a, b) => Number(a.style.zIndex) - Number(b.style.zIndex));
      let z = PANEL_Z_BASE + 1;
      for (const el of promoted) {
        el.style.zIndex = String(z);
        z += 1;
      }
      this._panelZCounter = z;
    }
    panelEl.style.zIndex = String(this._panelZCounter);
  }

  _makePanelDraggable(panelId, panelEl, handleEl) {
    // Z-order promotion: bring clicked panel to front of the stacking context
    panelEl.addEventListener('pointerdown', () => {
      this._promotePanelZ(panelEl);
    });

    handleEl.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      if (event.target.closest('.panel-collapse-btn')) return;
      if (event.target.closest('input, select, option, button:not(.panel-collapse-btn)')) return;

      event.preventDefault();
      const rect = panelEl.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      const offsetX = startX - rect.left;
      const offsetY = startY - rect.top;

      panelEl.style.left = `${rect.left}px`;
      panelEl.style.top = `${rect.top}px`;
      panelEl.style.right = 'auto';
      panelEl.style.bottom = 'auto';
      panelEl.classList.add('panel-dragging');
      this._promotePanelZ(panelEl);

      const onMove = (moveEvent) => {
        const nextLeftRaw = moveEvent.clientX - offsetX;
        const nextTopRaw = moveEvent.clientY - offsetY;
        const maxLeft = Math.max(6, window.innerWidth - rect.width - 6);
        const maxTop = Math.max(6, window.innerHeight - rect.height - 6);
        const nextLeft = Math.max(6, Math.min(maxLeft, nextLeftRaw));
        const nextTop = Math.max(6, Math.min(maxTop, nextTopRaw));
        panelEl.style.left = `${nextLeft}px`;
        panelEl.style.top = `${nextTop}px`;
        if (panelId === 'pp-toggles') {
          this._layoutRightPanels();
        }
        if (panelId === 'cctv-panel') {
          this._syncCctvPanelViewport();
        }
      };

      const onUp = () => {
        panelEl.classList.remove('panel-dragging');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        if (panelId === 'pp-toggles') {
          this._pinPanelToRight(panelEl);
        }
        this._savePanelPosition(panelId, panelEl);
        if (panelId === 'cctv-panel') {
          this._syncCctvPanelViewport();
        }
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    });
  }

  _buildSharePanelState() {
    const specs = [];
    for (const spec of SHARE_PANEL_STATE_SPECS) {
      const panelEl = document.getElementById(spec.id);
      if (!panelEl) continue;
      // Responsive auto-collapse is presentation only; the recipient should
      // restore the user's explicit expanded preference at its own viewport.
      const collapsed = panelEl.classList.contains('layout-auto-collapsed')
        ? false
        : panelEl.classList.contains('collapsed');
      const entry = { id: spec.id, collapsed };
      if (spec.pinnable) entry.pinned = panelEl.classList.contains('dock-pinned');
      specs.push(entry);
    }
    return specs.length ? { specs } : null;
  }

  _restorePanelState(panelState) {
    if (!panelState || !Array.isArray(panelState.specs)) return;
    const specsById = new Map(panelState.specs.map((spec) => [spec.id, spec]));
    for (const spec of SHARE_PANEL_STATE_SPECS) {
      const state = specsById.get(spec.id);
      if (!state || typeof state.collapsed !== 'boolean') continue;
      if (spec.pinnable && typeof state.pinned === 'boolean') {
        this._setCommandDockPanelPinState(spec.id, state.pinned, {
          restore: true,
          persist: false,
          syncShare: false,
        });
      }
      const nextCollapsed = state.pinned && spec.pinnable ? false : state.collapsed;
      this.setPanelCollapsed(spec.id, nextCollapsed, {
        restore: true,
        persist: false,
        syncShare: false,
      });
    }
    this.shareLinkManager?.onPanelStateChange?.();
  }

  /**
   * Programmatically collapses or expands a panel, persists the state,
   * and triggers layout recalculation for dependent panels.
   * @param {string} panelId - DOM id of the panel.
   * @param {boolean} collapsed - Whether to collapse the panel.
   * @param {object} [options] Disclosure ownership options.
   * @param {boolean} [options.explicit=false] Whether a direct user action owns the panel lane.
   * @returns {void}
   */
  setPanelCollapsed(panelId, collapsed, {
    explicit = false,
    restore = false,
    persist = true,
    syncShare = true,
  } = {}) {
    if (panelId === 'control-panel' && collapsed) this._cancelMapSourceFocus?.();
    const panelEl = document.getElementById(panelId);
    if (!panelEl) return;
    if (explicit && !restore) this.shareLinkManager?.claimRestoreLane?.('panel', panelId);
    const nextCollapsed = Boolean(collapsed);
    const wasAutoCollapsed = panelEl.classList.contains('layout-auto-collapsed');
    const leftOwnerPanel = this._leftPanelStack?.contains(panelEl) ? panelEl : null;
    const rightOwnerPanel = panelId === 'radio-panel'
      ? document.getElementById('global-context-panel')
      : (this._rightPanelStack?.contains(panelEl) ? panelEl : null);
    const priorLeftOwner = this._leftStackPreferredPanelId;
    const priorRightOwner = this._rightStackPreferredPanelId;
    if (explicit && !restore && !nextCollapsed && leftOwnerPanel) {
      this._leftStackPreferredPanelId = leftOwnerPanel.id;
    } else if (explicit && !restore && nextCollapsed && leftOwnerPanel?.id === this._leftStackPreferredPanelId) {
      this._leftStackPreferredPanelId = null;
    }
    if (explicit && !restore && !nextCollapsed && rightOwnerPanel) {
      this._rightStackPreferredPanelId = rightOwnerPanel.id;
    } else if (
      explicit
      && !restore
      && nextCollapsed
      && rightOwnerPanel?.id === this._rightStackPreferredPanelId
    ) {
      this._rightStackPreferredPanelId = null;
    }
    if (panelEl.classList.contains('collapsed') === nextCollapsed && !wasAutoCollapsed) {
      this._syncPanelCollapseButton(panelEl);
      if (priorLeftOwner !== this._leftStackPreferredPanelId) {
        this._scheduleLeftPanelLayout({ reconsiderAutoCollapse: true });
      }
      if (priorRightOwner !== this._rightStackPreferredPanelId) {
        this._scheduleRightPanelLayout({ reconsiderAutoCollapse: true });
      }
      return;
    }
    panelEl.classList.remove('layout-auto-collapsed');
    if (!nextCollapsed && this.cockpitView?.active && panelId === 'data-panel') {
      this._cockpitContextCollapsedForDataPanel = !this.cockpitView.contextCollapsed;
      if (this._cockpitContextCollapsedForDataPanel) {
        this.cockpitView.setContextCollapsed(true);
      }
    }
    if (!nextCollapsed && panelId === 'global-context-panel'
        && this._contextRadioDock?.classList.contains('disclosure-open')) {
      this._setRadioDisclosure?.(false);
    }
    if (!nextCollapsed && panelId === 'radio-panel'
        && document.getElementById('global-context-panel')?.classList.contains('collapsed')) {
      this.setPanelCollapsed('global-context-panel', false, { restore, persist, syncShare });
    }
    if (!nextCollapsed && !restore && panelId === 'location-bar') {
      const otherPanel = document.getElementById('control-panel');
      if (otherPanel && !otherPanel.classList.contains('dock-pinned')) {
        this.setPanelCollapsed('control-panel', true, { restore, persist, syncShare });
      }
    } else if (!nextCollapsed && !restore && panelId === 'control-panel') {
      const otherPanel = document.getElementById('location-bar');
      if (otherPanel && !otherPanel.classList.contains('dock-pinned')) {
        this.setPanelCollapsed('location-bar', true, { restore, persist, syncShare });
      }
    }
    panelEl.classList.toggle('collapsed', nextCollapsed);
    if (nextCollapsed && this.cockpitView?.active && panelId === 'data-panel'
        && this._cockpitContextCollapsedForDataPanel) {
      this._cockpitContextCollapsedForDataPanel = false;
      this.cockpitView.setContextCollapsed(false);
    }
    this._syncPanelCollapseButton(panelEl);
    if (persist !== false) this._savePanelCollapsedState(panelId, nextCollapsed);
    if (panelId === 'pp-toggles') {
      this._layoutRightPanels();
    }
    if (this._rightPanelStack?.contains(panelEl)) {
      this._scheduleRightPanelLayout({ reconsiderAutoCollapse: true });
    }
    if (panelId === 'cctv-panel') {
      this._syncCctvPanelViewport();
    }
    requestAnimationFrame(() => this._updateCommandDockTrayStack());
    this._scheduleLeftPanelLayout({
      reconsiderAutoCollapse: this._leftPanelStack?.contains(panelEl) === true,
    });
    if (syncShare) this.shareLinkManager?.onPanelStateChange?.();
  }

  /**
   * Toggles "clean view" mode which hides all UI panels via a CSS body class.
   * @param {boolean} [forceEnabled] - Explicit on/off. Omit to toggle.
   * @returns {void}
   */
  toggleCleanView(forceEnabled) {
    const shouldEnable = typeof forceEnabled === 'boolean'
      ? forceEnabled
      : !document.body.classList.contains('ui-clean-view');
    document.body.classList.toggle('ui-clean-view', shouldEnable);
    if (this._cleanViewBtn) {
      this._cleanViewBtn.classList.toggle('active', shouldEnable);
    }
    this._scheduleLeftPanelLayout();
  }

  // ── Public control facade ──────────────────────────────────────────────
  // Deliberate API for voice tools and scripting. Every setter keeps the DOM
  // sliders, share-link state, and scene snapshots in sync, and returns
  // { ok, ...resultingState } so callers confirm only what actually happened.

  /**
   * Sets HUD visibility mode. 'auto' restores style-driven show/hide.
   * @param {'on'|'off'|'auto'} mode - Visibility mode.
   * @returns {{ok: boolean, visible?: boolean, layout?: string, error?: string}}
   */
  setHudVisible(mode) {
    const normalized = String(mode ?? '').toLowerCase();
    if (!['on', 'off', 'auto'].includes(normalized)) {
      return { ok: false, error: `Unknown HUD visibility mode: ${mode}` };
    }
    this.shareLinkManager?.claimRestoreLane?.('visual');
    this.hud.setMode(normalized);
    this._updateHudButtonState();
    this._syncShareState();
    return { ok: true, visible: !!this.hud.visible, mode: normalized, layout: this.hud.getVariant() };
  }

  /**
   * Switches the HUD layout variant.
   * @param {'tactical'|'operator'|'minimal'} variantName - Layout variant.
   * @returns {{ok: boolean, layout?: string, visible?: boolean, error?: string}}
   */
  setHudLayout(variantName) {
    const variant = String(variantName ?? '').toLowerCase();
    if (!['tactical', 'operator', 'minimal'].includes(variant)) {
      return { ok: false, error: `Unknown HUD layout: ${variantName}` };
    }
    this.shareLinkManager?.claimRestoreLane?.('visual');
    this._setHudVariant(variant);
    return { ok: true, layout: this.hud.getVariant(), visible: !!this.hud.visible };
  }

  /**
   * Reads current detection overlay state (engine mode + UI density percent).
   * @returns {{detectionMode: string, densityPct: number|null, allocationStrategy:string, fadePct:number, outsideOpacityPct:number}}
   */
  getDetectionState() {
    const pct = this._detectionDensitySlider
      ? parseInt(this._detectionDensitySlider.value, 10)
      : null;
    return {
      detectionMode: getDetectionMode(),
      densityPct: pct,
      allocationStrategy: getDetectionTuning().allocationStrategy,
      fadePct: parseInt(this._detectionFadeSlider?.value || '7', 10),
      outsideOpacityPct: parseInt(this._detectionOpacitySlider?.value || '0', 10),
    };
  }

  /** Read-only overlay diagnostics used by browser QA and regression harnesses. */
  getDetectionDiagnostics() {
    return readDetectionDiagnostics();
  }

  /**
   * Controls the detection overlay: on/off, mode, and density percent.
   * Density writes the slider AND the engine so share links and scene
   * snapshots stay truthful.
   * @param {object} [options]
   * @param {boolean} [options.enabled] - false forces OFF; true restores the current density profile.
   * @param {'sparse'|'balanced'|'dense'|'panoptic'} [options.mode] - Profile (legacy aliases accepted).
   * @param {number} [options.densityPct] - 0-100 density percent.
   * @param {'elastic'|'weighted'} [options.allocationStrategy] - Layer-capacity policy.
   * @param {number} [options.fadePct] - Fade distance as 0-40% of the keyhole radius.
   * @param {number} [options.outsideOpacityPct] - Opacity beyond the fade distance, 0-100%.
   * @returns {{ok: boolean, detectionMode?: string, densityPct?: number|null, error?: string}}
   */
  setDetection({ enabled, mode, densityPct, allocationStrategy, fadePct, outsideOpacityPct } = {}) {
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return { ok: false, error: `Invalid detection enabled value: ${enabled}`, ...this.getDetectionState() };
    }
    let requestedProfile = null;
    if (typeof mode === 'string' && mode.trim()) {
      requestedProfile = normalizeProfile(mode);
      if (!requestedProfile) {
        return { ok: false, error: `Unknown detection mode: ${mode}`, ...this.getDetectionState() };
      }
    }
    let requestedDensity = null;
    if (densityPct != null) {
      if (!Number.isFinite(Number(densityPct))) {
        return { ok: false, error: `Invalid density: ${densityPct}`, ...this.getDetectionState() };
      }
      requestedDensity = canonicalizeDensity(Number(densityPct));
    }
    if (requestedProfile && requestedProfile !== 'OFF' && requestedDensity != null
      && profileForDensity(requestedDensity) !== requestedProfile) {
      return {
        ok: false,
        error: `Detection mode ${requestedProfile} conflicts with density ${requestedDensity}%`,
        ...this.getDetectionState(),
      };
    }
    let requestedAllocation = null;
    if (allocationStrategy != null) {
      requestedAllocation = String(allocationStrategy).trim().toUpperCase();
      if (!ALLOCATION_STRATEGIES.includes(requestedAllocation)) {
        return { ok: false, error: `Unknown allocation strategy: ${allocationStrategy}`, ...this.getDetectionState() };
      }
    }
    if (fadePct != null) {
      if (!Number.isFinite(Number(fadePct))) {
        return { ok: false, error: `Invalid fade distance: ${fadePct}`, ...this.getDetectionState() };
      }
    }
    if (outsideOpacityPct != null) {
      if (!Number.isFinite(Number(outsideOpacityPct))) {
        return { ok: false, error: `Invalid outside opacity: ${outsideOpacityPct}`, ...this.getDetectionState() };
      }
    }
    const hasExplicitVisualChange = typeof enabled === 'boolean'
      || requestedProfile !== null
      || requestedDensity !== null
      || requestedAllocation !== null
      || fadePct != null
      || outsideOpacityPct != null;
    if (hasExplicitVisualChange) {
      // Voice/scripted detection control counts as an explicit user choice, so
      // neither style presets nor a still-pending shared visual restore can
      // overwrite it afterward.
      this.shareLinkManager?.claimRestoreLane?.('visual');
      this._detectionUserOverridden = true;
    }
    if (requestedAllocation) {
      this._setDetectionAllocation(requestedAllocation, { syncShare: false });
    }
    if (fadePct != null && this._detectionFadeSlider) {
      this._detectionFadeSlider.value = String(Math.max(0, Math.min(40, Math.round(Number(fadePct)))));
    }
    if (outsideOpacityPct != null && this._detectionOpacitySlider) {
      this._detectionOpacitySlider.value = String(Math.max(0, Math.min(100, Math.round(Number(outsideOpacityPct)))));
    }
    if (fadePct != null || outsideOpacityPct != null) this._applyDetectionFadeFromUi();

    if (requestedProfile && requestedProfile !== 'OFF' && requestedDensity == null) {
      requestedDensity = defaultDensityForProfile(requestedProfile);
    }
    if (requestedDensity != null && this._detectionDensitySlider) {
      this._detectionDensitySlider.value = String(requestedDensity);
      this._applyDetectionDensityFromUi();
    }

    if (enabled === false || requestedProfile === 'OFF') {
      setDetectionModeByLabel('OFF');
    } else if (requestedProfile) {
      setDetectionModeByLabel(requestedProfile);
    } else if (enabled === true && getDetectionMode() === 'OFF') {
      setDetectionModeByLabel(profileForDensity(
        requestedDensity ?? this._detectionDensitySlider?.value ?? 50,
      ));
    }
    this._syncDetectionUiFromEngine();
    this._syncShareState();
    return { ok: true, ...this.getDetectionState() };
  }

  /**
   * Switches the basemap stack and reports whether the switch landed.
   * @param {string} stackId - One of mapStackController.getStacks() ids.
   * @returns {Promise<{ok: boolean, activeStack?: string, error?: string|null, available?: string[]}>}
   */
  async setMapStack(stackId) {
    if (!this.mapStackController) {
      return { ok: false, error: 'Map stack controller unavailable' };
    }
    const stacks = this.mapStackController.getStacks();
    const target = stacks.find((stack) => stack.id === stackId);
    if (!target) {
      return { ok: false, error: `Unknown map stack: ${stackId}`, available: stacks.map((s) => s.id) };
    }
    if (!target.available) {
      return { ok: false, error: `${target.label} requires a Cesium ion token`, activeStack: this.mapStackController.getActiveId() };
    }
    await this._setMapStack(stackId);
    const state = this.mapStackController.getState();
    const landed = state.activeId === stackId;
    return {
      ok: landed,
      activeStack: state.activeId,
      error: landed ? null : (state.lastError || 'Map stack did not switch'),
    };
  }

  /**
   * Controls bloom post-processing. Intensity is the UI percent (0-200).
   * @param {object} [options]
   * @param {boolean} [options.enabled]
   * @param {number} [options.intensityPct] - 0-200.
   * @returns {{ok: boolean, bloom: {enabled: boolean, intensityPct: number|null}}}
   */
  setBloom({ enabled, intensityPct } = {}) {
    const current = () => ({
      enabled: !!this.bloomEnabled,
      intensityPct: this._bloomSlider ? parseInt(this._bloomSlider.value, 10) : null,
    });
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return { ok: false, error: `Invalid bloom enabled value: ${enabled}`, bloom: current() };
    }
    if (intensityPct !== undefined
      && (typeof intensityPct !== 'number' || !Number.isFinite(intensityPct))) {
      return { ok: false, error: `Invalid bloom intensity: ${intensityPct}`, bloom: current() };
    }
    const hasExplicitVisualChange = intensityPct !== undefined || enabled !== undefined;
    if (hasExplicitVisualChange) this.shareLinkManager?.claimRestoreLane?.('visual');
    if (intensityPct !== undefined) {
      this._setBloomIntensity(Math.round(Math.max(0, Math.min(200, intensityPct))));
    }
    if (enabled !== undefined) this._setBloomEnabled(enabled);
    return {
      ok: true,
      bloom: current(),
    };
  }

  /**
   * Controls sharpen post-processing. Intensity is the UI percent (0-100).
   * @param {object} [options]
   * @param {boolean} [options.enabled]
   * @param {number} [options.intensityPct] - 0-100.
   * @returns {{ok: boolean, sharpen: {enabled: boolean, intensityPct: number|null}}}
   */
  setSharpen({ enabled, intensityPct } = {}) {
    const current = () => ({
      enabled: !!this.sharpenEnabled,
      intensityPct: this._sharpenSlider ? parseInt(this._sharpenSlider.value, 10) : null,
    });
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return { ok: false, error: `Invalid sharpen enabled value: ${enabled}`, sharpen: current() };
    }
    if (intensityPct !== undefined
      && (typeof intensityPct !== 'number' || !Number.isFinite(intensityPct))) {
      return { ok: false, error: `Invalid sharpen intensity: ${intensityPct}`, sharpen: current() };
    }
    const hasExplicitVisualChange = intensityPct !== undefined || enabled !== undefined;
    if (hasExplicitVisualChange) this.shareLinkManager?.claimRestoreLane?.('visual');
    if (intensityPct !== undefined) {
      const pct = Math.round(Math.max(0, Math.min(100, intensityPct)));
      if (this._sharpenSlider) this._sharpenSlider.value = String(pct);
      if (this._sharpenSliderValue) this._sharpenSliderValue.textContent = `${pct}%`;
      this._applySharpenIntensity(pct / 100);
      this._syncShareState();
    }
    if (enabled !== undefined) this._setSharpenEnabled(enabled);
    return {
      ok: true,
      sharpen: current(),
    };
  }

  /** Whether the full-globe celestial overlay is enabled by user preference. */
  get celestialRingEnabled() {
    return !!this.celestialRing?.enabled;
  }

  /**
   * Controls the celestial ring. The Display button uses `focus=true` when the
   * ring is disabled or unavailable at the current zoom, turning the control
   * into a reveal action instead of requiring a separate globe-navigation step.
   * @param {boolean} enabled
   * @param {object} [options]
   * @param {boolean} [options.syncShare=true]
   * @param {boolean} [options.focus=false]
   * @returns {{ok:boolean, celestialRing:{enabled:boolean,visible:boolean}, cameraFocused:boolean, error?:string}}
   */
  setCelestialRingEnabled(enabled, { syncShare = true, focus = false } = {}) {
    const styleSupported = isCelestialRingStyleSupported(this.activeStyle);
    const current = () => ({
      enabled: this.celestialRingEnabled,
      visible: !!this.celestialRing?.visible,
    });
    if (typeof enabled !== 'boolean') {
      return {
        ok: false,
        celestialRing: current(),
        cameraFocused: false,
        error: `Invalid celestial ring enabled value: ${enabled}`,
      };
    }
    if (typeof syncShare !== 'boolean' || typeof focus !== 'boolean') {
      return {
        ok: false,
        celestialRing: current(),
        cameraFocused: false,
        error: 'Celestial ring options must be boolean',
      };
    }
    if (!styleSupported && enabled) {
      return {
        ok: false,
        celestialRing: current(),
        cameraFocused: false,
        error: 'Celestial ring is available only in Normal style',
      };
    }
    if (syncShare) this.shareLinkManager?.claimRestoreLane?.('visual');
    const nextEnabled = styleSupported && enabled;
    this.celestialRing?.setEnabled(nextEnabled);
    this._celestialBtn?.classList.toggle('active', nextEnabled);
    this._celestialBtn?.setAttribute('aria-pressed', String(nextEnabled));
    if (this._celestialBtn) {
      this._celestialBtn.disabled = !styleSupported;
      this._celestialBtn.setAttribute('aria-disabled', String(!styleSupported));
      this._celestialBtn.title = styleSupported
        ? 'Celestial ring — reveal the full globe'
        : 'Celestial ring — available in Normal style';
    }
    let cameraFocused = false;
    if (nextEnabled && focus) {
      cameraFocused = !!this.celestialRing?.focusFullGlobe();
    }
    if (syncShare) this._syncShareState();
    return {
      ok: styleSupported || !enabled,
      celestialRing: current(),
      cameraFocused,
    };
  }

  /**
   * Starts or stops orbiting the active POI.
   * @param {boolean} [enabled] - Omit to toggle.
   * @returns {{ok: boolean, orbiting: boolean, error?: string}}
   */
  setOrbit(enabled) {
    const active = !!this.orbitController?.active;
    if (typeof enabled === 'boolean' && enabled === active) {
      return { ok: true, orbiting: active };
    }
    if (enabled === false) {
      this._stopOrbit();
      return { ok: true, orbiting: false };
    }
    if (!this._currentTarget) {
      return { ok: false, orbiting: false, error: 'No active landmark to orbit — fly to a landmark first' };
    }
    this._toggleOrbit();
    return { ok: true, orbiting: !!this.orbitController?.active };
  }

  /**
   * Enables/disables clean view (hides all UI chrome).
   * @param {boolean} [enabled] - Omit to toggle.
   * @returns {{ok: boolean, cleanView: boolean}}
   */
  setCleanView(enabled) {
    this.toggleCleanView(enabled);
    return { ok: true, cleanView: document.body.classList.contains('ui-clean-view') };
  }

  /**
   * Reads global context mode state for voice/state-sync consumers.
   * @returns {{mode: 'flights'|'space-missions'|null, active: boolean, changing: boolean, entering: 'flights'|'space-missions'|null, snapshotCaptured: boolean}}
   */
  getContextModeState(...args) { return this._contextControls?.getContextModeState(...args); }

  /**
   * Sets global context mode (Contacts / Space Missions / off) for voice.
   * @param {'contacts'|'space-missions'|'off'|null} mode - Requested context target.
   * @param {object} [options]
   * @param {string|Symbol|null} [options.notificationToken]
   * @param {AbortSignal|null} [options.signal]
   * @param {Function|null} [options.isCurrent]
   * @param {boolean} [options.claimVisualAuthority] Whether this request is a
   *   genuine operator/voice Context intent that should take the visual restore
   *   lane. Cockpit choreography calls this facade INTERNALLY for its own
   *   enter/rollback steps; those transitions are not a Context request by the
   *   operator and must stay inert, so they pass `false`.
   * @returns {Promise<{ok:boolean, mode:'flights'|'space-missions'|null, active:boolean, action:string, error?:string}>}
   */
  setContextMode(...args) { return this._contextControls?.setContextMode(...args); }

  /**
   * Returns cockpit status for voice/state sync and navigation operations.
   * @returns {{active:boolean, entryAllowed:boolean, visionMode:string, subject:{id:string,layerId:string}|null, navigation:{canPrevious:boolean,canNext:boolean,canFocus:boolean}|null, awareness?: object}|null}
   */
  getCockpitState() {
    const snapshot = militaryAwarenessLayer.getContextSnapshot?.();
    const info = this.cockpitView?.readAircraftInfo?.();
    const active = Boolean(this.cockpitView?.active);
    const gateOpen = Boolean(this.cockpitView?.isEntryAllowed?.());
    // "Could Cockpit be ENTERED right now" — so it is false while already
    // inside, unconditionally. Cockpit takes the entity off
    // `viewer.trackedEntity` on entry and NEXT puts one back, which made this
    // flip true/false between calls while `active` stayed true; readers
    // (including the voice model) read that as a broken half-entered state.
    const entryAllowed = !active && Boolean(
      gateOpen
      && info
      && this.viewer?.trackedEntity?.position,
    );
    return {
      active,
      entryAllowed,
      // Why entry is unavailable, so a refusal can be explained rather than
      // guessed at.
      entryBlockedReason: entryAllowed || active
        ? null
        : (!gateOpen
          ? (this._contextModeChanging ? 'contacts-starting' : 'contacts-inactive')
          : 'no-tracked-aircraft'),
      visionMode: this.cockpitView?.visionMode || null,
      subject: info ? {
        id: info.icao24 || info.id || null,
        layerId: info.layerId || null,
        callsign: info.callsign || null,
      } : null,
      navigation: snapshot ? {
        canPrevious: Boolean(snapshot.navigation?.canPrevious),
        canNext: Boolean(snapshot.navigation?.canNext),
        canFocus: Boolean(snapshot.navigation?.canFocus),
      } : null,
      awareness: snapshot ? {
        radiusM: Number.isFinite(snapshot.radiusM) ? snapshot.radiusM : null,
        subject: snapshot.subject ? {
          id: snapshot.subject.id || null,
          layerId: snapshot.subject.layerId || null,
        } : null,
        cohorts: Array.isArray(snapshot.cohorts)
          ? snapshot.cohorts.map((cohort) => ({
            id: cohort?.id || null,
            source: cohort?.source || null,
            count: Number.isFinite(cohort?.count) ? cohort.count : null,
            relationship: cohort?.relationship || null,
            reason: cohort?.reason || null,
            coverage: cohort?.coverage || null,
          }))
          : [],
        navigation: snapshot.navigation ? {
          canPrevious: Boolean(snapshot.navigation.canPrevious),
          canNext: Boolean(snapshot.navigation.canNext),
          canFocus: Boolean(snapshot.navigation.canFocus),
        } : null,
      } : null,
      activeTracked: this.cockpitView?.active ? Boolean(this.cockpitView?.trackedEntity) : false,
      activeMapView: !this.cockpitView?.active && entryAllowed,
    };
  }

  /**
   * Point Cockpit entry at a requested contact layer before it enters.
   *
   * Reuses the filtered Context navigation NEXT already uses, so "cockpit in
   * that military helicopter" lands on the same contact "next military
   * helicopter" would. Cockpit flies aircraft only; vessel and installation
   * layers are refused by name rather than silently ignored.
   * @param {object} options Retarget request.
   * @param {string} options.targetLayer Requested contact layer.
   * @param {string|null} options.aircraftClass Optional class filter.
   * @param {{layerId: string}|null} options.currentTarget Current tracker.
   * @param {{layerId: string}|null} options.selectedTarget Pending selection.
   * @returns {{ok: boolean, retargeted?: boolean, error?: string}} Outcome.
   */
  _retargetCockpitEntryLayer({ targetLayer, aircraftClass, currentTarget, selectedTarget }) {
    if (!['flights', 'military'].includes(targetLayer)) {
      return {
        ok: false,
        error: `Cockpit flies aircraft only — ${targetLayer} contacts cannot be entered`,
      };
    }
    const activeLayer = selectedTarget?.layerId || currentTarget?.layerId || null;
    const alreadyOnLayer = activeLayer === targetLayer;
    if (alreadyOnLayer && !aircraftClass) return { ok: true, retargeted: false };
    const moved = militaryAwarenessLayer?.navigateNext
      ? !!militaryAwarenessLayer.navigateNext({
        targetLayer,
        aircraftClass,
        origin: 'voice',
      })
      : false;
    if (moved) return { ok: true, retargeted: true };
    // A filter that matched nothing still enters, as long as the layer is
    // already right — the operator asked for that layer and is on it.
    if (alreadyOnLayer) return { ok: true, retargeted: false };
    const label = targetLayer === 'military' ? 'military' : 'civilian';
    const filtered = aircraftClass ? `${aircraftClass} ` : '';
    return {
      ok: false,
      error: `No ${filtered}${label} contact is available to enter — track one first, or say "next ${label}"`,
    };
  }

  /**
   * Controls cockpit entry/exit and context navigation.
   * @param {'enter'|'exit'|'next'|'previous'|'status'} action - Cockpit action.
   * @param {object} [options]
   * @param {string|Symbol|null} [options.notificationToken]
   * @param {'flights'|'military'|'ais-live-vessels'|'military-installations'|null} [options.targetLayer]
   * @param {string|null} [options.aircraftClass]
   * @param {{layerId:'flights'|'military',id:string}|null} [options.selectedTarget]
   * @param {{layerId:'flights'|'military',id:string}|null} [options.rollbackTarget]
   * @returns {{ok:boolean, action:string, error?:string, state?:object}}
   */
  controlCockpit(action, {
    notificationToken = null,
    targetLayer = null,
    aircraftClass = null,
    selectedTarget = null,
    rollbackTarget = undefined,
  } = {}) {
    const normalized = String(action || '').toLowerCase();
    if (!this.cockpitView) {
      return {
        ok: false,
        action: 'control_cockpit',
        error: 'Cockpit controller unavailable',
        state: this.getCockpitState(),
      };
    }
    if (normalized === 'status') {
      return {
        ok: true,
        action: 'control_cockpit',
        state: this.getCockpitState(),
        notificationToken: notificationToken || null,
      };
    }
    if (normalized === 'enter') {
      // Entry is gated exactly as the manual entry chip is. Attempting it while
      // the gate is shut produced the half-entered look the operator reported
      // (a plane anchored under the camera with no cockpit around it), so
      // refuse with the reason instead of trying.
      if (!this.cockpitView.isEntryAllowed?.()) {
        return {
          ok: false,
          action: 'control_cockpit',
          error: this._contextModeChanging
            ? 'Contacts is still starting up — try Cockpit again in a moment'
            : 'Contacts must be active to enter Cockpit — say "open contacts" first',
          state: this.getCockpitState(),
        };
      }
      let currentTarget = this.getAircraftTrackingTarget();
      const layerForTarget = (target) => target?.layerId === 'military'
        ? militaryFlightsLayer
        : target?.layerId === 'flights' ? flightsLayer : null;
      // A requested layer retargets BEFORE entry, through the same filtered
      // navigation NEXT uses. Ignoring it entered on whatever was already
      // tracked and reported success, so "cockpit in that military helicopter"
      // silently put the operator in an airliner.
      if (targetLayer) {
        const requested = this._retargetCockpitEntryLayer({
          targetLayer,
          aircraftClass,
          currentTarget,
          selectedTarget,
        });
        if (!requested.ok) {
          return {
            ok: false,
            action: 'control_cockpit',
            error: requested.error,
            state: this.getCockpitState(),
          };
        }
        if (requested.retargeted) {
          // The retarget is now the authority; a selection sampled before it
          // would drag entry back to the wrong layer.
          selectedTarget = null;
          rollbackTarget = rollbackTarget === undefined ? currentTarget : rollbackTarget;
          currentTarget = this.getAircraftTrackingTarget();
        }
      }
      const selectedLayer = selectedTarget?.layerId === 'military'
        ? militaryFlightsLayer
        : selectedTarget?.layerId === 'flights' ? flightsLayer : null;
      const entry = enterCockpitWithTracking({
        cockpitView: this.cockpitView,
        selectedLayer,
        selectedTarget,
        currentLayer: layerForTarget(currentTarget),
        rollbackLayer: layerForTarget(
          rollbackTarget === undefined ? currentTarget : rollbackTarget,
        ),
        rollbackTarget,
        selectionOrigin: 'voice',
      });
      return {
        ok: entry.entered,
        action: 'control_cockpit',
        state: this.getCockpitState(),
        error: entry.error,
      };
    }
    if (normalized === 'exit') {
      const exited = !!this.cockpitView.exit();
      return {
        ok: exited,
        action: 'control_cockpit',
        state: this.getCockpitState(),
        error: exited ? null : 'Cockpit was already inactive',
      };
    }
    if (normalized === 'next' || normalized === 'previous') {
      const changed = this.cockpitView.navigateContext(
        normalized === 'next' ? 1 : -1,
        {
          targetLayer,
          aircraftClass,
          origin: 'voice',
        },
      );
      return {
        ok: changed,
        action: 'control_cockpit',
        state: this.getCockpitState(),
        error: changed ? null : 'No further context target was available',
      };
    }
    return {
      ok: false,
      action: 'control_cockpit',
      error: `Unknown cockpit action: ${action}`,
      state: this.getCockpitState(),
    };
  }

  /**
   * Full control-state snapshot — single source for voice read-back so the
   * agent confirms from the same state it acted on.
   * @returns {object} Current style/stack/HUD/detection/post-processing state.
   */
  getControlState() {
    return {
      style: this.activeStyle || 'normal',
      mapStack: this.mapStackController?.getActiveId?.() || null,
      hud: { visible: !!this.hud?.visible, layout: this.hud?.getVariant?.() || null },
      detection: this.getDetectionState(),
      bloom: {
        enabled: !!this.bloomEnabled,
        intensityPct: this._bloomSlider ? parseInt(this._bloomSlider.value, 10) : null,
      },
      sharpen: {
        enabled: !!this.sharpenEnabled,
        intensityPct: this._sharpenSlider ? parseInt(this._sharpenSlider.value, 10) : null,
      },
      celestialRing: {
        enabled: this.celestialRingEnabled,
        visible: !!this.celestialRing?.visible,
      },
      orbiting: !!this.orbitController?.active,
      recording: !!this._recordingMode,
      cleanView: document.body.classList.contains('ui-clean-view'),
    };
  }

  /**
   * Captures the current camera position and orientation as a serializable object.
   * @returns {{lat: number, lon: number, alt: number, heading: number, pitch: number, roll: number}|null}
   */
  getCameraState() {
    const carto = this.viewer.camera.positionCartographic;
    if (!carto) return null;
    return {
      lat: Cesium.Math.toDegrees(carto.latitude),
      lon: Cesium.Math.toDegrees(carto.longitude),
      alt: carto.height,
      heading: Cesium.Math.toDegrees(this.viewer.camera.heading),
      pitch: Cesium.Math.toDegrees(this.viewer.camera.pitch),
      roll: Cesium.Math.toDegrees(this.viewer.camera.roll),
    };
  }

  /**
   * Flies the camera to a previously captured camera state using cubic ease-in-out.
   * @param {{lat: number, lon: number, alt: number, heading?: number, pitch?: number, roll?: number}} cameraState
   * @param {number} [duration=2.8] - Flight duration in seconds.
   * @returns {void}
   */
  applyCameraState(cameraState, duration = 2.8) {
    if (!cameraState) return;
    this.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        cameraState.lon,
        cameraState.lat,
        cameraState.alt
      ),
      orientation: {
        heading: Cesium.Math.toRadians(cameraState.heading || 0),
        pitch: Cesium.Math.toRadians(cameraState.pitch || -35),
        roll: Cesium.Math.toRadians(cameraState.roll || 0),
      },
      duration: Math.max(0.2, duration || 0),
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
    });
  }

  /**
   * Snapshots the full visual state (active style, bloom, sharpen, HUD, detection,
   * per-style shader uniform values) for serialization or scene recipe capture.
   * @returns {object} Serializable visual state object.
   */
  getVisualState() {
    const styleParams = {};
    for (const [styleName, stage] of Object.entries(this.stages)) {
      const shader = STYLES[styleName];
      if (!shader?.uniforms) continue;
      styleParams[styleName] = {};
      for (const uniformName of Object.keys(shader.uniforms)) {
        styleParams[styleName][uniformName] = stage.uniforms[uniformName];
      }
    }

    return {
      style: this.activeStyle,
      bloom: {
        enabled: this.bloomEnabled,
        intensity: this._getBloomIntensity(),
        version: BLOOM_SCALE_VERSION,
      },
      sharpen: {
        enabled: this.sharpenEnabled,
        intensity: parseInt(this._sharpenSlider?.value || '49', 10),
      },
      hud: {
        visible: this.hud.visible,
        variant: this.hud.getVariant(),
      },
      detection: {
        mode: getDetectionMode(),
        density: parseInt(this._detectionDensitySlider?.value || '50', 10),
        allocation: getDetectionTuning().allocationStrategy,
        fadePct: parseInt(this._detectionFadeSlider?.value || '7', 10),
        outsideOpacityPct: parseInt(this._detectionOpacitySlider?.value || '0', 10),
      },
      scope: {
        enabled: isScopeMaskEnabled(),
        featherPct: Math.round(getScopeMaskFeather() * 100),
      },
      mapStack: this.mapStackController?.getActiveId?.() || 'photoreal',
      styleParams,
    };
  }

  /**
   * Restores a full visual state snapshot, applying style, bloom, sharpen,
   * HUD, detection, and per-style shader uniforms. Used by scene recipes
   * and share-link restore. Async so the map-stack switch resolves before
   * the share state is synced; callers may fire-and-forget.
   * @param {object} [state={}] - Visual state object (as returned by getVisualState).
   * @param {object} [options]
   * @param {(() => boolean)|null} [options.isCurrent] Caller liveness predicate.
   *   The map-stack switch is this method's ONLY suspension point, and the
   *   shader-uniform writes come after it — so a caller superseded while that
   *   switch is in flight would otherwise resume and commit the look of a
   *   state the operator has already moved past. Scene playback reproduced
   *   exactly that: a stale shot's uniforms landing on top of the live run.
   *   Omit it and the method behaves as it always has.
   * @returns {Promise<boolean>} Whether the state was committed.
   */
  async applyVisualState(state = {}, { isCurrent = null } = {}) {
    const superseded = () => typeof isCurrent === 'function' && !isCurrent();
    if (superseded()) return false;

    if (state.style && state.style !== this.activeStyle) {
      this.setStyle(state.style, { applyPreset: false });
    }

    const bloomState = state.bloom || {};
    if (typeof bloomState.intensity === 'number' && this._bloomSlider) {
      const intensity = decodeBloomIntensity(
        bloomState.intensity,
        bloomState.version ?? state.bloomVersion ?? BLOOM_SCALE_VERSION
      );
      this._setBloomIntensity(intensity, { syncShare: false });
    }
    if (typeof bloomState.enabled === 'boolean') {
      this._setBloomEnabled(bloomState.enabled);
    }

    const sharpenState = state.sharpen || {};
    if (typeof sharpenState.intensity === 'number' && this._sharpenSlider) {
      const pct = Math.max(0, Math.min(100, Math.round(sharpenState.intensity)));
      this._sharpenSlider.value = String(pct);
      this._sharpenSliderValue.textContent = `${pct}%`;
      this._applySharpenIntensity(pct / 100);
    }
    if (typeof sharpenState.enabled === 'boolean') {
      this._setSharpenEnabled(sharpenState.enabled);
    }

    const hudState = state.hud || {};
    if (hudState.variant) {
      this._setHudVariant(hudState.variant);
    }
    if (typeof hudState.visible === 'boolean') {
      this.hud.setMode(hudState.visible ? 'on' : 'off');
      this._updateHudButtonState();
    }

    const scopeState = state.scope || {};
    if (typeof scopeState.enabled === 'boolean') {
      setScopeMaskEnabled(scopeState.enabled);
      this._scopeBtn?.classList.toggle('active', scopeState.enabled);
      this._scopeBtn?.setAttribute('aria-pressed', String(scopeState.enabled));
    }
    if (typeof scopeState.featherPct === 'number' && this._scopeFeatherSlider) {
      const pct = Math.max(0, Math.min(100, Math.round(scopeState.featherPct)));
      this._scopeFeatherSlider.value = String(pct);
      if (this._scopeFeatherValue) this._scopeFeatherValue.textContent = `${pct}%`;
      setScopeMaskFeather(pct / 100);
    }

    const detectionState = state.detection || {};
    if (typeof detectionState.density === 'number' && this._detectionDensitySlider) {
      const pct = canonicalizeDensity(detectionState.density);
      this._detectionDensitySlider.value = String(pct);
      if (this._detectionDensityValue) this._detectionDensityValue.textContent = `${pct}%`;
      this._applyDetectionDensityFromUi();
    }
    if (detectionState.allocation) {
      this._setDetectionAllocation(detectionState.allocation, { syncShare: false });
    }
    if (typeof detectionState.fadePct === 'number' && this._detectionFadeSlider) {
      this._detectionFadeSlider.value = String(detectionState.fadePct);
    }
    if (typeof detectionState.outsideOpacityPct === 'number' && this._detectionOpacitySlider) {
      this._detectionOpacitySlider.value = String(detectionState.outsideOpacityPct);
    }
    this._applyDetectionFadeFromUi();
    if (detectionState.mode) {
      this._setDetectionMode(detectionState.mode);
    }

    if (state.mapStack) {
      // The stack switch is itself a MUTATION, not merely a suspension point,
      // so it needs a gate on BOTH sides of the await.
      if (superseded()) return false;
      const stackBefore = this.mapStackController?.getActiveId?.() ?? null;
      const genBefore = this.mapStackController?.getSwitchGeneration?.() ?? null;

      await this._setMapStack(state.mapStack, { syncShare: false });

      if (superseded()) {
        // Superseded DURING the switch, which the pre-check above cannot catch
        // and which has already moved the globe. The controller only
        // invalidates a switch when another setStack() arrives, and a winning
        // state that omits `mapStack` never issues one — every normalized scene
        // shot omits it — so this stale globe would simply stand. Put back what
        // the winner inherited.
        const genAfter = this.mapStackController?.getSwitchGeneration?.() ?? null;
        // _setMapStack issues exactly one setStack(), which advances the
        // generation once, or not at all when the stack was unavailable and
        // nothing was mutated. Anything past that is a NEWER switch whose
        // caller owns the globe now, and reverting would stomp a live intent.
        const globeIsStillOurs = genBefore !== null && genAfter !== null
          && genAfter <= genBefore + 1;
        const landed = this.mapStackController?.getActiveId?.() ?? null;
        if (globeIsStillOurs && stackBefore && landed !== stackBefore) {
          await this._setMapStack(stackBefore, { syncShare: false });
        }
        return false;
      }
      // Everything below is the uniform commit, already past its own gate.
    }

    if (state.styleParams && typeof state.styleParams === 'object') {
      for (const [styleName, params] of Object.entries(state.styleParams)) {
        const stage = this.stages[styleName];
        if (!stage || !params) continue;
        for (const [uniformName, uniformValue] of Object.entries(params)) {
          if (stage.uniforms[uniformName] === undefined) continue;
          stage.uniforms[uniformName] = uniformValue;
        }
      }
      this._updateSliderPanel(this.activeStyle);
    }

    this._syncShareState();
    return true;
  }

  /**
   * Resets the safe-frame overlay to its inactive state on init.
   * @returns {void}
   */
  _initRecordingOverlay() {
    if (!this._safeFrameOverlay || !this._safeFrameBox) return;
    this._safeFrameOverlay.classList.remove('active', 'ratio-9-16', 'ratio-16-9');
  }

  /**
   * Applies recording-friendly post-processing and shader uniform overrides.
   * @param {object} preset
   */
  applyCinematicPreset(preset = {}) {
    const bloomInput = typeof preset.bloom === 'object' ? preset.bloom : { intensity: preset.bloom };
    let decodedBloomIntensity = null;
    if (typeof bloomInput.intensity === 'number') {
      decodedBloomIntensity = decodeBloomIntensity(
        bloomInput.intensity,
        bloomInput.version ?? preset.bloomVersion ?? BLOOM_SCALE_VERSION
      );
      this._setBloomIntensity(decodedBloomIntensity, { syncShare: false });
    }
    if (typeof bloomInput.enabled === 'boolean') {
      this._setBloomEnabled(bloomInput.enabled);
    } else if (typeof bloomInput.intensity === 'number') {
      this._setBloomEnabled((decodedBloomIntensity ?? this._getBloomIntensity()) > 0);
    }

    const sharpenInput = typeof preset.sharpen === 'object' ? preset.sharpen : { enabled: preset.sharpen };
    if (typeof sharpenInput.intensity === 'number' && this._sharpenSlider) {
      const sharpenPct = Math.max(0, Math.min(100, Math.round(sharpenInput.intensity)));
      this._sharpenSlider.value = String(sharpenPct);
      this._sharpenSliderValue.textContent = `${sharpenPct}%`;
      this._applySharpenIntensity(sharpenPct / 100);
    }
    if (typeof sharpenInput.enabled === 'boolean') {
      this._setSharpenEnabled(sharpenInput.enabled);
    } else if (typeof sharpenInput.intensity === 'number') {
      this._setSharpenEnabled(sharpenInput.intensity > 0);
    }

    if (preset.hudVariant) {
      this._setHudVariant(preset.hudVariant);
    }

    if (preset.detectionMode) {
      this._setDetectionMode(preset.detectionMode);
    }
    if (typeof preset.detectionDensity === 'number' && this._detectionDensitySlider) {
      const density = canonicalizeDensity(preset.detectionDensity);
      this._detectionDensitySlider.value = String(density);
      this._detectionDensityValue.textContent = `${density}%`;
      this._applyDetectionDensityFromUi();
    }
    if (preset.detectionAllocation) {
      this._setDetectionAllocation(preset.detectionAllocation, { syncShare: false });
    }

    if (preset.styleParams && typeof preset.styleParams === 'object') {
      for (const [styleName, params] of Object.entries(preset.styleParams)) {
        const stage = this.stages[styleName];
        if (!stage || !params || typeof params !== 'object') continue;
        for (const [uniformName, uniformValue] of Object.entries(params)) {
          if (stage.uniforms[uniformName] === undefined) continue;
          stage.uniforms[uniformName] = uniformValue;
        }
      }

      // Keep slider panel values in sync when updating the active style.
      this._updateSliderPanel(this.activeStyle);
    }

    this._syncShareState();
  }

  /**
   * Enters or exits recording mode. When active, hides UI chrome via a body class,
   * displays a safe-frame composition overlay (16:9 or 9:16), and switches
   * the HUD to the specified mode. Exiting restores the HUD mode and layout
   * variant that were active before recording started.
   * @param {boolean} enabled - Whether to enable recording mode.
   * @param {object} [options]
   * @param {boolean} [options.hidePanels=true] - Hide all panel chrome.
   * @param {string} [options.hudMode='minimal'] - HUD mode while recording ('off'|'minimal'|'full'|'auto').
   * @param {string} [options.safeFrame='16:9'] - Aspect ratio for the safe-frame overlay.
   * @returns {void}
   */
  setRecordingMode(enabled, options = {}) {
    const { hidePanels = true, hudMode = 'minimal', safeFrame = '16:9' } = options;
    this._recordingMode = !!enabled;
    this._recordingConfig = { hidePanels, hudMode, safeFrame };

    document.body.classList.toggle('recording-mode', this._recordingMode && hidePanels);

    if (this._safeFrameOverlay) {
      this._safeFrameOverlay.classList.remove('ratio-9-16', 'ratio-16-9');
      this._safeFrameOverlay.classList.toggle('active', this._recordingMode);
      this._safeFrameOverlay.classList.add(safeFrame === '9:16' ? 'ratio-9-16' : 'ratio-16-9');
    }

    if (this._recordingMode) {
      // Snapshot the user's HUD state once per recording session so exit can
      // restore it (re-entrant calls must not capture mid-recording state).
      if (!this._preRecordingHudState) {
        this._preRecordingHudState = {
          mode: this.hud.getMode(),
          variant: this.hud.getVariant(),
        };
      }
      if (hudMode === 'off') {
        this.hud.setMode('off');
      } else if (hudMode === 'full' || hudMode === 'minimal') {
        this.hud.setMode('on');
        this.hud.setVariant(hudMode === 'minimal' ? 'minimal' : 'tactical');
        if (this._hudLayoutSelect) this._hudLayoutSelect.value = this.hud.getVariant();
      } else {
        this.hud.setMode('auto');
      }
    } else {
      const saved = this._preRecordingHudState;
      this._preRecordingHudState = null;
      if (saved) {
        this.hud.setVariant(saved.variant);
        if (this._hudLayoutSelect) this._hudLayoutSelect.value = this.hud.getVariant();
      }
      this.hud.setMode(saved ? saved.mode : 'auto');
      if (this._safeFrameOverlay) {
        this._safeFrameOverlay.classList.remove('active', 'ratio-9-16', 'ratio-16-9');
      }
    }
    this._hudBtn.classList.toggle('active', this.hud.visible);
    this._syncShareState();
  }

  // ── Parameter Sliders ─────────────────────────

  /**
   * Rebuilds the parameter slider panel for the given style's shader uniforms.
   * Creates a labeled range input for each tunable uniform. Hides the panel
   * for 'normal' mode which has no shader parameters.
   * @param {string} styleName - Style name whose uniforms to display.
   * @returns {void}
   */
  _updateSliderPanel(styleName, { reveal = false } = {}) {
    this._styleParameters ||= createStyleParameters({ container: this._sliderContainer });
    this._styleParameters.clear();
    const shader = STYLES[styleName];

    if (!shader || !shader.uniforms || styleName === 'normal') {
      this._sliderPanel.classList.remove('active');
      this._scheduleRightPanelLayout();
      return;
    }

    this._styleParameters.render({
      uniforms: shader.uniforms,
      readValue: (uName) => this.stages[styleName].uniforms[uName],
      writeValue: (uName, val) => {
        this.shareLinkManager?.claimRestoreLane?.('visual');
        this.stages[styleName].uniforms[uName] = val;
      },
      onChange: () => {
        // Uniform writes need an explicit render under the idle governor.
        governorRequestRender('style-param-slider');
        this._syncShareState();
      },
    });

    this._sliderPanel.classList.add('active');
    this._scheduleRightPanelLayout();
    if (reveal) this._revealStyleParameters();
  }

  /** Reveal the map-only parameter surface in the standard Display scroll owner. */
  _revealStyleParameters() {
    if (!this._sliderPanel?.classList.contains('active')) return;
    if (this._cockpitDisplayPortalActive) return;
    this._sliderPanel.classList.remove('collapsed');
    this._syncPanelCollapseButton(this._sliderPanel);
    this.setPanelCollapsed('pp-toggles', false, { explicit: true });
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const scrollOwner = this._ppToggles;
      if (!scrollOwner) return;
      const ownerRect = scrollOwner.getBoundingClientRect();
      const panelRect = this._sliderPanel.getBoundingClientRect();
      scrollOwner.scrollTop += panelRect.top - ownerRect.top - 8;
    }));
  }

  // ── Style switching ───────────────────────────

  /**
   * Switches the active visual style. Handles full lifecycle:
   * 1. Crossfades the previous shader stage intensity to 0.
   * 2. Crossfades the new shader stage intensity to 1.
   * 3. Applies style preset defaults (bloom/sharpen/HUD) if applyPreset is true.
   * 4. Updates button highlights, style indicator, slider panel, HUD, and detection overlay.
   * @param {string} styleName - Target style ('normal'|'retro'|'surveillance'|'thermal'|'anime'|'noir'|'snow').
   * @param {object} [options]
   * @param {boolean} [options.applyPreset=true] - Whether to apply STYLE_PRESET_DEFAULTS for the new style.
   * @returns {void}
   */
  setStyle(styleName, {
    applyPreset = true,
    revealParameters = applyPreset,
    restore = false,
  } = {}) {
    if (!restore) this.shareLinkManager?.claimRestoreLane?.('visual');
    if (styleName === this.activeStyle) {
      if (revealParameters && styleName !== 'normal') this._revealStyleParameters();
      return;
    }

    const previousStyle = this.activeStyle;
    this.activeStyle = styleName;
    document.documentElement.dataset.gevStyle = styleName;

    // The celestial optics treatment belongs to the unfiltered globe only.
    // Leaving Normal turns it off; returning merely re-enables the control.
    this.setCelestialRingEnabled(false, { syncShare: false, focus: false });

    // Transition out the previous shader style
    if (previousStyle !== 'normal' && this.stages[previousStyle]) {
      this._startTransition(previousStyle, this.stages[previousStyle].uniforms.intensity, 0.0);
    }

    // Transition in the new shader style
    if (styleName !== 'normal' && this.stages[styleName]) {
      this._startTransition(styleName, this.stages[styleName].uniforms.intensity, 1.0);
    }

    if (applyPreset) {
      this._applyStylePresetDefaults(styleName);
    }

    // Update button UI
    document.querySelectorAll('.style-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.style === styleName);
    });

    // Update style indicator
    const displayNames = { surveillance: 'NVG', thermal: 'FLIR', retro: 'CRT' };
    this._styleIndicator.textContent = displayNames[styleName] || styleName.toUpperCase();
    this._updateStyleMiniStatus(styleName);

    // Update parameter sliders
    this._updateSliderPanel(styleName, { reveal: revealParameters });

    // Notify HUD (color adaptation + auto show/hide)
    this.hud.onStyleChange(styleName);
    this._updateHudButtonState();

    // Sync detection overlay tone to active post-process style
    setDetectionStyle(styleName);
    this._syncIrBoost();
    window.dispatchEvent(new CustomEvent('gev:style-change', {
      detail: { style: styleName },
    }));

    this._syncCockpitInheritedStyle();

    // Notify share link manager
    this.shareLinkManager.onStyleChange(styleName);
    this._syncShareState();
  }

  // ── Shader transitions ────────────────────────

  /**
   * Enqueues a smooth intensity transition for a shader stage. The animation
   * loop interpolates from `fromValue` to `toValue` over TRANSITION_DURATION_MS.
   * @param {string} styleName - Name of the shader stage to transition.
   * @param {number} fromValue - Starting intensity (typically current value).
   * @param {number} toValue - Target intensity (0.0 to fade out, 1.0 to fade in).
   * @returns {void}
   */
  _startTransition(styleName, fromValue, toValue) {
    this._visualEffects.startTransition(styleName, fromValue, toValue);
  }

  /**
   * Sample the manager's layer set and paint the global loading chip.
   * Driven by manager events AND by a ticker, because the underlying state
   * machine is TIME-driven (reveal delay, long-load threshold, terminal
   * dwell) — see _armLoadingFeedbackTicker.
   * @param {number} [now] - performance.now() sample.
   * @returns {void}
   */
  _updateGlobalLoadingFeedback(now = performance.now()) {
    if (!this._globalLoadingStatus) return;
    const summary = aggregateLayerLoading(this._dataManager?.getAll?.() || []);
    this._loadingFeedbackState = reduceLoadingFeedback(
      this._loadingFeedbackState,
      summary,
      now,
      this._loadingFeedbackEvent,
    );
    this._loadingFeedbackEvent = null;
    const presentation = presentGlobalLoadingStatus(
      this._globalStatusNotice,
      this._loadingFeedbackState,
      summary,
      now,
    );
    if (this._globalStatusNotice?.persistent !== true
        && Number.isFinite(this._globalStatusNotice?.hideAt)
        && now >= this._globalStatusNotice.hideAt) {
      this._globalStatusNotice = null;
    }
    // Loading phases and universal notices both have time-driven transitions.
    // Compute this after arbitration: a queued finite notice starts its dwell
    // only on its first visible frame, then keeps the ticker alive to expiry.
    const noticeNeedsTicker = Number.isFinite(this._globalStatusNotice?.hideAt);
    if (this._loadingFeedbackState?.phase !== 'idle' || noticeNeedsTicker) {
      this._armLoadingFeedbackTicker();
    }
    this._globalLoadingStatus.hidden = !presentation;
    if (!presentation) {
      delete this._globalLoadingStatus.dataset.state;
      return;
    }
    this._globalLoadingStatus.dataset.state = presentation.state;
    // Split-flap the LABEL only ("LOADING LIVE DATA" -> "LOAD COMPLETE").
    // setSplitFlapText is a no-op when the text is unchanged, which matters
    // here: this runs on every 60 ms and 500 ms tick. The detail line is the
    // live layer roster inside an ellipsised, width-capped span — flapping a
    // list that churns as layers join would be noise, not delight.
    setSplitFlapText(this._globalLoadingLabel, presentation.label);
    this._globalLoadingDetail.textContent = presentation.detail;
  }

  /** Show a message in the universal top-center status banner. */
  _showGlobalStatusNotice(message, options = {}) {
    const now = performance.now();
    this._globalStatusNotice = createGlobalStatusNotice(message, now, options);
    this._updateGlobalLoadingFeedback(now);
  }

  /**
   * Style animation loop — self-stopping (perf wave 2). Runs only while a
   * crossfade is in flight or an animated (time-uniform) stage is visible,
   * holding continuous scene render for exactly that long. Re-armed by
   * _startTransition and by _setStageIntensity enabling an animated stage.
   * The traffic sync chip no longer rides this loop — it has its own 500 ms
   * interval (see _startTrafficChipTicker).
   */
  _startAnimationLoop() {
    this._visualEffects.startAnimationLoop();
  }

  /**
   * 500 ms DOM ticker for the traffic sync chip (was per-frame). It also
   * polls the loading chip as a safety net: a camera-driven layer can flip
   * its own `stats.loading` without emitting a manager event, and that is
   * the one loading start the event path cannot see.
   */
  _startTrafficChipTicker() {
    if (this._trafficChipTicker) return;
    this._trafficChipTicker = setInterval(() => {
      if (document.hidden) return;
      this._updateTrafficSyncChip();
      this._updateGlobalLoadingFeedback();
    }, 500);
  }

  /**
   * Self-stopping 60 ms ticker for the global loading chip.
   *
   * The chip used to ride the style rAF loop, which perf wave 2 made
   * self-stopping — leaving the chip frozen mid-state whenever no crossfade
   * or animated shader was running (it would never reveal, never cross the
   * long-load threshold, and never dwell out). Its reducer
   * (src/loadingFeedback.js) is time-driven, so it needs real ticks; it is
   * also pure DOM, so it takes NO governor hold and requests no render.
   * Armed by _updateGlobalLoadingFeedback whenever loading leaves idle or a
   * universal notice begins, and stops once both have settled.
   * (rebase 2026-08-16: main's loading chip vs wave 2's stopped loop)
   * @returns {void}
   */
  _armLoadingFeedbackTicker() {
    // Never arm behind a hidden tab: the reducer cannot usefully advance a
    // chip nobody can see, and the old `return` INSIDE the interval left the
    // 60ms timer scheduled for the entire hidden period (a batch completing
    // while hidden could never clear it — the idle check sat behind the
    // hidden guard). visibilitychange resamples and re-arms on return.
    if (this._loadingFeedbackTicker || document.hidden) return;
    this._loadingFeedbackTicker = setInterval(() => {
      if (document.hidden) {
        this._stopLoadingFeedbackTicker();
        return;
      }
      const now = performance.now();
      this._lastLoadingFeedbackUpdateAt = now;
      this._updateGlobalLoadingFeedback(now);
      const noticeNeedsTicker = Number.isFinite(this._globalStatusNotice?.hideAt);
      if (this._loadingFeedbackState?.phase === 'idle' && !noticeNeedsTicker) {
        this._stopLoadingFeedbackTicker();
      }
    }, 60);
  }

  /** Stop the loading-chip ticker if it is running. Idempotent. */
  _stopLoadingFeedbackTicker() {
    if (!this._loadingFeedbackTicker) return;
    clearInterval(this._loadingFeedbackTicker);
    this._loadingFeedbackTicker = null;
  }

  // ── Location Bar ─────────────────────────────

  /**
   * Initializes the location bar: renders city pills from CITY_POIS, sets up
   * QWERTY keyboard navigation for POI selection, wires the search toggle
   * and geocoding search input.
   * @returns {void}
   */
  _initLocationBar() {
    this._locationControls?.destroy();
    this._locationLookup?.destroy();
    this._locationLookup = new LocationSearch({
      input: this._locationSearch,
      begin: () => this._beginDeferredNavigation('location'),
      isCurrent: (generation) => !this._disposed && generation === this._navigationGeneration,
      beforeFly: (generation) => this._reassertNavigationHandoff(generation),
      search: (query, options) => searchAndFlyTo(this.viewer, query, {
        placeSearch: this.placeSearch,
        ...options,
      }),
      onStart: (generation) => { this._activeLocationSearchGeneration = generation; },
      onResult: (destination, query) => {
        this._searchedLocationLabel = destination.label || query;
        this._setActiveLocation(null);
        this._currentPoi = null;
        this._collapsePOIRow();
        this._updateLocationMiniStatus();
      },
      onMissing: () => this._showToast('Location not found'),
      onError: (error) => {
        console.error('[Search] Geocoding failed:', error);
        this._showToast('Search failed');
      },
      onSettled: (generation) => this._settleLocationSearchUi(generation),
    });
    this._locationControls = new LocationControls({
      elements: {
        pills: this._locationPills, poiRow: this._poiRow, divider: this._locationBarDivider,
        search: this._locationSearch, searchToggle: this._searchToggle,
        resetButtons: [this._resetGlobeBtn, this._cockpitResetGlobeBtn],
        statusCity: this._locationMiniCity, statusPoi: this._locationMiniPoi,
      },
      cities: CITY_POIS,
      getExpandedCity: () => this._expandedCityId,
      onCity: (id) => this._onCityPillClick(id),
      onPoi: (id, index) => this._onPoiClick(id, index),
      onSearch: (query) => this._locationLookup.run(query),
      onReset: () => this.resetToGlobeView(),
    });
  }

  /**
   * Signals the start of an inter-city world jump: notifies the traffic layer
   * to pause tile fetching and suspends detection overlays to prevent stale
   * rendering during the flight.
   * @returns {void}
   */
  _beginWorldJumpTransition() {
    clearTimeout(this._trafficTransitionTimer);
    trafficLayer.beginWorldJump?.();
    suspendDetection('intercity');
  }

  /**
   * Signals the end of an inter-city world jump: resumes traffic tile fetching,
   * resumes detection overlays, and forces a traffic sync chip update.
   * @returns {void}
   */
  _endWorldJumpTransition() {
    clearTimeout(this._trafficTransitionTimer);
    trafficLayer.endWorldJump?.();
    resumeDetection();
    this._updateTrafficSyncChip(true);
  }

  /**
   * Wraps a fly-to action with world-jump transition hooks when the target
   * city differs from the current one. Applies begin/end transition signals
   * with a 5.2s safety timeout to guarantee cleanup if the flight callback
   * never fires onComplete.
   * @param {boolean} cityChanged - Whether the destination is in a different city.
   * @param {function} flyAction - Callback receiving `{onStart, onComplete}` hooks; should return a result with targetPosition.
   * @returns {*} Return value from flyAction.
   */
  _flyWithTransition(cityChanged, flyAction) {
    return this._runExplicitNavigation('location', () => {
      if (!cityChanged) return flyAction({});
      let completed = false;
      const finalize = () => {
        if (completed) return;
        completed = true;
        this._endWorldJumpTransition();
      };
      const result = flyAction({
        onStart: () => this._beginWorldJumpTransition(),
        onComplete: finalize,
      });
      this._trafficTransitionTimer = window.setTimeout(finalize, 5200);
      return result;
    });
  }

  /**
   * Release camera ownership when a resolved Location destination starts.
   * Contact mode and its selected subject remain intact so FOCUS can return to
   * that subject after the user finishes inspecting the destination.
   * @returns {boolean} Whether a Contact subject remains selected.
   */
  beginLocationNavigation() {
    this._stampNavigation();
    this.cockpitView?.exit({ restoreTracking: false });
    return this._releaseFollowCamera({ preserveVesselSelection: false });
  }

  /**
   * Handles a city pill click: toggles POI row collapse if same city,
   * otherwise expands the POI row, flies to the city's first POI, and
   * tracks the target position for orbit mode.
   * @param {string} cityId - Identifier of the clicked city.
   * @returns {void}
   */
  _onCityPillClick(cityId) {
    if (this._expandedCityId === cityId) {
      // Same city clicked again — toggle collapse
      this._collapsePOIRow();
      return;
    }

    const isCityChanged = this._activeLocationId && this._activeLocationId !== cityId;
    const result = this._flyWithTransition(!!isCityChanged, (hooks) => flyToPresetLocation(this.viewer, cityId, hooks));
    if (result === false) return;
    this._expandPOIRow(cityId);
    this._setActiveLocation(cityId);
    this._activePoiIndex = 0;
    this._updatePoiHighlight();

    // Track current target + POI for orbit
    if (result) {
      this._currentTarget = result.targetPosition;
      this._currentPoi = CITY_POIS[cityId].pois[0];
    }
    this._updateLocationMiniStatus();
  }

  /**
   * Handles a POI pill click: stops orbit, flies to the POI, highlights it,
   * and saves the target position for future orbit activation.
   * @param {string} cityId - Parent city identifier.
   * @param {number} poiIndex - Index of the POI within the city's pois array.
   * @returns {void}
   */
  _onPoiClick(cityId, poiIndex) {
    const isCityChanged = this._activeLocationId && this._activeLocationId !== cityId;
    const result = this._flyWithTransition(!!isCityChanged, (hooks) => flyToPOI(this.viewer, cityId, poiIndex, hooks));
    if (result === false) return;
    this._setActiveLocation(cityId);
    this._activePoiIndex = poiIndex;
    this._updatePoiHighlight();

    // Track current target + POI for orbit
    if (result) {
      this._currentTarget = result.targetPosition;
      this._currentPoi = CITY_POIS[cityId].pois[poiIndex];
    }
    this._updateLocationMiniStatus();
  }

  /**
   * Builds and shows the POI pill row for a city. Each pill displays a
   * QWERTY keyboard shortcut key and the POI name.
   * @param {string} cityId - City whose POIs to render.
   * @returns {void}
   */
  _expandPOIRow(cityId) {
    if (!CITY_POIS[cityId]) return;
    this._expandedCityId = cityId;
    this._locationControls.showPois(cityId);
  }

  /**
   * Hides the POI pill row and clears the expanded city state.
   * @returns {void}
   */
  _collapsePOIRow() {
    this._expandedCityId = null;
    this._activePoiIndex = null;
    this._locationControls.hidePois();
  }

  /**
   * Highlights the active POI pill and removes highlight from all others.
   * @returns {void}
   */
  _updatePoiHighlight() {
    this._locationControls.highlightPoi(this._activePoiIndex);
  }

  /**
   * Forget the last free-text search destination and repaint the LOCATION
   * readout. Public so camera owners that fly on their own — scene playback
   * most of all — can invalidate it without reaching into private state.
   * @returns {void}
   */
  clearSearchedLocation() {
    if (this._searchedLocationLabel === null) return;
    this._searchedLocationLabel = null;
    this._updateLocationMiniStatus();
  }

  /**
   * Sets the active city location, highlights its pill, and updates the mini-status readout.
   * @param {string|null} locationId - City identifier, or null to clear.
   * @returns {void}
   */
  _setActiveLocation(locationId) {
    this._activeLocationId = locationId;
    // A preset city is now what the camera is framed on, so any earlier
    // free-text destination has been superseded. Clearing only on a real id
    // leaves the search path's own _setActiveLocation(null) untouched.
    if (locationId) this._searchedLocationLabel = null;
    this._locationControls?.highlightCity(locationId);
    this._updateLocationMiniStatus();
  }

  /**
   * Updates the collapsed mini-status readout with the current destination:
   * a preset city + POI/landmark, or the last free-text geocode search.
   * @returns {void}
   */
  _updateLocationMiniStatus() {
    this._locationControls?.renderStatus({
      city: this._activeLocationId ? CITY_POIS[this._activeLocationId] : null,
      currentPoi: this._currentPoi,
      searchedLabel: this._searchedLocationLabel,
    });
  }

  /**
   * Updates the collapsed mini-status readout with the active style label.
   * @param {string} [styleName=this.activeStyle] - Style name to display.
   * @returns {void}
   */
  _updateStyleMiniStatus(styleName = this.activeStyle) {
    if (!this._styleMiniValue) return;
    this._styleMiniValue.textContent = STYLE_STATUS_LABELS[styleName] || String(styleName || 'normal').toUpperCase();
  }

  // ── Orbit Mode ──────────────────────────────

  /**
   * Creates the orbit mode indicator DOM element and appends it to the body.
   * @returns {void}
   */
  _initOrbit() {
    this._orbitIndicator = this._locationControls.createOrbitIndicator();
  }

  /**
   * Toggles the orbit controller around the current POI target. Shows a toast
   * if no target position has been set (user must fly to a POI first).
   * @returns {void}
   */
  _toggleOrbit() {
    if (!this._currentTarget) {
      this._showToast('Fly to a POI first');
      return;
    }

    const isActive = this.orbitController.toggle(this._currentTarget, {
      radius: this._currentPoi?.alt || 500,
      pitch: this._currentPoi?.pitch || -30,
    });

    this._orbitIndicator.classList.toggle('active', isActive);
  }

  /**
   * Stops orbit mode if active and hides the orbit indicator.
   * @returns {void}
   */
  _stopOrbit() {
    if (this.orbitController.active) {
      this.orbitController.stop();
      this._orbitIndicator.classList.remove('active');
    }
  }

  /** Wire the top-center action that clears only manager-owned data layers. */
  _initClearSelectedLayersButton() {
    if (!this._clearSelectedLayersBtn) return;
    this._clearLayersControl?.destroy();
    this._clearLayersControl = bindClearLayersControl(this._clearSelectedLayersBtn, () => this.clearSelectedLayers());
  }

  /**
   * Clear every selected data layer without resetting visual, map, HUD, or
   * camera state. A layer may still release camera work it owns as part of its
   * established disable lifecycle.
   * @returns {Promise<object>} Aggregate manager lifecycle truth for the batch.
   */
  clearSelectedLayers(...args) { return this._contextControls?.clearSelectedLayers(...args); }

  /**
   * Release every camera owner and return to the canonical full-globe frame.
   * Repeated requests adopt the in-flight reset rather than cancelling it.
   * @returns {Promise<object>} Canonical reset result shared with voice.
   */
  resetToGlobeView() {
    if (this._globeResetPromise) return this._globeResetPromise;
    this._stampNavigation();
    interruptCameraMotion('reset-globe');
    this._stopOrbit();
    this.cockpitView?.exit({ restoreTracking: false });
    try {
      militaryAwarenessLayer.releaseCameraOwnership?.({ origin: 'tool' });
    } catch {
      // Keep reset available if Context has not initialized completely.
      try { flightsLayer.stopTracking?.({ origin: 'tool' }); } catch { /* best-effort release */ }
      try { militaryFlightsLayer.stopTracking?.({ origin: 'tool' }); } catch { /* best-effort release */ }
      try { aisLiveVesselsLayer.clearSelection?.(); } catch { /* best-effort release */ }
    }
    try { satellitesLayer.stopTracking?.({ origin: 'tool' }); } catch { /* best-effort release */ }
    try { rocketLaunchesLayer.releaseCameraOwnership?.(); } catch { /* best-effort release */ }
    this.viewer.trackedEntity = undefined;
    this.viewer.camera.cancelFlight();
    this.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    this._beginWorldJumpTransition();

    let resolveReset;
    const resetPromise = new Promise((resolve) => { resolveReset = resolve; });
    this._globeResetPromise = resetPromise;
    let settled = false;
    let timer = null;
    const finish = (cancelled = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this._endWorldJumpTransition();
      const carto = this.viewer.camera.positionCartographic;
      const result = {
        ok: !cancelled,
        action: 'zoom_to_globe',
        cancelled,
        heightKm: Math.round(GLOBE_VIEW.heightM / 1000),
        centeredOn: {
          latitude: Number(Cesium.Math.toDegrees(carto.latitude).toFixed(2)),
          longitude: Number(Cesium.Math.toDegrees(carto.longitude).toFixed(2)),
        },
      };
      this._resetGlobeBtn?.setAttribute('aria-label', 'Reset to full globe view');
      this._cockpitResetGlobeBtn?.setAttribute('aria-label', 'Reset cockpit to full globe view');
      this._globeResetPromise = null;
      resolveReset(result);
    };
    timer = window.setTimeout(() => {
      const height = this.viewer.camera.positionCartographic?.height;
      finish(!Number.isFinite(height) || Math.abs(height - GLOBE_VIEW.heightM) > 1000);
    }, 4200);
    this._resetGlobeBtn?.setAttribute('aria-label', 'Resetting to full globe view');
    this._cockpitResetGlobeBtn?.setAttribute('aria-label', 'Resetting cockpit to full globe view');
    const target = flyToGlobeView(this.viewer, {
      onComplete: () => finish(false),
      onCancel: () => finish(true),
    });
    if (!target) finish(true);
    return resetPromise;
  }

  // ── Share Button ─────────────────────────────

  /**
   * Wires the share button click to copy the current share link to the clipboard.
   * @returns {void}
   */
  _initShareButton() {
    this._shareBtn.addEventListener('click', async () => {
      const success = await this.shareLinkManager.copyLink();
      this._showToast(success ? 'Link copied!' : 'Copy failed');
    });
  }

  /**
   * Displays a temporary toast notification for 2 seconds.
   * @param {string} message - Text to show in the toast.
   * @returns {void}
   */
  _showToast(message) {
    this._toast.textContent = message;
    this._toast.classList.add('visible');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      this._toast.classList.remove('visible');
    }, 2000);
  }

  // ── HUD Toggle ───────────────────────────────

  /**
   * Wires the HUD toggle button, initializes the default HUD variant to 'tactical',
   * and sets up the detection mode cycle button.
   * @returns {void}
   */
  /**
   * Wires the DISPLAY-rail "3D" toggle to the flights layer's `models3d` param.
   * ON by default in `proximity` mode (owner directive 2026-08-22): the fleet
   * renders as 3D glTF models once the camera is zoomed in past the layer's
   * altitude ceiling, and only the nearest MODEL_MAX in view are admitted, so
   * the default costs nothing at globe scale. `all` is the deliberate opt-in;
   * turning the toggle off returns the fleet to flat billboards. The TRACKED
   * contact is independent of this toggle (see trackedModelRegime.js).
   * @returns {void}
   */
  /** One 3D toggle drives BOTH aircraft layers (commercial + military) so all planes flip together. */
  _setModels3dParams(params, { origin = 'user' } = {}) {
    this._dataManager?.setLayerParams('flights', params, { origin });
    this._dataManager?.setLayerParams('military', params, { origin });
  }

  _syncModels3dFromLayerState(state) {
    const options = state?.options?.flights;
    if (!options) return;
    this._models3dEnabled = options.models3d === true;
    this._models3dMode = options.models3dMode === 'all' ? 'all' : 'proximity';
    this._syncModels3dButtonState();
    this._models3dModeRow?.classList.toggle('visible', this._models3dEnabled);
    for (const button of this._models3dModeBtns || []) {
      if (!button) continue;
      const active = button.dataset.mode === this._models3dMode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-checked', String(active));
    }
    this._layoutRightPanels();
  }

  _syncModels3dModeRow() {
    if (this._models3dModeRow) this._models3dModeRow.classList.toggle('visible', this._models3dEnabled);
    this._layoutRightPanels();
  }

  _initModels3dToggle() {
    if (!this._models3dBtn) return;
    this._syncModels3dButtonState();
    this._syncModels3dModeRow();
  }

  _setModels3dEnabled(enabled) {
    this._models3dEnabled = !!enabled;
    this._setModels3dParams({ models3d: this._models3dEnabled });
    this._syncModels3dButtonState();
  }

  _setModels3dMode(mode) {
    const normalized = mode === 'all' ? 'all' : 'proximity';
    this._models3dMode = normalized;
    this._setModels3dParams({ models3dMode: normalized });
    for (const button of this._models3dModeBtns) {
      if (!button) continue;
      const active = button.dataset.mode === normalized;
      button.classList.toggle('active', active);
      button.setAttribute('aria-checked', String(active));
    }
    this._syncModels3dButtonState();
  }

  _syncModels3dButtonState() {
    this._models3dBtn?.classList.toggle('active', this._models3dEnabled);
    // The lit/dark state is a colour to a sighted operator and nothing at all to
    // a screen reader without this. It matters more now that the button ships
    // ACTIVE from markup (default-on, 2026-08-22): the very first thing assistive
    // tech reported was an unpressed-looking control over an armed layer.
    // Mirrors #scope-toggle, which has always carried aria-pressed.
    this._models3dBtn?.setAttribute('aria-pressed', String(this._models3dEnabled));
  }

  _initHUDToggle() {
    if (this._hudLayoutSelect) {
      this._hudLayoutSelect.value = 'tactical';
    }
    this._setHudVariant('tactical');
    this.hud.setMode('on');
    this._updateHudButtonState();

    this._cockpitDisplayToggleBtn?.addEventListener('click', () => {
      const open = this._cockpitDisplayToggleBtn.getAttribute('aria-expanded') === 'true';
      this._setCockpitDisclosure?.('display', !open);
    });
    this._initCockpitDisplayPortal();
  }

  /**
   * Reuses the production Display controls inside Cockpit without cloning
   * stateful inputs or event listeners. Comment anchors preserve each group's
   * exact home in the standard Display panel for exit and teardown.
   * @returns {void}
   */
  _initCockpitDisplayPortal() {
    const definitions = [
      ['hud', this._hudBtn?.closest('.pp-toggle-group')],
      ['detection', this._detectionBtn?.closest('.pp-toggle-group')],
      ['parameters', this._sliderPanel],
      ['models3d', this._models3dBtn?.closest('.pp-toggle-group')],
    ];
    this._cockpitDisplayPortalRecords = definitions.flatMap(([name, group]) => {
      const slot = this._cockpitDisplayPanel?.querySelector(
        `[data-cockpit-display-slot="${name}"]`,
      );
      if (!group || !slot || !group.parentNode) return [];
      const anchor = document.createComment(`cockpit-display-home:${name}`);
      group.before(anchor);
      return [{ name, group, slot, anchor }];
    });
    this._standardDisplayScrollTop = this._ppToggles?.scrollTop || 0;
    this._cockpitDisplayScrollTop = this._cockpitDisplayPanel?.scrollTop || 0;
    this._standardDisplayScrollHandler = () => {
      if (!this._cockpitDisplayPortalActive) {
        this._standardDisplayScrollTop = this._ppToggles?.scrollTop || 0;
      }
    };
    this._cockpitDisplayScrollHandler = () => {
      if (this._cockpitDisplayPortalActive) {
        this._cockpitDisplayScrollTop = this._cockpitDisplayPanel?.scrollTop || 0;
      }
    };
    this._ppToggles?.addEventListener('scroll', this._standardDisplayScrollHandler, { passive: true });
    this._cockpitDisplayPanel?.addEventListener('scroll', this._cockpitDisplayScrollHandler, { passive: true });
    this._cockpitDisplayModeHandler = (event) => {
      this._setCockpitDisplayPortalActive(event?.detail?.active === true);
    };
    window.addEventListener('gev:cockpit-mode-changed', this._cockpitDisplayModeHandler);
    this._setCockpitDisplayPortalActive(document.body.classList.contains('cockpit-mode'));
  }

  /**
   * Moves the shared HUD, Detection, Parameters, and 3D controls into or out
   * of Cockpit.
   * @param {boolean} active Whether Cockpit owns the Display control groups.
   * @returns {void}
   */
  _setCockpitDisplayPortalActive(active) {
    const nextActive = active === true;
    if (this._cockpitDisplayPortalActive === nextActive) return;
    const focusedRecord = this._cockpitDisplayPortalRecords.find((record) => (
      record.group.contains(document.activeElement)
    ));
    const focusedElement = focusedRecord ? document.activeElement : null;
    this._displayPortalScrollRestoreOwner = nextActive ? 'cockpit' : 'standard';
    this._cockpitDisplayPortalActive = nextActive;
    for (const record of this._cockpitDisplayPortalRecords) {
      if (nextActive) {
        record.slot.append(record.group);
      } else if (record.anchor.parentNode) {
        record.anchor.after(record.group);
      }
    }
    this._cockpitDisplayPanel?.classList.toggle('uses-shared-display-controls', nextActive);
    requestAnimationFrame(() => {
      if (nextActive && this._cockpitDisplayPanel) {
        this._cockpitDisplayPanel.scrollTop = this._cockpitDisplayScrollTop;
      }
      if (!nextActive && this._ppToggles) {
        this._ppToggles.scrollTop = this._standardDisplayScrollTop;
      }
      focusedElement?.focus?.({ preventScroll: true });
      // Portal movement can trigger one more adaptive-layout/clamp pass after
      // the first frame. Reapply the owning surface's saved position once the
      // new layout has fully settled.
      requestAnimationFrame(() => {
        if (nextActive && this._cockpitDisplayPanel) {
          this._cockpitDisplayPanel.scrollTop = this._cockpitDisplayScrollTop;
        }
        if (!nextActive && this._ppToggles) {
          this._ppToggles.scrollTop = this._standardDisplayScrollTop;
        }
        if (this._displayPortalScrollRestoreOwner === (nextActive ? 'cockpit' : 'standard')) {
          this._displayPortalScrollRestoreOwner = null;
        }
      });
    });
    this._layoutRightPanels();
    this.cockpitView?.scheduleContextLayout();
  }

  /**
   * Syncs the HUD toggle button active class and HUD layout row visibility
   * with the current HUD visible state.
   * @returns {void}
   */
  _updateHudButtonState() {
    this._hudBtn.classList.toggle('active', this.hud.visible);
    if (this._hudLayoutRow) {
      this._hudLayoutRow.classList.toggle('visible', this.hud.visible);
    }
    this._scheduleAdaptivePanelLayout({ settle: true });
  }

  /**
   * Updates the detection toggle button label and CSS classes to reflect
   * the current density-derived profile. Also toggles the density and
   * allocation controls together.
   * @param {string} modeLabel - Current detection mode label.
   * @returns {void}
   */
  _updateDetectionButton(modeLabel) {
    const btn = this._detectionBtn;
    const enabled = modeLabel !== 'OFF';
    btn.setAttribute('aria-pressed', String(enabled));
    btn.setAttribute('aria-label', enabled
      ? `Detection overlay: ${String(modeLabel).toLowerCase()}`
      : 'Detection overlay: off');
    btn.classList.remove('active', 'god', 'panoptic');
    if (modeLabel === 'SPARSE') {
      btn.querySelector('.pp-label').textContent = 'SPARSE';
      btn.classList.add('active');
    } else if (modeLabel === 'BALANCED') {
      btn.querySelector('.pp-label').textContent = 'BALANCED';
      btn.classList.add('active');
    } else if (modeLabel === 'DENSE') {
      btn.querySelector('.pp-label').textContent = 'DENSE';
      btn.classList.add('active', 'panoptic');
    } else {
      btn.querySelector('.pp-label').textContent = 'DETECT';
    }

    if (this._detectionSliderRow) {
      this._detectionSliderRow.classList.toggle('visible', modeLabel !== 'OFF');
    }
    if (this._detectionAllocationRow) {
      this._detectionAllocationRow.classList.toggle('visible', modeLabel !== 'OFF');
    }
    if (this._detectionFadeRow) {
      this._detectionFadeRow.classList.toggle('visible', modeLabel !== 'OFF');
    }
    if (this._detectionOpacityRow) {
      this._detectionOpacityRow.classList.toggle('visible', modeLabel !== 'OFF');
    }
    this._layoutRightPanels();
  }

  /**
   * Positions the parameter slider panel directly below the right-rail toggle
   * panel, right-aligned to it. Clamps to viewport bounds to prevent overflow.
   * Runs inside a rAF to batch with other layout reads.
   * @returns {void}
   */
  _layoutRightPanels() {
    this._scheduleRightPanelLayout();
  }

  /**
   * Recalculates the CCTV panel max-height based on its current top position
   * and the window height, enabling internal scroll without viewport overflow.
   * @returns {void}
   */
  _syncCctvPanelViewport() {
    if (!this._cctvPanel) return;
    const inner = this._cctvPanel.querySelector('.cctv-panel-inner');
    requestAnimationFrame(() => {
      if (this._cctvPanel.parentElement?.id === 'right-context-rail') {
        this._cctvPanel.style.maxHeight = '';
        if (inner) inner.style.maxHeight = '';
        this._scheduleRightPanelLayout();
        return;
      }
      const rect = this._cctvPanel.getBoundingClientRect();
      const availableHeight = Math.max(190, Math.floor(window.innerHeight - rect.top - 12));
      this._cctvPanel.style.maxHeight = `${availableHeight}px`;
      if (inner) {
        inner.style.maxHeight = `${availableHeight}px`;
      }
    });
  }

  /** Whether a share link was used to load the page */
  get hasShareState() {
    return !!this._hasShareState;
  }

  /** Terminal result for the complete initial share restoration. */
  get initialRestorePromise() {
    return this._initialShareRestorePromise || Promise.resolve({ status: 'not-requested' });
  }

  _settleInitialShareRestore(result) {
    if (!this._resolveInitialShareRestore) return;
    const resolve = this._resolveInitialShareRestore;
    this._resolveInitialShareRestore = null;
    resolve(result);
    window.dispatchEvent(new CustomEvent('gev:initial-share-restore-settled', { detail: result }));
  }

  /**
   * Tear down the StyleManager — cancel animation loop, clear intervals,
   * and release resources. Call this before discarding the instance to
   * prevent leaked rAF loops and event listeners.
   * @returns {Promise<void>} Resolves after focused-session state restoration.
   */
  async dispose() {
    if (this._disposed) return;
    this._shareTrackingNoticeGeneration += 1;
    this._shareTrackingAcquiringKey = null;
    this._globalStatusNotice = null;
    if (this._globalLoadingStatus) this._globalLoadingStatus.hidden = true;
    this._disposed = true;
    this._applicationShortcuts?.destroy();
    this._displayControls?.destroy();
    this._mapSourceControls?.destroy();
    this._clearLayersControl?.destroy();
    this._locationControls?.destroy();
    this._cctvControls?.destroy();
    this._radioControls?.destroy();
    this._visualEffects.stop();
    this._styleParameters?.destroy();
    for (const control of this._panelDisclosureControls || []) control.destroy();
    this._panelDisclosureControls = [];
    this._hoverPanelControls?.forEach((control) => control.destroy());
    this._hoverPanelControls?.clear();
    this._locationLookup?.destroy();
    this._cancelMapSourceFocus?.();
    // Revoke persistence/hash authority before teardown can emit manager changes.
    this._layerStateCoordinator?.destroy();
    this._layerStateCoordinator = null;
    this._layerStateRestorePromise = null;
    clearTimeout(this._initialShareRestoreTimeout);
    this._initialShareRestoreTimeout = null;
    this._settleInitialShareRestore({ status: 'destroyed', share: null, layers: [] });
    if (this._initialShareGestureHandler) {
      this.viewer?.canvas?.removeEventListener('pointerdown', this._initialShareGestureHandler);
      this.viewer?.canvas?.removeEventListener('wheel', this._initialShareGestureHandler);
      this._initialShareGestureHandler = null;
    }
    this.shareLinkManager?.destroy();
    if (this._awarenessSelectedHandler) {
      window.removeEventListener('gev:awareness-subject-selected', this._awarenessSelectedHandler);
      this._awarenessSelectedHandler = null;
    }
    if (this._awarenessClearedHandler) {
      window.removeEventListener('gev:awareness-subject-cleared', this._awarenessClearedHandler);
      this._awarenessClearedHandler = null;
    }

    // Invalidate any in-flight Context transaction the same way a newer request
    // would. Without this, a reinstatement already past its awaits could
    // re-enable a mode's entry layer and republish `_contextMode` while the
    // rest of teardown is tearing those very layers down.
    this._contextControls.stop();
    this._stampNavigation();
    // Close camera-entry seams synchronously. Context restoration may await
    // layer work, so leaving these listeners attached until afterward lets a
    // focus event release tracking or start a flight during teardown.
    this._removeCctvRequestFocusListener?.();
    this._removeCctvRequestFocusListener = null;
    this._cctvRequestFocusHandler = null;
    this._removeWorldRequestFocusListener?.();
    this._removeWorldRequestFocusListener = null;
    this._worldRequestFocusHandler = null;
    this._navigationOwnerChangedRemover?.();
    this._navigationOwnerChangedRemover = null;
    this._removeNavigationAuthorityListener?.();
    this._removeNavigationAuthorityListener = null;
    await this._contextControls.restoreForDisposal();
    // IR boost teardown BEFORE detaching the data manager: restore fog and
    // un-boost both aircraft layers so a surviving viewer or replacement
    // manager doesn't inherit sensor state (review P2, 2026-08-16).
    if (this._irBoostActive) {
      if (this._irFogWasEnabled != null && this.viewer?.scene?.fog) {
        this.viewer.scene.fog.enabled = this._irFogWasEnabled;
      }
      this._dataManager?.setLayerParams('flights', { irBoost: false });
      this._dataManager?.setLayerParams('military', { irBoost: false });
      this._irBoostActive = false;
      this._irFogWasEnabled = null;
    }
    this.cockpitView?.dispose();
    if (this._cockpitDisplayModeHandler) {
      window.removeEventListener('gev:cockpit-mode-changed', this._cockpitDisplayModeHandler);
      this._cockpitDisplayModeHandler = null;
    }
    this._setCockpitDisplayPortalActive(false);
    this._ppToggles?.removeEventListener('scroll', this._standardDisplayScrollHandler);
    this._cockpitDisplayPanel?.removeEventListener('scroll', this._cockpitDisplayScrollHandler);
    this._standardDisplayScrollHandler = null;
    this._cockpitDisplayScrollHandler = null;
    for (const record of this._cockpitDisplayPortalRecords) record.anchor.remove();
    this._cockpitDisplayPortalRecords = [];
    this._contextControls.disconnect();
    this._dataManagerUnsubscribe?.();
    this._dataManagerUnsubscribe = null;

    this._commandDockTrayObserver?.disconnect?.();
    this._commandDockTrayObserver = null;
    this._draggableResizeObserver?.disconnect();
    this._draggableResizeObserver = null;
    if (this._windowResizeHandler) {
      window.removeEventListener('resize', this._windowResizeHandler);
      this._windowResizeHandler = null;
    }
    if (this._loadingVisibilityHandler) {
      document.removeEventListener('visibilitychange', this._loadingVisibilityHandler);
      this._loadingVisibilityHandler = null;
    }
    this._stopLoadingFeedbackTicker();

    // Stop the independently owned traffic and loading feedback tickers.

    if (this._trafficChipTicker) {
      clearInterval(this._trafficChipTicker);
      this._trafficChipTicker = null;
    }
    if (this._loadingFeedbackTicker) {
      clearInterval(this._loadingFeedbackTicker);
      this._loadingFeedbackTicker = null;
    }
    if (this._leftStackLayoutFrame !== null) {
      cancelAnimationFrame(this._leftStackLayoutFrame);
      this._leftStackLayoutFrame = null;
    }
    if (this._rightStackLayoutFrame !== null) {
      cancelAnimationFrame(this._rightStackLayoutFrame);
      this._rightStackLayoutFrame = null;
    }
    clearTimeout(this._adaptivePanelSettleTimer);
    this._adaptivePanelSettleTimer = null;
    this._leftStackResizeObserver?.disconnect();
    this._leftStackResizeObserver = null;
    this._leftStackMutationObserver?.disconnect();
    this._leftStackMutationObserver = null;
    this._rightStackResizeObserver?.disconnect();
    this._rightStackResizeObserver = null;
    this._rightStackMutationObserver?.disconnect();
    this._rightStackMutationObserver = null;
    if (this._leftStackHudTransitionHandler) {
      document.getElementById('intel-hud')?.removeEventListener(
        'transitionend',
        this._leftStackHudTransitionHandler,
      );
      this._leftStackHudTransitionHandler = null;
    }
    if (this._rightStackHudTransitionHandler) {
      document.getElementById('intel-hud')?.removeEventListener(
        'transitionend',
        this._rightStackHudTransitionHandler,
      );
      this._rightStackHudTransitionHandler = null;
    }
    if (this._leftStackCockpitModeHandler) {
      window.removeEventListener('gev:cockpit-mode-changed', this._leftStackCockpitModeHandler);
      this._leftStackCockpitModeHandler = null;
    }

    destroyTrackedReadout();
    destroyDetection();
    destroyWorldOverlay();
    this._visualEffects.destroy();
  }
}
