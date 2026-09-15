import * as Cesium from 'cesium';
import {
  clearOverlaySource,
  setOverlayEntries,
} from '../overlays/worldOverlay.js';
import { governorRequestRender } from '../renderGovernor.js';
import {
  BHOTE_KOSHI_LOCATOR_CREDIT,
  registerDynamicCredit,
} from './dataCredits.js';
import { BHOTE_KOSHI_FLOOD_PATH } from './bhoteKoshiFloodPath.js';
import { INCIDENT_OVERVIEW_PLACES } from './bhoteKoshiIncidentPlaces.js';

export const BHOTE_KOSHI_LOCATOR_LAYER_ID = 'bhote-koshi-locator';
export const BHOTE_KOSHI_LOCATOR_OVERLAY_SOURCE_ID =
  'bhote-koshi-locator-callout';
export const NEPAL_CONTEXT_PRESENTATION = 'nepal-context';
export const BHOTE_KOSHI_REGIONAL_PRESENTATION = 'bhote-koshi-regional';
export const BHOTE_KOSHI_CITY_CONTEXT_PRESENTATION = 'bhote-koshi-city-context';
export const BHOTE_KOSHI_INCIDENT_PLACES_PRESENTATION =
  'bhote-koshi-incident-places';
export const BHOTE_KOSHI_FLOOD_PATH_PRESENTATION = 'bhote-koshi-flood-path';
export const BHOTE_KOSHI_PATH_OVERVIEW_PRESENTATION =
  'bhote-koshi-path-overview';
export const BHOTE_KOSHI_TRIGGER_RECORD_PRESENTATION =
  'bhote-koshi-trigger-record';

const LEGACY_PATH_BORDER_PRESENTATION = 'bhote-koshi-path-border';

const BORDER_DRAW_DURATION_MS = 2400;
const BORDER_START_DELAY_MS = 700;
const INCIDENT_CALLOUT_GAP_MS = 200;
const CALLOUT_REVEAL_DURATION_MS = 1200;
const CALLOUT_PULSE_DURATION_MS = 1800;
const CALLOUT_DOT_SIZE_PX = 7;
const CALLOUT_RING_MIN_SIZE_PX = 16;
const CALLOUT_RING_SIZE_RANGE_PX = 14;
const CITY_CALLOUT_START_DELAY_MS = 350;
const CITY_CALLOUT_STAGGER_MS = 220;
const CITY_CALLOUT_REVEAL_MS = 500;
const PLACE_CALLOUT_START_DELAY_MS = 350;
const PLACE_CALLOUT_STAGGER_MS = 650;
const PLACE_CALLOUT_REVEAL_MS = 520;
const FLOOD_PATH_START_DELAY_MS = 250;
const FLOOD_PATH_DRAW_DURATION_MS = 4000;
const TRIGGER_APPROACH_ARM_MS = 500;
const TRIGGER_APPROACH_DURATION_SEC = 4.6;
const TRIGGER_ORBIT_DURATION_SEC = 2.8;
const TRIGGER_SOURCE_URL =
  'https://earthquake.usgs.gov/earthquakes/eventpage/us7000tbwb/executive';

const INCIDENT = Object.freeze({
  lat: 28.3632333,
  lon: 85.4423639,
  heightM: 5200,
  title: 'BHOTE KOSHI FLOOD INCIDENT',
  subtitle: 'NEPAL · 26 AUG 2026',
});
const TRIGGER_RECORD = Object.freeze({
  lat: 28.271,
  lon: 85.515,
  heightM: 4200,
  title: 'USGS INITIAL REPORT',
  details: Object.freeze([
    '26 AUG 2026 · 08:37 NPT',
    '28.2710° N · 85.5150° E',
    'INITIAL M4.4 · RECLASSIFIED M5.2 LANDSLIDE',
    'USGS EVENT us7000tbwb · OPEN SOURCE',
  ]),
});
const TRIGGER_APPROACH_CAMERA = Object.freeze({
  lat: 28.368,
  lon: 85.473,
  alt: 10526,
  heading: 156,
  pitch: -44,
  roll: 0,
});
const TRIGGER_ORBIT_CAMERA = Object.freeze({
  lat: 28.3769,
  lon: 85.4923,
  alt: 10526,
  heading: 168,
  pitch: -44,
  roll: 0,
});
const NEPAL = Object.freeze({
  lat: 28.3949,
  lon: 84.124,
  heightM: 6800,
  title: 'NEPAL',
});
const NEARBY_CITIES = Object.freeze([
  Object.freeze({
    id: 'kathmandu',
    title: 'KATHMANDU',
    lat: 27.7017,
    lon: 85.3206,
    heightM: 3600,
    placement: 'left',
  }),
  Object.freeze({
    id: 'bhaktapur',
    title: 'BHAKTAPUR',
    lat: 27.673,
    lon: 85.43,
    heightM: 3400,
    placement: 'right',
  }),
  Object.freeze({
    id: 'dhulikhel',
    title: 'DHULIKHEL',
    lat: 27.6221,
    lon: 85.5428,
    heightM: 3600,
    placement: 'right-lower',
  }),
]);
const BORDER_COLOR = Cesium.Color.fromCssColorString('#20e7f2');
const BORDER_ACCENT = '#20e7f2';
const INCIDENT_ACCENT = '#ffad55';
const INCIDENT_COLOR = Cesium.Color.fromCssColorString(INCIDENT_ACCENT);

const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  clearSource: clearOverlaySource,
});

// Applications supply their boundary resolver; the layer has no server-route dependency.
const DEFAULT_BOUNDARY_RESOLVER = async () => null;

function abortError() {
  return new DOMException(
    'Bhote Koshi locator activation cancelled',
    'AbortError',
  );
}

