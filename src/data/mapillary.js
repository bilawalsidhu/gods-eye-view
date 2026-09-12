import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import {
  clearOverlaySource,
  hitTestWorldOverlay,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';
import {
  clearSelectedEntityContextForLayer,
  registerEntityContext,
  removeEntityContextsForLayer,
  selectEntityContext,
} from './contextStore.js';
import { MAPILLARY_CREDIT } from './dataCredits.js';
import {
  isOwnedByOtherLayer,
  registerPickOwner,
  resolvePickId,
  unregisterPickOwner,
} from './pickRegistry.js';
import { deriveFetchCenter } from './trafficBounds.js';

const LAYER_ID = 'mapillary';
const OVERLAY_SOURCE_ID = 'mapillary-selected';
const API_URL = '/api/mapillary/images';
const ENTER_ALTITUDE_M = 7000;
const EXIT_ALTITUDE_M = 9000;
const REQUEST_DEBOUNCE_MS = 500;
const MIN_REQUEST_INTERVAL_MS = 2000;
// A deliberately compact, camera-centred neighborhood. Dense Mapillary areas
// can reject wider bboxes even when `limit` is small (Graph error code 1).
const QUERY_SPAN_DEG = 0.002;
const OVERLAP_THRESHOLD = 0.6;
const MIN_CENTER_SHIFT_KM = 0.35;
const MAX_RENDERED = 200;
const MAX_VISIBLE_MARKERS = 48;
const MIN_MARKER_SEPARATION_M = 25;
const DIRECTION_LENGTH_M = 8;
const RETRY_MIN_MS = 30000;
const RETRY_MAX_MS = 240000;
const MARKER_COLOR = '#35d07f';
const SELECTED_COLOR = '#ffffff';

/** Convert an arbitrary angle to degrees clockwise from north. */
export function normalizeCompassAngle(value) {
  const angle = Number(value);
  if (!Number.isFinite(angle)) return null;
  return ((angle % 360) + 360) % 360;
}

/** Prefer Mapillary's processed values while retaining original metadata fallbacks. */
export function normalizeMapillaryImage(raw) {
  const id = String(raw?.id || '').trim();
  const geometry = raw?.computed_geometry?.type === 'Point'
    ? raw.computed_geometry
    : raw?.geometry?.type === 'Point' ? raw.geometry : null;
  const longitude = Number(geometry?.coordinates?.[0]);
  const latitude = Number(geometry?.coordinates?.[1]);
  if (!id || !Number.isFinite(latitude) || !Number.isFinite(longitude)
    || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  const capturedAt = Number(raw?.captured_at);
  const creator = typeof raw?.creator === 'object'
    ? String(raw.creator.username || raw.creator.name || '').trim()
    : String(raw?.creator || '').trim();
  const thumbnailUrl = String(raw?.thumb_1024_url || raw?.thumb_256_url || '').trim();
  const cameraType = String(raw?.camera_type || '').trim().toLowerCase();
  const make = String(raw?.make || '').trim();
  const model = String(raw?.model || '').trim();
  return {
    id,
    entityId: `mapillary:${id}`,
    latitude,
    longitude,
    capturedAt: Number.isFinite(capturedAt) && capturedAt > 0 ? capturedAt : null,
    compassAngle: normalizeCompassAngle(raw?.computed_compass_angle ?? raw?.compass_angle),
    creator: creator || null,
    thumbnailUrl: /^https:\/\//i.test(thumbnailUrl) ? thumbnailUrl : null,
    cameraType: cameraType || null,
    make: make || null,
    model: model || null,
    imageUrl: `https://www.mapillary.com/app/?pKey=${encodeURIComponent(id)}`,
  };
}

/** Destination point for the small on-globe camera-direction whisker. */
export function destinationAtBearing(latitude, longitude, bearingDeg, distanceM = 25) {
  const radiusM = 6371008.8;
  const angular = distanceM / radiusM;
  const lat1 = Cesium.Math.toRadians(latitude);
  const lon1 = Cesium.Math.toRadians(longitude);
  const bearing = Cesium.Math.toRadians(bearingDeg);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angular)
      + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing),
  );
  const lon2 = lon1 + Math.atan2(
    Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
    Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
  );
  return {
    latitude: Cesium.Math.toDegrees(lat2),
    longitude: ((Cesium.Math.toDegrees(lon2) + 540) % 360) - 180,
  };
}

/** Pure hysteresis decision used by the runtime camera gate and tests. */
export function mapillaryAltitudeGate(wasActive, altitudeM) {
  if (!Number.isFinite(altitudeM)) return false;
  return wasActive ? altitudeM < EXIT_ALTITUDE_M : altitudeM <= ENTER_ALTITUDE_M;
}

function haversineKm(aLat, aLon, bLat, bLon) {
  const toRad = (value) => value * Math.PI / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const p1 = toRad(aLat);
  const p2 = toRad(bLat);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function boxArea(box) {
  return Math.max(0, box.east - box.west) * Math.max(0, box.north - box.south);
}

function intersectionArea(a, b) {
  return Math.max(0, Math.min(a.east, b.east) - Math.max(a.west, b.west))
    * Math.max(0, Math.min(a.north, b.north) - Math.max(a.south, b.south));
}

export function mapillaryBoundsEquivalent(next, previous) {
  if (!next || !previous) return false;
  const overlap = intersectionArea(next, previous) / Math.max(1e-12, Math.min(boxArea(next), boxArea(previous)));
  const nextLat = (next.south + next.north) / 2;
  const nextLon = (next.west + next.east) / 2;
  const previousLat = (previous.south + previous.north) / 2;
  const previousLon = (previous.west + previous.east) / 2;
  return overlap >= OVERLAP_THRESHOLD
    && haversineKm(nextLat, nextLon, previousLat, previousLon) < MIN_CENTER_SHIFT_KM;
}

/** Keep the newest spatially distinct images instead of drawing capture bursts. */
export function selectMapillaryRenderRecords(
  records,
  limit = MAX_VISIBLE_MARKERS,
  minSeparationM = MIN_MARKER_SEPARATION_M,
) {
  const boundedLimit = Math.max(0, Math.floor(Number(limit) || 0));
  const separationM = Math.max(0, Number(minSeparationM) || 0);
  const candidates = (Array.isArray(records) ? records : [])
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => Number.isFinite(record?.latitude) && Number.isFinite(record?.longitude))
    .sort((a, b) => {
      const capturedDelta = (Number(b.record.capturedAt) || 0) - (Number(a.record.capturedAt) || 0);
      return capturedDelta || a.index - b.index;
    });
  const selected = [];
  for (const { record } of candidates) {
    if (selected.length >= boundedLimit) break;
    const distinct = selected.every((existing) => (
      haversineKm(record.latitude, record.longitude, existing.latitude, existing.longitude) * 1000
        >= separationM
    ));
    if (distinct) selected.push(record);
  }
  return selected;
}

/** Build the small non-dateline neighborhood queried around the look-at point. */
export function mapillaryNearbyBox(latitude, longitude, spanDeg = QUERY_SPAN_DEG) {
  const lat = Number(latitude);
  const lon = Number(longitude);
  const span = Math.abs(Number(spanDeg));
  if (![lat, lon, span].every(Number.isFinite) || span <= 0) return null;
  const boundedSpan = Math.min(QUERY_SPAN_DEG, span);
  const boundedLat = Math.max(-90 + boundedSpan / 2, Math.min(90 - boundedSpan / 2, lat));
  const boundedLon = Math.max(-180 + boundedSpan / 2, Math.min(180 - boundedSpan / 2, lon));
  return {
    south: boundedLat - boundedSpan / 2,
    west: boundedLon - boundedSpan / 2,
    north: boundedLat + boundedSpan / 2,
    east: boundedLon + boundedSpan / 2,
  };
}