function normalizePresentation(value) {
  if (value === NEPAL_CONTEXT_PRESENTATION) return NEPAL_CONTEXT_PRESENTATION;
  if (value === BHOTE_KOSHI_CITY_CONTEXT_PRESENTATION) {
    return BHOTE_KOSHI_CITY_CONTEXT_PRESENTATION;
  }
  if (value === BHOTE_KOSHI_INCIDENT_PLACES_PRESENTATION) {
    return BHOTE_KOSHI_INCIDENT_PLACES_PRESENTATION;
  }
  if (value === BHOTE_KOSHI_FLOOD_PATH_PRESENTATION) {
    return BHOTE_KOSHI_FLOOD_PATH_PRESENTATION;
  }
  if (
    value === BHOTE_KOSHI_PATH_OVERVIEW_PRESENTATION ||
    value === LEGACY_PATH_BORDER_PRESENTATION
  ) {
    return BHOTE_KOSHI_PATH_OVERVIEW_PRESENTATION;
  }
  if (value === BHOTE_KOSHI_TRIGGER_RECORD_PRESENTATION) {
    return BHOTE_KOSHI_TRIGGER_RECORD_PRESENTATION;
  }
  return BHOTE_KOSHI_REGIONAL_PRESENTATION;
}

function presentationUsesBoundary(value) {
  return (
    value === BHOTE_KOSHI_REGIONAL_PRESENTATION ||
    value === BHOTE_KOSHI_CITY_CONTEXT_PRESENTATION
  );
}

function presentationAnimatesBoundary(value) {
  return value === BHOTE_KOSHI_REGIONAL_PRESENTATION;
}

function smoothstep(from, to, value) {
  if (to <= from) return value >= to ? 1 : 0;
  const amount = Math.max(0, Math.min(1, (value - from) / (to - from)));
  return amount * amount * (3 - 2 * amount);
}

/** Resolve the persistent text callout's dot, leader, and card entrance. */
export function anchoredCalloutPresentation(elapsedMs) {
  const progress = Math.max(
    0,
    Math.min(1, Number(elapsedMs) / CALLOUT_REVEAL_DURATION_MS || 0),
  );
  const contentAlpha = smoothstep(0.34, 1, progress);
  return {
    alpha: smoothstep(0, 0.18, progress),
    leaderProgress: smoothstep(0.1, 0.52, progress),
    contentAlpha,
    scale: 0.96 + contentAlpha * 0.04,
  };
}

/** Return the progressive prefix used by the animated Nepal border. */
export function revealPolylinePositions(positions, progress) {
  if (!Array.isArray(positions) || positions.length < 2) return [];
  const clamped = Math.max(0, Math.min(1, Number(progress) || 0));
  if (clamped >= 1) return positions;
  const scaled = clamped * (positions.length - 1);
  const completed = Math.floor(scaled);
  const revealed = positions.slice(0, completed + 1);
  const next = Math.min(completed + 1, positions.length - 1);
  if (next > completed) {
    revealed.push(
      Cesium.Cartesian3.lerp(
        positions[completed],
        positions[next],
        scaled - completed,
        new Cesium.Cartesian3(),
      ),
    );
  }
  return revealed.length >= 2 ? revealed : [positions[0], positions[0]];
}

/** Close a region ring without duplicating an already-closed final vertex. */
export function closeRegionRing(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return [];
  const normalized = ring
    .map((point) => [Number(point?.[0]), Number(point?.[1])])
    .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
  if (normalized.length < 3) return [];
  const [firstLon, firstLat] = normalized[0];
  const [lastLon, lastLat] = normalized[normalized.length - 1];
  if (firstLon !== lastLon || firstLat !== lastLat)
    normalized.push([firstLon, firstLat]);
  return normalized;
}

/** Return the largest exterior ring from a Polygon or MultiPolygon GeoJSON. */
export function largestGeoJsonRing(geojson) {
  const polygons =
    geojson?.type === 'Polygon'
      ? [geojson.coordinates]
      : geojson?.type === 'MultiPolygon'
        ? geojson.coordinates
        : [];
  const rings = polygons
    .map((polygon) => polygon?.[0])
    .filter((ring) => Array.isArray(ring) && ring.length >= 3);
  return rings.sort((a, b) => b.length - a.length)[0] || [];
}

/**
 * Lightweight scene overlay for the multi-shot Nepal incident setup. It uses
 * the local OpenStreetMap boundary proxy and deliberately avoids the full
 * reconstruction layer's imagery, panel, playback, and camera ownership.
 */