function currentQueryBox(viewer) {
  const camera = viewer?.camera;
  const position = camera?.positionCartographic;
  const altitude = Number(position?.height);
  state.altitudeGate = mapillaryAltitudeGate(state.altitudeGate, altitude);
  if (!state.altitudeGate) return null;

  const ellipsoid = viewer?.scene?.globe?.ellipsoid || Cesium.Ellipsoid.WGS84;
  let hit = null;
  try {
    const canvas = viewer.scene.canvas;
    const center = new Cesium.Cartesian2(
      Number(canvas.clientWidth || canvas.width || 0) / 2,
      Number(canvas.clientHeight || canvas.height || 0) / 2,
    );
    const cartesian = camera.pickEllipsoid(center, ellipsoid);
    if (cartesian) hit = Cesium.Cartographic.fromCartesian(cartesian, ellipsoid);
  } catch { /* nadir fallback below */ }

  const nadirLat = Cesium.Math.toDegrees(position.latitude);
  const nadirLon = Cesium.Math.toDegrees(position.longitude);
  const center = deriveFetchCenter({
    nadirLat,
    nadirLon,
    hitLat: hit ? Cesium.Math.toDegrees(hit.latitude) : undefined,
    hitLon: hit ? Cesium.Math.toDegrees(hit.longitude) : undefined,
    maxPullKm: 12,
  });
  // Graph bbox queries cannot cross the antimeridian. The helper shifts this
  // compact v1 neighborhood inward rather than issuing west > east.
  return mapillaryNearbyBox(center.lat, center.lon);
}

function cardinal(angle) {
  if (!Number.isFinite(angle)) return null;
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(angle / 45) % 8];
}

function formatCaptureDate(timestamp) {
  if (!timestamp) return 'CAPTURE DATE UNKNOWN';
  try {
    return `CAPTURED ${new Date(timestamp).toISOString().slice(0, 10)} UTC`;
  } catch {
    return 'CAPTURE DATE UNKNOWN';
  }
}

function selectedDetails(record) {
  const direction = Number.isFinite(record.compassAngle)
    ? `FACING ${Math.round(record.compassAngle)}° ${cardinal(record.compassAngle)}`
    : 'FACING DIRECTION UNKNOWN';
  const cameraName = [record.make, record.model].filter(Boolean).join(' ');
  const camera = cameraName
    ? `CAMERA ${cameraName}`
    : record.cameraType === 'spherical'
      ? 'CAMERA 360° PANORAMA'
      : record.cameraType
        ? `CAMERA ${record.cameraType.toUpperCase()}`
        : 'CAMERA TYPE UNKNOWN';
  return [
    formatCaptureDate(record.capturedAt),
    record.creator ? `BY ${record.creator}` : 'CREATOR UNKNOWN',
    camera,
    direction,
    `${record.latitude.toFixed(5)}, ${record.longitude.toFixed(5)}`,
    'CLICK IMAGE · OPEN ORIGINAL ↗',
  ];
}

const state = {
  viewer: null,
  dataSource: null,
  enabled: false,
  altitudeGate: false,
  timeRange: 'all',
  records: [],
  recordByEntityId: new Map(),
  selectedEntityId: null,
  thumbnail: null,
  thumbnailGeneration: 0,
  lastBounds: null,
  lastUpdate: null,
  loading: false,
  stale: false,
  saturated: false,
  status: 'idle',
  error: null,
  keyRequired: false,
  retryAt: 0,
  retryDelayMs: 0,
  abort: null,
  debounceTimer: null,
  retryTimer: null,
  lastRequestAt: 0,
  moveEndRemove: null,
  clickHandler: null,
  credit: null,
  creditVisible: false,
};