export function createBhoteKoshiLocatorLayer({
  boundaryResolver = DEFAULT_BOUNDARY_RESOLVER,
  overlayHost = DEFAULT_OVERLAY_HOST,
  requestRender = governorRequestRender,
  now = () => performance.now(),
  scheduleFrame = (callback) => requestAnimationFrame(callback),
  cancelFrame = (handle) => cancelAnimationFrame(handle),
  scheduleDelay = (callback, delayMs) => setTimeout(callback, delayMs),
  cancelDelay = (handle) => clearTimeout(handle),
} = {}) {
  let _viewer = null;
  let _dataSource = null;
  let _enabled = false;
  let _boundaryReady = false;
  let _boundaryResolved = false;
  let _boundaryRing = null;
  let _generation = 0;
  let _presentation = BHOTE_KOSHI_REGIONAL_PRESENTATION;
  let _borderAnimationFrame = null;
  let _calloutPulseFrame = null;
  let _triggerApproachTimer = null;
  let _removeTriggerMoveStart = null;
  let _removeTriggerMoveEnd = null;
  let _triggerApproachInFlight = false;
  let _triggerApproachAttempt = null;
  let _triggerCalloutStartedAt = Number.POSITIVE_INFINITY;
  let _approachEnabled = false;
  let _overlayEntries = [];
  let _placeRevealMoving = false;
  let _placeRevealSettledAt = Number.POSITIVE_INFINITY;

  function queueOverlayEntry(entry) {
    _overlayEntries.push(entry);
  }

  function publishOverlayEntries({ moving = false } = {}) {
    overlayHost.setEntries(
      BHOTE_KOSHI_LOCATOR_OVERLAY_SOURCE_ID,
      _overlayEntries,
      {
        cohortLimit: Math.max(1, _overlayEntries.length),
        collisionCapacity: Math.max(1, _overlayEntries.length),
        moving,
      },
    );
  }

  function clearTriggerApproach({ preserveCallout = false } = {}) {
    // Revoke ownership before cancelFlight can synchronously deliver callbacks.
    _triggerApproachAttempt = null;
    if (_triggerApproachTimer !== null) cancelDelay(_triggerApproachTimer);
    _triggerApproachTimer = null;
    _removeTriggerMoveStart?.();
    _removeTriggerMoveEnd?.();
    _removeTriggerMoveStart = null;
    _removeTriggerMoveEnd = null;
    const wasInFlight = _triggerApproachInFlight;
    _triggerApproachInFlight = false;
    if (wasInFlight) _viewer?.camera?.cancelFlight?.();
    if (!preserveCallout) _triggerCalloutStartedAt = Number.POSITIVE_INFINITY;
  }

  function stopAnimations() {
    if (_borderAnimationFrame !== null) cancelFrame(_borderAnimationFrame);
    if (_calloutPulseFrame !== null) cancelFrame(_calloutPulseFrame);
    _borderAnimationFrame = null;
    _calloutPulseFrame = null;
    _placeRevealMoving = false;
    _placeRevealSettledAt = Number.POSITIVE_INFINITY;
    clearTriggerApproach();
  }

  function removeDataSource() {
    stopAnimations();
    overlayHost.clearSource(BHOTE_KOSHI_LOCATOR_OVERLAY_SOURCE_ID);
    if (_dataSource && _viewer?.dataSources)
      _viewer.dataSources.remove(_dataSource, true);
    _dataSource = null;
  }

  function addCallout(
    dataSource,
    subject,
    color,
    {
      labelPlacement = 'right',
      sequenceStartedAt = now(),
      visibleAfterMs = 0,
      showAnchor = true,
    } = {},
  ) {
    const position = Cesium.Cartesian3.fromDegrees(
      subject.lon,
      subject.lat,
      subject.heightM,
    );
    const visibleAt = sequenceStartedAt + visibleAfterMs;
    const isVisible = () => now() >= visibleAt;
    const pulseProgress = () => {
      const elapsed = Math.max(0, now() - visibleAt);
      return (elapsed % CALLOUT_PULSE_DURATION_MS) / CALLOUT_PULSE_DURATION_MS;
    };
    const ringSize = new Cesium.CallbackProperty(() => {
      return (
        CALLOUT_RING_MIN_SIZE_PX + CALLOUT_RING_SIZE_RANGE_PX * pulseProgress()
      );
    }, false);
    const ringColor = new Cesium.CallbackProperty((_time, result) => {
      const dynamicColor = Cesium.Color.clone(color, result);
      dynamicColor.alpha = isVisible() ? 0.14 * (1 - pulseProgress()) : 0;
      return dynamicColor;
    }, false);
    const ringOutlineColor = new Cesium.CallbackProperty((_time, result) => {
      const dynamicColor = Cesium.Color.clone(color, result);
      dynamicColor.alpha = isVisible()
        ? 0.08 + 0.72 * (1 - pulseProgress())
        : 0;
      return dynamicColor;
    }, false);
    if (showAnchor) {
      dataSource.entities.add({
        id: `${subject === INCIDENT ? 'bhote-koshi-incident' : 'nepal-context'}-halo`,
        position,
        show: new Cesium.CallbackProperty(isVisible, false),
        point: {
          pixelSize: ringSize,
          color: ringColor,
          outlineColor: ringOutlineColor,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(
            250000,
            0.8,
            25000000,
            1.35,
          ),
        },
      });
    }
    const presentation = () => anchoredCalloutPresentation(now() - visibleAt);
    if (subject === INCIDENT) {
      queueOverlayEntry({
        id: 'bhote-koshi-incident-callout',
        position,
        variant: 'card',
        paintLane: 'thumbnail',
        title: subject.title,
        details: [subject.subtitle],
        accent: INCIDENT_ACCENT,
        sourceAlpha: () => presentation().alpha,
        presentationScale: () => presentation().scale,
        leaderProgress: () => presentation().leaderProgress,
        contentAlpha: () => presentation().contentAlpha,
        anchorDot: true,
        leaderStyle: 'elbow',
        priority: 1_000_000,
        protected: true,
        active: true,
        collisionGroup: 'ambient-card',
        zIndex: 60,
        minDistance: 0,
        maxDistance: 5_000_000,
        distanceFadeStartRatio: 0.9,
        distanceScale: {
          near: 1200,
          nearValue: 1,
          far: 4_000_000,
          farValue: 0.78,
        },
        edgeFade: 'none',
        horizonCull: true,
        terrainOcclusion: false,
        gapPx: 36,
        leaderOffsetPx: 4,
        placement: 'right',
      });
    } else {
      const labelOnLeft = labelPlacement === 'left';
      queueOverlayEntry({
        id: 'nepal-context-callout',
        position,
        variant: 'label',
        paintLane: 'ambient-label',
        title: subject.title,
        details: subject.subtitle ? [subject.subtitle] : [],
        accent: BORDER_ACCENT,
        sourceAlpha: () => presentation().alpha,
        presentationScale: () => presentation().scale,
        leaderProgress: () => presentation().leaderProgress,
        contentAlpha: () => presentation().contentAlpha,
        anchorDot: showAnchor,
        leaderStyle: 'elbow',
        priority: 900_000,
        protected: true,
        active: true,
        collisionGroup: 'nepal-locator-label',
        zIndex: 48,
        minDistance: 0,
        maxDistance: 25_000_000,
        distanceFadeStartRatio: 0.9,
        distanceScale: {
          near: 250000,
          nearValue: 1.05,
          far: 25000000,
          farValue: 0.72,
        },
        edgeFade: 'none',
        horizonCull: true,
        terrainOcclusion: false,
        gapPx: 18,
        placement: labelOnLeft ? 'left' : 'right',
      });
    }
  }

  function startCalloutAnimation() {
    const generation = _generation;
    const pulseFrame = () => {
      if (!_enabled || generation !== _generation) return;
      if (_placeRevealMoving && now() >= _placeRevealSettledAt) {
        _placeRevealMoving = false;
        _placeRevealSettledAt = Number.POSITIVE_INFINITY;
        publishOverlayEntries();
      }
      requestRender('bhote-koshi-locator-callout-pulse');
      _calloutPulseFrame = scheduleFrame(pulseFrame);
    };
    _calloutPulseFrame = scheduleFrame(pulseFrame);
  }

  function addIncidentCallout(
    dataSource,
    sequenceStartedAt,
    visibleAfterMs = 0,
  ) {
    addCallout(dataSource, INCIDENT, INCIDENT_COLOR, {
      sequenceStartedAt,
      visibleAfterMs,
    });
  }

  function addTriggerRecordCallout(dataSource) {
    const position = Cesium.Cartesian3.fromDegrees(
      TRIGGER_RECORD.lon,
      TRIGGER_RECORD.lat,
      TRIGGER_RECORD.heightM,
    );
    const isVisible = () => now() >= _triggerCalloutStartedAt;
    const presentation = () =>
      anchoredCalloutPresentation(now() - _triggerCalloutStartedAt);
    const pulseProgress = () => {
      if (!isVisible()) return 0;
      return (
        ((now() - _triggerCalloutStartedAt) % CALLOUT_PULSE_DURATION_MS) /
        CALLOUT_PULSE_DURATION_MS
      );
    };
    dataSource.entities.add({
      id: 'bhote-koshi-trigger-record-halo',
      position,
      show: new Cesium.CallbackProperty(isVisible, false),
      point: {
        pixelSize: new Cesium.CallbackProperty(
          () =>
            CALLOUT_RING_MIN_SIZE_PX +
            CALLOUT_RING_SIZE_RANGE_PX * pulseProgress(),
          false,
        ),
        color: new Cesium.CallbackProperty((_time, result) => {
          const color = Cesium.Color.clone(INCIDENT_COLOR, result);
          color.alpha = 0.16 * (1 - pulseProgress());
          return color;
        }, false),
        outlineColor: new Cesium.CallbackProperty((_time, result) => {
          const color = Cesium.Color.clone(INCIDENT_COLOR, result);
          color.alpha = isVisible() ? 0.08 + 0.78 * (1 - pulseProgress()) : 0;
          return color;
        }, false),
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new Cesium.NearFarScalar(3000, 1, 250000, 0.82),
      },
    });
    queueOverlayEntry({
      id: 'bhote-koshi-trigger-record-callout',
      position,
      variant: 'card',
      paintLane: 'thumbnail',
      title: TRIGGER_RECORD.title,
      details: [...TRIGGER_RECORD.details],
      accent: INCIDENT_ACCENT,
      sourceAlpha: () => presentation().alpha,
      presentationScale: () => presentation().scale,
      leaderProgress: () => presentation().leaderProgress,
      contentAlpha: () => presentation().contentAlpha,
      anchorDot: true,
      leaderStyle: 'elbow',
      priority: 1_000_000,
      protected: true,
      active: true,
      interactive: true,
      accessibilityLabel:
        'Open the USGS initial report for the 26 August 2026 Nepal landslide',
      activate: () => {
        const opened = window.open(
          TRIGGER_SOURCE_URL,
          '_blank',
          'noopener,noreferrer',
        );
        if (opened) opened.opener = null;
      },
      collisionGroup: 'ambient-card',
      zIndex: 60,
      minDistance: 0,
      maxDistance: 1_000_000,
      distanceFadeStartRatio: 0.92,
      distanceScale: { near: 1200, nearValue: 1, far: 800000, farValue: 0.82 },
      edgeFade: 'none',
      horizonCull: true,
      terrainOcclusion: false,
      gapPx: 34,
      leaderOffsetPx: 4,
      placement: 'left',
    });
  }

  function startTriggerApproach(attempt) {
    if (
      !_enabled ||
      _presentation !== BHOTE_KOSHI_TRIGGER_RECORD_PRESENTATION ||
      _triggerApproachAttempt !== attempt ||
      attempt.phase !== 'armed'
    )
      return;
    attempt.phase = 'flying';
    if (_triggerApproachTimer !== null) cancelDelay(_triggerApproachTimer);
    _triggerApproachTimer = null;
    _removeTriggerMoveStart?.();
    _removeTriggerMoveEnd?.();
    _removeTriggerMoveStart = null;
    _removeTriggerMoveEnd = null;
    _triggerCalloutStartedAt = now();
    requestRender('bhote-koshi-trigger-record-reveal');
    const camera = _viewer?.camera;
    if (!camera?.flyTo) return;
    const generation = _generation;
    _triggerApproachInFlight = true;
    const finish = () => {
      if (_triggerApproachAttempt !== attempt) return;
      attempt.phase = 'finished';
      _triggerApproachInFlight = false;
    };
    camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        TRIGGER_APPROACH_CAMERA.lon,
        TRIGGER_APPROACH_CAMERA.lat,
        TRIGGER_APPROACH_CAMERA.alt,
      ),
      orientation: {
        heading: Cesium.Math.toRadians(TRIGGER_APPROACH_CAMERA.heading),
        pitch: Cesium.Math.toRadians(TRIGGER_APPROACH_CAMERA.pitch),
        roll: Cesium.Math.toRadians(TRIGGER_APPROACH_CAMERA.roll),
      },
      duration: TRIGGER_APPROACH_DURATION_SEC,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
      complete: () => {
        if (_triggerApproachAttempt !== attempt || attempt.phase !== 'flying')
          return;
        if (
          !_enabled ||
          generation !== _generation ||
          _presentation !== BHOTE_KOSHI_TRIGGER_RECORD_PRESENTATION
        ) {
          finish();
          return;
        }
        attempt.phase = 'orbiting';
        camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(
            TRIGGER_ORBIT_CAMERA.lon,
            TRIGGER_ORBIT_CAMERA.lat,
            TRIGGER_ORBIT_CAMERA.alt,
          ),
          orientation: {
            heading: Cesium.Math.toRadians(TRIGGER_ORBIT_CAMERA.heading),
            pitch: Cesium.Math.toRadians(TRIGGER_ORBIT_CAMERA.pitch),
            roll: Cesium.Math.toRadians(TRIGGER_ORBIT_CAMERA.roll),
          },
          duration: TRIGGER_ORBIT_DURATION_SEC,
          easingFunction: Cesium.EasingFunction.SINUSOIDAL_IN_OUT,
          complete: finish,
          cancel: finish,
        });
      },
      cancel: finish,
    });
  }

  function armTriggerApproach() {
    if (!_approachEnabled) {
      _triggerCalloutStartedAt = now();
      return;
    }
    const attempt = { phase: 'armed' };
    _triggerApproachAttempt = attempt;
    const start = () => startTriggerApproach(attempt);
    const camera = _viewer?.camera;
    if (
      !camera?.moveStart?.addEventListener ||
      !camera?.moveEnd?.addEventListener
    ) {
      start();
      return;
    }
    _removeTriggerMoveStart = camera.moveStart.addEventListener(() => {
      if (_triggerApproachAttempt !== attempt || attempt.phase !== 'armed')
        return;
      if (_triggerApproachTimer !== null) cancelDelay(_triggerApproachTimer);
      _triggerApproachTimer = null;
      _removeTriggerMoveStart?.();
      _removeTriggerMoveStart = null;
      _removeTriggerMoveEnd = camera.moveEnd.addEventListener(start);
    });
    _triggerApproachTimer = scheduleDelay(start, TRIGGER_APPROACH_ARM_MS);
  }

  function addNepalCallout(
    dataSource,
    sequenceStartedAt = now(),
    labelPlacement = 'right',
    { showAnchor = true } = {},
  ) {
    addCallout(dataSource, NEPAL, BORDER_COLOR, {
      labelPlacement,
      sequenceStartedAt,
      showAnchor,
    });
  }

  function addNearbyCityCallouts(dataSource, sequenceStartedAt) {
    NEARBY_CITIES.forEach((city, index) => {
      const visibleAt =
        sequenceStartedAt +
        CITY_CALLOUT_START_DELAY_MS +
        index * CITY_CALLOUT_STAGGER_MS;
      const progress = () =>
        smoothstep(0, 1, (now() - visibleAt) / CITY_CALLOUT_REVEAL_MS);
      const labelOnLeft = city.placement === 'left';
      const labelLower = city.placement === 'right-lower';
      const position = Cesium.Cartesian3.fromDegrees(
        city.lon,
        city.lat,
        city.heightM,
      );
      queueOverlayEntry({
        id: `bhote-koshi-city-${city.id}`,
        position,
        variant: 'label',
        paintLane: 'ambient-label',
        title: city.title,
        details: [],
        accent: BORDER_ACCENT,
        sourceAlpha: progress,
        presentationScale: () => 0.92 + progress() * 0.08,
        leaderProgress: progress,
        contentAlpha: progress,
        anchorDot: true,
        leaderStyle: 'elbow',
        priority: 700_000 - index,
        collisionGroup: 'nepal-nearby-city',
        zIndex: 44,
        minDistance: 0,
        maxDistance: 3_000_000,
        distanceFadeStartRatio: 0.82,
        distanceScale: {
          near: 100000,
          nearValue: 1.08,
          far: 3000000,
          farValue: 0.78,
        },
        edgeFade: 'keyhole',
        horizonCull: true,
        terrainOcclusion: false,
        gapPx: 14,
        placement: labelLower ? 'below' : labelOnLeft ? 'left' : 'right',
      });
    });
  }

  function addIncidentPlaceCallouts(
    dataSource,
    sequenceStartedAt,
    { pulseHalos = false, places = INCIDENT_OVERVIEW_PLACES } = {},
  ) {
    places.forEach((place, index) => {
      const visibleAt =
        sequenceStartedAt +
        PLACE_CALLOUT_START_DELAY_MS +
        index * PLACE_CALLOUT_STAGGER_MS;
      const progress = () =>
        smoothstep(0, 1, (now() - visibleAt) / PLACE_CALLOUT_REVEAL_MS);
      const labelOnLeft = place.placement === 'left';
      const labelLower = place.placement === 'right-lower';
      const position = Cesium.Cartesian3.fromDegrees(
        place.lon,
        place.lat,
        place.heightM,
      );
      if (pulseHalos) {
        const pulseSequenceDurationMs =
          PLACE_CALLOUT_STAGGER_MS * places.length;
        const pulseWindowElapsed = () => {
          const sequenceElapsed = Math.max(
            0,
            now() - sequenceStartedAt - PLACE_CALLOUT_START_DELAY_MS,
          );
          return (
            (sequenceElapsed % pulseSequenceDurationMs) -
            index * PLACE_CALLOUT_STAGGER_MS
          );
        };
        const pulseIsActive = () => {
          const elapsed = pulseWindowElapsed();
          return (
            now() >= visibleAt &&
            elapsed >= 0 &&
            elapsed < PLACE_CALLOUT_STAGGER_MS
          );
        };
        const pulseProgress = () => {
          return Math.max(
            0,
            Math.min(1, pulseWindowElapsed() / PLACE_CALLOUT_STAGGER_MS),
          );
        };
        dataSource.entities.add({
          id: `bhote-koshi-place-${place.id}-halo`,
          position,
          show: new Cesium.CallbackProperty(pulseIsActive, false),
          point: {
            pixelSize: new Cesium.CallbackProperty(
              () =>
                CALLOUT_RING_MIN_SIZE_PX +
                CALLOUT_RING_SIZE_RANGE_PX * pulseProgress(),
              false,
            ),
            color: new Cesium.CallbackProperty((_time, result) => {
              const color = Cesium.Color.clone(INCIDENT_COLOR, result);
              color.alpha = 0.16 * (1 - pulseProgress());
              return color;
            }, false),
            outlineColor: new Cesium.CallbackProperty((_time, result) => {
              const color = Cesium.Color.clone(INCIDENT_COLOR, result);
              color.alpha = 0.08 + 0.78 * (1 - pulseProgress());
              return color;
            }, false),
            outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            scaleByDistance: new Cesium.NearFarScalar(5000, 1, 500000, 0.82),
          },
        });
      }
      queueOverlayEntry({
        id: `bhote-koshi-place-${place.id}`,
        position,
        variant: 'label',
        paintLane: 'ambient-label',
        title: `${String(index + 1).padStart(2, '0')} · ${place.title}`,
        details: [],
        accent: INCIDENT_ACCENT,
        sourceAlpha: progress,
        presentationScale: () => 0.92 + progress() * 0.08,
        leaderProgress: progress,
        contentAlpha: progress,
        anchorDot: true,
        leaderStyle: 'elbow',
        priority: 800_000 - index,
        collisionGroup: 'bhote-koshi-place',
        zIndex: 46,
        minDistance: 0,
        maxDistance: 500_000,
        distanceFadeStartRatio: 0.82,
        distanceScale: {
          near: 5000,
          nearValue: 1.08,
          far: 500000,
          farValue: 0.82,
        },
        edgeFade: 'keyhole',
        horizonCull: true,
        terrainOcclusion: false,
        gapPx: 14,
        placement: labelLower ? 'below' : labelOnLeft ? 'left' : 'right',
      });
    });
  }

  function addIncidentFloodPath(dataSource, sequenceStartedAt) {
    const positions = BHOTE_KOSHI_FLOOD_PATH.map(([lon, lat]) =>
      Cesium.Cartesian3.fromDegrees(lon, lat),
    );
    const drawStartedAt = sequenceStartedAt + FLOOD_PATH_START_DELAY_MS;
    const animatedPositions = new Cesium.CallbackProperty(
      () =>
        revealPolylinePositions(
          positions,
          (now() - drawStartedAt) / FLOOD_PATH_DRAW_DURATION_MS,
        ),
      false,
    );
    dataSource.entities.add({
      id: 'bhote-koshi-flood-path',
      show: new Cesium.CallbackProperty(() => now() >= drawStartedAt, false),
      polyline: {
        positions: animatedPositions,
        width: 3.5,
        clampToGround: true,
        material: BORDER_COLOR.withAlpha(0.96),
        classificationType: Cesium.ClassificationType.BOTH,
      },
    });
  }

  function addNepalBoundary(dataSource, ring, sequenceStartedAt) {
    const closed = closeRegionRing(ring);
    if (closed.length < 4) return false;
    const positions = Cesium.Cartesian3.fromDegreesArray(closed.flat());
    const hierarchy = new Cesium.PolygonHierarchy(positions.slice(0, -1));
    const drawStartedAt = sequenceStartedAt + BORDER_START_DELAY_MS;
    const animatedPositions = new Cesium.CallbackProperty(
      () =>
        revealPolylinePositions(
          positions,
          (now() - drawStartedAt) / BORDER_DRAW_DURATION_MS,
        ),
      false,
    );
    dataSource.entities.add({
      id: 'nepal-border-fill',
      show: new Cesium.CallbackProperty(() => now() >= drawStartedAt, false),
      polygon: {
        hierarchy,
        material: BORDER_COLOR.withAlpha(0.055),
        classificationType: Cesium.ClassificationType.BOTH,
      },
    });
    dataSource.entities.add({
      id: 'nepal-border-halo',
      polyline: {
        positions: animatedPositions,
        width: 5,
        clampToGround: true,
        material: BORDER_COLOR.withAlpha(0.12),
        classificationType: Cesium.ClassificationType.BOTH,
      },
    });
    dataSource.entities.add({
      id: 'nepal-border-highlight',
      polyline: {
        positions: animatedPositions,
        width: 2.5,
        clampToGround: true,
        material: BORDER_COLOR.withAlpha(0.96),
        classificationType: Cesium.ClassificationType.BOTH,
      },
    });
    const generation = _generation;
    const drawFrame = () => {
      if (
        !_enabled ||
        generation !== _generation ||
        !presentationAnimatesBoundary(_presentation)
      )
        return;
      requestRender('bhote-koshi-locator-border-draw');
      if (now() - drawStartedAt < BORDER_DRAW_DURATION_MS) {
        _borderAnimationFrame = scheduleFrame(drawFrame);
      } else {
        _borderAnimationFrame = null;
      }
    };
    _borderAnimationFrame = scheduleFrame(drawFrame);
    return true;
  }

  function renderPresentation() {
    if (!_dataSource) return;
    stopAnimations();
    overlayHost.clearSource(BHOTE_KOSHI_LOCATOR_OVERLAY_SOURCE_ID);
    _overlayEntries = [];
    _dataSource.entities.removeAll();
    if (_presentation === NEPAL_CONTEXT_PRESENTATION) {
      addNepalCallout(_dataSource);
    } else if (_presentation === BHOTE_KOSHI_INCIDENT_PLACES_PRESENTATION) {
      const sequenceStartedAt = now();
      addIncidentPlaceCallouts(_dataSource, sequenceStartedAt, {
        pulseHalos: true,
        places: INCIDENT_OVERVIEW_PLACES,
      });
      _placeRevealMoving = true;
      _placeRevealSettledAt =
        sequenceStartedAt +
        PLACE_CALLOUT_START_DELAY_MS +
        (INCIDENT_OVERVIEW_PLACES.length - 1) * PLACE_CALLOUT_STAGGER_MS +
        PLACE_CALLOUT_REVEAL_MS;
    } else if (_presentation === BHOTE_KOSHI_FLOOD_PATH_PRESENTATION) {
      const sequenceStartedAt = now();
      const settledPlacesAt =
        sequenceStartedAt -
        PLACE_CALLOUT_START_DELAY_MS -
        (INCIDENT_OVERVIEW_PLACES.length - 1) * PLACE_CALLOUT_STAGGER_MS -
        PLACE_CALLOUT_REVEAL_MS;
      addIncidentFloodPath(_dataSource, sequenceStartedAt);
      addIncidentPlaceCallouts(_dataSource, settledPlacesAt);
    } else if (_presentation === BHOTE_KOSHI_PATH_OVERVIEW_PRESENTATION) {
      const sequenceStartedAt = now();
      const settledPathAt =
        sequenceStartedAt -
        FLOOD_PATH_START_DELAY_MS -
        FLOOD_PATH_DRAW_DURATION_MS;
      const settledPlacesAt =
        sequenceStartedAt -
        PLACE_CALLOUT_START_DELAY_MS -
        (INCIDENT_OVERVIEW_PLACES.length - 1) * PLACE_CALLOUT_STAGGER_MS -
        PLACE_CALLOUT_REVEAL_MS;
      addIncidentFloodPath(_dataSource, settledPathAt);
      addIncidentPlaceCallouts(_dataSource, settledPlacesAt);
    } else if (_presentation === BHOTE_KOSHI_TRIGGER_RECORD_PRESENTATION) {
      const sequenceStartedAt = now();
      const settledPathAt =
        sequenceStartedAt -
        FLOOD_PATH_START_DELAY_MS -
        FLOOD_PATH_DRAW_DURATION_MS;
      addIncidentFloodPath(_dataSource, settledPathAt);
      addTriggerRecordCallout(_dataSource);
      armTriggerApproach();
    } else {
      const sequenceStartedAt = now();
      addNepalCallout(_dataSource, sequenceStartedAt, 'left');
      if (!_boundaryResolved) {
        publishOverlayEntries();
        startCalloutAnimation();
        requestRender('bhote-koshi-locator-presentation');
        return;
      }
      if (_presentation === BHOTE_KOSHI_CITY_CONTEXT_PRESENTATION) {
        const settledAt =
          sequenceStartedAt - BORDER_START_DELAY_MS - BORDER_DRAW_DURATION_MS;
        if (_boundaryRing)
          addNepalBoundary(_dataSource, _boundaryRing, settledAt);
        addIncidentCallout(
          _dataSource,
          sequenceStartedAt - CALLOUT_REVEAL_DURATION_MS,
        );
        addNearbyCityCallouts(_dataSource, sequenceStartedAt);
      } else {
        if (_boundaryRing)
          addNepalBoundary(_dataSource, _boundaryRing, sequenceStartedAt);
        const incidentDelayMs = _boundaryRing
          ? BORDER_START_DELAY_MS +
            BORDER_DRAW_DURATION_MS +
            INCIDENT_CALLOUT_GAP_MS
          : BORDER_START_DELAY_MS;
        addIncidentCallout(_dataSource, sequenceStartedAt, incidentDelayMs);
      }
    }
    publishOverlayEntries({ moving: _placeRevealMoving });
    startCalloutAnimation();
    requestRender('bhote-koshi-locator-presentation');
  }

  async function init(viewer) {
    _viewer = viewer;
    return true;
  }

  async function enable(viewer, { signal } = {}) {
    _viewer = viewer;
    _enabled = true;
    _boundaryReady = false;
    _boundaryResolved = false;
    _boundaryRing = null;
    const generation = ++_generation;
    removeDataSource();
    const dataSource = new Cesium.CustomDataSource('bhote-koshi-locator');
    _dataSource = dataSource;
    renderPresentation();
    viewer.dataSources.add(dataSource);
    registerDynamicCredit(viewer, BHOTE_KOSHI_LOCATOR_CREDIT);
    requestRender('bhote-koshi-locator-callout');

    try {
      const boundary = await boundaryResolver(signal);
      if (signal?.aborted || !_enabled || generation !== _generation)
        throw abortError();
      _boundaryRing = closeRegionRing(boundary?.ring);
      _boundaryReady = _boundaryRing.length >= 4;
      _boundaryResolved = true;
      if (!_boundaryReady && presentationUsesBoundary(_presentation)) {
        console.warn('[Data:BhoteKoshiLocator] Nepal boundary unavailable');
      }
      if (presentationUsesBoundary(_presentation)) {
        renderPresentation();
      }
      requestRender('bhote-koshi-locator-boundary');
      return true;
    } catch (error) {
      if (error?.name === 'AbortError') {
        if (generation === _generation) removeDataSource();
        throw error;
      }
      console.warn(
        '[Data:BhoteKoshiLocator] Nepal boundary lookup failed:',
        error,
      );
      _boundaryResolved = true;
      _boundaryRing = null;
      if (presentationUsesBoundary(_presentation)) renderPresentation();
      requestRender('bhote-koshi-locator-degraded');
      return true;
    }
  }

  async function disable() {
    _enabled = false;
    _boundaryReady = false;
    _boundaryResolved = false;
    _boundaryRing = null;
    _generation += 1;
    removeDataSource();
    requestRender('bhote-koshi-locator-disable');
    return true;
  }

  async function destroy() {
    await disable();
    _viewer = null;
  }

  return {
    id: BHOTE_KOSHI_LOCATOR_LAYER_ID,
    name: 'Bhote Koshi Locator',
    // Scene-owned component; retain registration without a standalone menu row.
    showInTogglePanel: false,
    icon: '◎',
    source: 'OpenStreetMap + GeoPera',
    updateInterval: 0,
    init,
    enable,
    disable,
    update: async () => true,
    destroy,
    cancelSceneMotion() {
      clearTriggerApproach({ preserveCallout: true });
    },
    setParams(params = {}) {
      _presentation = normalizePresentation(params.presentation);
      _approachEnabled =
        _presentation === BHOTE_KOSHI_TRIGGER_RECORD_PRESENTATION &&
        params.preview !== true;
      if (_enabled) renderPresentation();
      return true;
    },
    getParams() {
      return { presentation: _presentation };
    },
    getRowControls() {
      return {
        chips: [
          {
            id: 'nepal-context',
            label: 'NEPAL',
            active: _presentation === NEPAL_CONTEXT_PRESENTATION,
            title:
              'Show the Nepal context callout without a border or country fill',
            params: { presentation: NEPAL_CONTEXT_PRESENTATION },
          },
          {
            id: 'bhote-koshi-regional',
            label: 'BHOTE',
            active: _presentation === BHOTE_KOSHI_REGIONAL_PRESENTATION,
            title:
              'Introduce Nepal, draw its border, then reveal the Bhote Koshi incident',
            params: { presentation: BHOTE_KOSHI_REGIONAL_PRESENTATION },
          },
          {
            id: 'bhote-koshi-city-context',
            label: 'CITIES',
            active: _presentation === BHOTE_KOSHI_CITY_CONTEXT_PRESENTATION,
            title:
              'Keep the regional incident context and introduce nearby city labels',
            params: { presentation: BHOTE_KOSHI_CITY_CONTEXT_PRESENTATION },
          },
          {
            id: 'bhote-koshi-incident-places',
            label: 'PLACES',
            active: _presentation === BHOTE_KOSHI_INCIDENT_PLACES_PRESENTATION,
            title:
              'Introduce the reconstruction scene key places from trigger to downstream',
            params: { presentation: BHOTE_KOSHI_INCIDENT_PLACES_PRESENTATION },
          },
          {
            id: 'bhote-koshi-flood-path',
            label: 'PATH',
            active: _presentation === BHOTE_KOSHI_FLOOD_PATH_PRESENTATION,
            title:
              'Animate the sourced cyan river-centerline route to Trishuli Bazaar',
            params: { presentation: BHOTE_KOSHI_FLOOD_PATH_PRESENTATION },
          },
          {
            id: 'bhote-koshi-path-overview',
            label: 'OVERVIEW',
            active: _presentation === BHOTE_KOSHI_PATH_OVERVIEW_PRESENTATION,
            title: 'Keep the completed flood path and location labels visible',
            params: { presentation: BHOTE_KOSHI_PATH_OVERVIEW_PRESENTATION },
          },
          {
            id: 'bhote-koshi-trigger-record',
            label: 'RECORD',
            active: _presentation === BHOTE_KOSHI_TRIGGER_RECORD_PRESENTATION,
            title:
              'Reveal the trigger record while making a slow camera approach',
            params: {
              presentation: BHOTE_KOSHI_TRIGGER_RECORD_PRESENTATION,
              preview: true,
            },
          },
        ],
        legend: [],
      };
    },
    getStats() {
      return {
        count: _enabled ? 1 : 0,
        status: !_enabled
          ? 'idle'
          : _presentation === BHOTE_KOSHI_INCIDENT_PLACES_PRESENTATION ||
              _presentation === BHOTE_KOSHI_FLOOD_PATH_PRESENTATION ||
              _presentation === BHOTE_KOSHI_PATH_OVERVIEW_PRESENTATION ||
              _presentation === BHOTE_KOSHI_TRIGGER_RECORD_PRESENTATION ||
              _boundaryReady
            ? 'nominal'
            : 'degraded',
        source: 'OpenStreetMap + GeoPera',
        coverage: !_enabled
          ? 'Incident locator'
          : _presentation === NEPAL_CONTEXT_PRESENTATION
            ? 'Nepal context'
            : _presentation === BHOTE_KOSHI_CITY_CONTEXT_PRESENTATION
              ? 'Bhote Koshi · Nearby cities'
              : _presentation === BHOTE_KOSHI_INCIDENT_PLACES_PRESENTATION
                ? 'Bhote Koshi · Incident places'
                : _presentation === BHOTE_KOSHI_FLOOD_PATH_PRESENTATION
                  ? 'Bhote Koshi · Flood path'
                  : _presentation === BHOTE_KOSHI_PATH_OVERVIEW_PRESENTATION
                    ? 'Bhote Koshi · Path overview'
                    : _presentation === BHOTE_KOSHI_TRIGGER_RECORD_PRESENTATION
                      ? 'Bhote Koshi · Trigger record'
                      : 'Nepal · Bhote Koshi',
      };
    },
  };
}

const bhoteKoshiLocatorLayer = createBhoteKoshiLocatorLayer();
export default bhoteKoshiLocatorLayer;