function syncCredit(visible) {
  const display = state.viewer?.creditDisplay;
  if (!display) return;
  if (!state.credit) state.credit = new Cesium.Credit(MAPILLARY_CREDIT.html, true);
  if (visible && !state.creditVisible && typeof display.addStaticCredit === 'function') {
    display.addStaticCredit(state.credit);
    state.creditVisible = true;
  } else if (!visible && state.creditVisible && typeof display.removeStaticCredit === 'function') {
    display.removeStaticCredit(state.credit);
    state.creditVisible = false;
  }
}

function clearRetry({ reset = true } = {}) {
  clearTimeout(state.retryTimer);
  state.retryTimer = null;
  state.retryAt = 0;
  if (reset) state.retryDelayMs = 0;
}

function scheduleRetry(delayMs = null) {
  if (!state.enabled || state.keyRequired) return;
  clearRetry({ reset: false });
  state.retryDelayMs = Number.isFinite(delayMs)
    ? Math.max(1000, Math.min(RETRY_MAX_MS, delayMs))
    : (state.retryDelayMs ? Math.min(RETRY_MAX_MS, state.retryDelayMs * 2) : RETRY_MIN_MS);
  state.retryAt = Date.now() + state.retryDelayMs;
  state.retryTimer = setTimeout(() => {
    state.retryTimer = null;
    state.retryAt = 0;
    if (state.enabled && !state.loading) void loadImages({ force: true });
  }, state.retryDelayMs);
}

function clearSelection() {
  state.selectedEntityId = null;
  state.thumbnailGeneration += 1;
  if (state.thumbnail) {
    state.thumbnail.onload = null;
    state.thumbnail.onerror = null;
  }
  state.thumbnail = null;
  clearSelectedEntityContextForLayer(LAYER_ID);
  clearOverlaySource(OVERLAY_SOURCE_ID);
}

function clearRendered() {
  clearSelection();
  removeEntityContextsForLayer(LAYER_ID);
  state.dataSource?.entities.removeAll();
  state.records = [];
  state.recordByEntityId.clear();
  syncCredit(false);
  governorRequestRender('mapillary-clear');
}

function publishSelectedOverlay(record) {
  if (!record || !state.enabled) {
    clearOverlaySource(OVERLAY_SOURCE_ID);
    return;
  }
  const entity = state.dataSource?.entities.getById(record.entityId);
  if (!entity) return;
  setOverlayEntries(OVERLAY_SOURCE_ID, [{
    id: record.entityId,
    position: entity.position.getValue(Cesium.JulianDate.now()),
    variant: 'thumbnail',
    paintLane: 'selected',
    title: 'MAPILLARY IMAGE',
    details: selectedDetails(record),
    image: state.thumbnail,
    requireImage: false,
    thumbnailWidth: 288,
    thumbnailHeight: 162,
    thumbnailPadX: 8,
    thumbnailPadTop: 8,
    thumbnailPadBottom: 8,
    thumbnailTitleGap: 5,
    thumbnailRuleHeight: 2,
    thumbnailRuleColor: MARKER_COLOR,
    thumbnailLeaderColor: MARKER_COLOR,
    accent: MARKER_COLOR,
    protected: true,
    priority: 1_000_000,
    interactive: true,
    accessibilityLabel: `Open Mapillary image captured at ${record.latitude.toFixed(5)}, ${record.longitude.toFixed(5)}`,
    activate: () => {
      window.open(record.imageUrl, '_blank', 'noopener,noreferrer');
      return true;
    },
  }], { cohortLimit: 1, collisionCapacity: 1, moving: false });
}

function loadSelectedThumbnail(record) {
  state.thumbnailGeneration += 1;
  const generation = state.thumbnailGeneration;
  state.thumbnail = null;
  publishSelectedOverlay(record);
  if (!record.thumbnailUrl || typeof Image === 'undefined') return;
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.onload = () => {
    if (generation !== state.thumbnailGeneration || state.selectedEntityId !== record.entityId) return;
    state.thumbnail = image;
    publishSelectedOverlay(record);
    governorRequestRender('mapillary-thumbnail');
  };
  image.onerror = () => {
    if (generation !== state.thumbnailGeneration) return;
    state.thumbnail = null;
    publishSelectedOverlay(record);
  };
  image.src = record.thumbnailUrl;
}

function selectRecord(record) {
  if (!record || !state.enabled) return false;
  state.selectedEntityId = record.entityId;
  for (const entity of state.dataSource.entities.values) {
    const selected = entity.id === record.entityId;
    entity.point.pixelSize = selected ? 13 : 7;
    entity.point.color = selected
      ? Cesium.Color.fromCssColorString(SELECTED_COLOR)
      : Cesium.Color.fromCssColorString(MARKER_COLOR).withAlpha(0.9);
    if (entity.polyline) {
      entity.polyline.width = selected ? 2 : 1;
      entity.polyline.material = selected
        ? Cesium.Color.WHITE.withAlpha(0.9)
        : Cesium.Color.fromCssColorString(MARKER_COLOR).withAlpha(0.32);
    }
  }
  const entity = state.dataSource.entities.getById(record.entityId);
  if (!entity) return false;
  selectEntityContext(entity);
  loadSelectedThumbnail(record);
  governorRequestRender('mapillary-select');
  return true;
}

function renderRecords(records) {
  clearRendered();
  state.records = records.slice(0, MAX_VISIBLE_MARKERS);
  const markerColor = Cesium.Color.fromCssColorString(MARKER_COLOR);
  for (const record of state.records) {
    const position = Cesium.Cartesian3.fromDegrees(record.longitude, record.latitude, 0);
    const directionEnd = Number.isFinite(record.compassAngle)
      ? destinationAtBearing(
        record.latitude,
        record.longitude,
        record.compassAngle,
        DIRECTION_LENGTH_M,
      )
      : null;
    const entity = state.dataSource.entities.add({
      id: record.entityId,
      position,
      point: {
        pixelSize: 7,
        color: markerColor.withAlpha(0.9),
        outlineColor: Cesium.Color.fromCssColorString('#06140e').withAlpha(0.9),
        outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      polyline: directionEnd ? {
        positions: [
          position,
          Cesium.Cartesian3.fromDegrees(directionEnd.longitude, directionEnd.latitude, 0),
        ],
        width: 1,
        material: markerColor.withAlpha(0.32),
        clampToGround: true,
      } : undefined,
    });
    entity.gevDisplayPosition = () => position;
    entity.gevLabelModel = {
      title: 'MAPILLARY',
      details: [formatCaptureDate(record.capturedAt)],
      accent: MARKER_COLOR,
    };
    registerEntityContext(entity, {
      id: record.entityId,
      layerId: LAYER_ID,
      layerName: 'Mapillary Street Imagery',
      source: 'Mapillary',
      label: 'Mapillary image',
      latitude: record.latitude,
      longitude: record.longitude,
      properties: {
        imageId: record.id,
        capturedAt: record.capturedAt,
        creator: record.creator,
        compassAngle: record.compassAngle,
        cameraType: record.cameraType,
        make: record.make,
        model: record.model,
        imageUrl: record.imageUrl,
      },
    });
    state.recordByEntityId.set(record.entityId, record);
  }
  syncCredit(state.enabled && state.records.length > 0);
  governorRequestRender('mapillary-render');
}

function installInteraction(viewer) {
  if (state.clickHandler) return;
  state.clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  state.clickHandler.setInputAction((click) => {
    if (!state.enabled) return;
    const cardHit = hitTestWorldOverlay(click.position?.x, click.position?.y, {
      sourceId: OVERLAY_SOURCE_ID,
    });
    if (cardHit) {
      cardHit.entry.activate?.();
      return;
    }
    const picked = viewer.scene.pick(click.position);
    const id = resolvePickId(picked);
    if (id && state.recordByEntityId.has(id)) {
      if (id === state.selectedEntityId) {
        clearSelection();
        renderRecords(state.records);
      } else {
        selectRecord(state.recordByEntityId.get(id));
      }
      return;
    }
    if (id && isOwnedByOtherLayer(LAYER_ID, id)) return;
    if (state.selectedEntityId) {
      clearSelection();
      renderRecords(state.records);
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}

function scheduleLoad() {
  if (!state.enabled) return;
  clearTimeout(state.debounceTimer);
  const rateDelay = Math.max(0, MIN_REQUEST_INTERVAL_MS - (Date.now() - state.lastRequestAt));
  state.debounceTimer = setTimeout(
    () => { void loadImages(); },
    Math.max(REQUEST_DEBOUNCE_MS, rateDelay),
  );
}

async function loadImages({ force = false } = {}) {
  if (!state.enabled || !state.viewer) return;
  const box = currentQueryBox(state.viewer);
  if (!box) {
    state.abort?.abort();
    state.abort = null;
    state.loading = false;
    state.status = 'zoom-in';
    state.error = null;
    state.keyRequired = false;
    state.saturated = false;
    state.stale = false;
    clearRetry();
    clearRendered();
    state.lastBounds = null;
    return;
  }
  if (!force && mapillaryBoundsEquivalent(box, state.lastBounds)) return;

  const movedAway = state.lastBounds && !mapillaryBoundsEquivalent(box, state.lastBounds);
  if (movedAway) {
    clearRendered();
    state.lastBounds = null;
    state.saturated = false;
    state.stale = false;
  }
  state.abort?.abort();
  const abort = new AbortController();
  state.abort = abort;
  state.loading = true;
  state.lastRequestAt = Date.now();
  state.status = 'loading';
  state.error = null;
  state.keyRequired = false;
  clearRetry({ reset: false });
  try {
    const query = new URLSearchParams(Object.entries(box).map(([key, value]) => [key, value.toFixed(5)]));
    query.set('range', state.timeRange);
    const response = await fetch(`${API_URL}?${query}`, { signal: abort.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body?.error === 'no_key'
        ? 'Needs MAPILLARY_ACCESS_TOKEN — add it in Provider Settings'
        : body?.error === 'rate_limited'
          ? 'Mapillary rate limited'
          : 'Mapillary imagery unavailable');
      error.code = body?.error || 'upstream';
      error.retryAfterSec = Number(body?.retryAfterSec);
      throw error;
    }
    if (abort.signal.aborted || state.abort !== abort || !state.enabled) return;
    const normalizedRecords = (Array.isArray(body?.images) ? body.images : [])
      .map(normalizeMapillaryImage)
      .filter(Boolean)
      .slice(0, MAX_RENDERED);
    const records = selectMapillaryRenderRecords(normalizedRecords);
    state.lastBounds = box;
    state.lastUpdate = Date.now();
    state.stale = false;
    state.saturated = body?.saturated === true
      || normalizedRecords.length >= MAX_RENDERED
      || records.length < normalizedRecords.length;
    state.status = records.length ? 'ready' : 'empty';
    state.error = null;
    state.keyRequired = false;
    clearRetry();
    renderRecords(records);
  } catch (error) {
    if (error?.name === 'AbortError') return;
    state.keyRequired = error?.code === 'no_key';
    state.status = state.keyRequired ? 'key-required' : 'unavailable';
    state.error = error?.message || 'Mapillary imagery unavailable';
    state.stale = state.records.length > 0;
    if (!state.keyRequired) {
      const retryMs = error?.code === 'rate_limited' && Number.isFinite(error.retryAfterSec)
        ? error.retryAfterSec * 1000
        : null;
      scheduleRetry(retryMs);
    }
  } finally {
    if (state.abort === abort) {
      state.abort = null;
      state.loading = false;
    }
  }
}

const mapillaryLayer = {
  id: LAYER_ID,
  name: 'Mapillary Imagery',
  icon: '⬡',
  source: 'Mapillary',
  updateInterval: 0,
  statsRefreshInterval: 1000,
  init(viewer) {
    state.viewer = viewer;
    state.dataSource = new Cesium.CustomDataSource(LAYER_ID);
    state.dataSource.show = false;
    viewer.dataSources.add(state.dataSource);
    state.moveEndRemove = viewer.camera.moveEnd.addEventListener(scheduleLoad);
    installInteraction(viewer);
  },
  enable() {
    state.enabled = true;
    if (state.dataSource) state.dataSource.show = true;
    setOverlaySourceVisible(OVERLAY_SOURCE_ID, true);
    registerPickOwner(LAYER_ID, (id) => state.recordByEntityId.has(id));
    syncCredit(state.records.length > 0);
  },
  disable() {
    state.enabled = false;
    state.altitudeGate = false;
    unregisterPickOwner(LAYER_ID);
    clearTimeout(state.debounceTimer);
    state.debounceTimer = null;
    clearRetry();
    state.abort?.abort();
    state.abort = null;
    state.loading = false;
    state.error = null;
    state.keyRequired = false;
    if (state.dataSource) state.dataSource.show = false;
    clearSelection();
    setOverlaySourceVisible(OVERLAY_SOURCE_ID, false);
    syncCredit(false);
    state.status = 'idle';
  },
  update() { return loadImages(); },
  setParams(params = {}) {
    const requested = String(params.timeRange ?? state.timeRange).toLowerCase();
    if (!['all', '12m', '30d'].includes(requested)) return false;
    if (requested === state.timeRange) return true;
    state.timeRange = requested;
    state.lastBounds = null;
    state.abort?.abort();
    state.abort = null;
    clearRetry();
    clearRendered();
    if (state.enabled) void loadImages({ force: true });
    return true;
  },
  getParams() {
    return { timeRange: state.timeRange };
  },
  getRowControls() {
    return {
      chips: [
        {
          id: 'all', label: 'ALL', active: state.timeRange === 'all',
          title: 'Show imagery from any capture date', params: { timeRange: 'all' },
        },
        {
          id: '12m', label: '12M', active: state.timeRange === '12m',
          title: 'Show imagery captured in the last 12 months', params: { timeRange: '12m' },
        },
        {
          id: '30d', label: '30D', active: state.timeRange === '30d',
          title: 'Show imagery captured in the last 30 days', params: { timeRange: '30d' },
        },
      ],
      legend: [],
    };
  },
  destroy(viewer) {
    this.disable();
    state.moveEndRemove?.();
    state.moveEndRemove = null;
    state.clickHandler?.destroy();
    state.clickHandler = null;
    clearRendered();
    if (state.dataSource && viewer) viewer.dataSources.remove(state.dataSource, true);
    state.dataSource = null;
    state.viewer = null;
  },
  getStats() {
    let loadingLabel = '';
    if (state.loading) loadingLabel = state.records.length ? 'refreshing...' : 'loading...';
    else if (state.keyRequired) loadingLabel = 'KEY REQUIRED';
    else if (state.status === 'zoom-in') loadingLabel = 'Zoom in for Mapillary imagery';
    else if (state.status === 'empty') loadingLabel = 'No Mapillary imagery in view';
    else if (state.saturated) loadingLabel = 'Showing a spaced sample';
    else if (state.error && state.retryAt > Date.now()) {
      loadingLabel = `${state.error} · retry in ${Math.ceil((state.retryAt - Date.now()) / 1000)}s`;
    } else if (state.error) loadingLabel = state.error;
    return {
      count: state.records.length,
      lastUpdate: state.lastUpdate,
      loading: state.loading,
      stale: state.stale,
      saturated: state.saturated,
      status: state.status,
      retryAt: state.retryAt,
      error: state.keyRequired ? 'KEY REQUIRED' : state.error,
      loadingLabel,
      statusMessage: loadingLabel,
    };
  },
};

export default mapillaryLayer;
