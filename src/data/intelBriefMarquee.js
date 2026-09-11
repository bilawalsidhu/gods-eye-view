/**
 * @module intelBriefMarquee
 * Alt+drag screen marquee → geographic bounds → nearby live records.
 */

import * as Cesium from 'cesium';
import { haversineKm } from './analystEngine.js';
import { estimateBoundsAreaKm2 } from './intelAreaContext.js';
import { summarizeRecordForBrief } from './entityBriefContext.js';

const INTEL_LAYER_IDS = [
  'cctv',
  'flights',
  'military',
  'ais-live-vessels',
  'radio',
  'satellites',
  'earthquakes',
  'local-firms',
];

const MIN_MARQUEE_PX = 14;
const MAX_CONTACTS = 28;
const MAX_PER_LAYER = 6;
const SCREEN_MATCH_PAD_PX = 8;

export function normalizeScreenRect(x1, y1, x2, y2) {
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const right = Math.max(x1, x2);
  const bottom = Math.max(y1, y2);
  return {
    left,
    top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

export function marqueeLargeEnough(rect, minPx = MIN_MARQUEE_PX) {
  return rect.width >= minPx && rect.height >= minPx;
}

export function recordInGeoBounds(record, bounds) {
  const lat = Number(record?.lat);
  const lon = Number(record?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !bounds) return false;
  if (lat < bounds.south || lat > bounds.north) return false;
  if (bounds.crossesAntimeridian) {
    return lon >= bounds.west || lon <= bounds.east;
  }
  return lon >= bounds.west && lon <= bounds.east;
}

export function boundsFromCartographics(points) {
  const valid = (points || []).filter((p) => p && Number.isFinite(p.latitude) && Number.isFinite(p.longitude));
  if (!valid.length) return null;

  let south = Infinity;
  let north = -Infinity;
  let west = Infinity;
  let east = -Infinity;
  for (const point of valid) {
    const lat = Cesium.Math.toDegrees(point.latitude);
    const lon = Cesium.Math.toDegrees(point.longitude);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
    west = Math.min(west, lon);
    east = Math.max(east, lon);
  }

  const crossesAntimeridian = (east - west) > 180;
  return {
    south,
    north,
    west,
    east,
    crossesAntimeridian,
    center: {
      lat: (south + north) / 2,
      lon: crossesAntimeridian
        ? (((west + east + 360) / 2) % 360 + 360) % 360 - 180
        : (west + east) / 2,
    },
  };
}

export function pickCartographic(scene, x, y) {
  const position = new Cesium.Cartesian2(x, y);
  if (scene.pickPositionSupported) {
    const picked = scene.pickPosition(position);
    if (Cesium.defined(picked)) {
      return Cesium.Cartographic.fromCartesian(picked);
    }
  }
  const ray = scene.camera.getPickRay(position);
  if (!ray) return null;
  const hit = scene.globe?.pick(ray, scene);
  if (!Cesium.defined(hit)) return null;
  return Cesium.Cartographic.fromCartesian(hit);
}

export function screenRectToGeoBounds(viewer, rect) {
  if (!viewer?.scene || !rect) return null;
  const canvas = viewer.scene.canvas;
  const box = canvas.getBoundingClientRect();
  const samples = [
    pickCartographic(viewer.scene, rect.left - box.left, rect.top - box.top),
    pickCartographic(viewer.scene, rect.left - box.left + rect.width, rect.top - box.top),
    pickCartographic(viewer.scene, rect.left - box.left, rect.top - box.top + rect.height),
    pickCartographic(viewer.scene, rect.left - box.left + rect.width, rect.top - box.top + rect.height),
    pickCartographic(viewer.scene, rect.left - box.left + rect.width / 2, rect.top - box.top + rect.height / 2),
  ];
  return boundsFromCartographics(samples);
}

export function recordInScreenRect(viewer, record, screenRect, padPx = SCREEN_MATCH_PAD_PX) {
  if (!viewer?.scene || !screenRect) return false;
  const lat = Number(record?.lat ?? record?.latitude);
  const lon = Number(record?.lon ?? record?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;

  let altitudeM = Number(record?.altitudeM ?? record?.altitude);
  if (!Number.isFinite(altitudeM) && Number.isFinite(record?.altitudeFt)) {
    altitudeM = record.altitudeFt * 0.3048;
  }
  if (!Number.isFinite(altitudeM)) altitudeM = 0;

  const cartesian = Cesium.Cartesian3.fromDegrees(lon, lat, altitudeM);
  const win = Cesium.SceneTransforms.worldToWindowCoordinates(viewer.scene, cartesian);
  if (!win) return false;

  const canvasRect = viewer.scene.canvas.getBoundingClientRect();
  const x = canvasRect.left + win.x;
  const y = canvasRect.top + win.y;
  return x >= screenRect.left - padPx
    && x <= screenRect.left + screenRect.width + padPx
    && y >= screenRect.top - padPx
    && y <= screenRect.top + screenRect.height + padPx;
}

const MAX_GEO_AREA_KM2 = 2500;
const MAX_GEO_SPAN_DEG = 12;

/** Oblique marquee corners often produce a huge, meaningless geo bbox. */
export function isReliableMarqueeBounds(bounds, areaKm2 = null) {
  if (!bounds) return false;
  const approx = areaKm2 ?? estimateBoundsAreaKm2(bounds);
  if (Number.isFinite(approx) && approx > MAX_GEO_AREA_KM2) return false;
  const latSpan = Math.abs(bounds.north - bounds.south);
  let lonSpan = Math.abs(bounds.east - bounds.west);
  if (bounds.crossesAntimeridian) lonSpan = 360 - lonSpan;
  if (latSpan > MAX_GEO_SPAN_DEG || lonSpan > MAX_GEO_SPAN_DEG) return false;
  return true;
}

export function recordMatchesSelection(viewer, record, bounds, screenRect, { geoReliable = true } = {}) {
  if (screenRect && viewer) {
    const inScreen = recordInScreenRect(viewer, record, screenRect);
    if (!inScreen) return false;
    if (!geoReliable || !bounds) return true;
    return recordInGeoBounds(record, bounds);
  }
  if (bounds && geoReliable) return recordInGeoBounds(record, bounds);
  return false;
}

function normalizeLayerRecord(record, layerId) {
  const lat = Number(record?.lat ?? record?.latitude);
  const lon = Number(record?.lon ?? record?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    ...record,
    id: record.id || record.icao24 || record.mmsi || `${layerId}-${lat.toFixed(3)}-${lon.toFixed(3)}`,
    lat,
    lon,
  };
}

function layerRecordRows(mod, layerId, maxCount) {
  const limit = Number.isFinite(maxCount) ? Math.max(1, Math.floor(maxCount)) : 2000;
  const rows = [];
  const seen = new Set();

  if (typeof mod?.getAnalystRecords === 'function') {
    for (const record of mod.getAnalystRecords(limit) || []) {
      const normalized = normalizeLayerRecord(record, layerId);
      if (!normalized) continue;
      const key = `${layerId}:${normalized.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(normalized);
    }
  }

  if (typeof mod?.getAllPositions === 'function') {
    for (const entry of mod.getAllPositions(Math.min(limit, 1500)) || []) {
      const normalized = normalizeLayerRecord(entry, layerId);
      if (!normalized) continue;
      const key = `${layerId}:${normalized.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(normalized);
    }
  }

  return rows;
}

export function collectRecordsInBounds(dataManager, bounds, {
  viewer = null,
  screenRect = null,
  layerIds = INTEL_LAYER_IDS,
  maxContacts = MAX_CONTACTS,
  maxPerLayer = MAX_PER_LAYER,
} = {}) {
  if (!dataManager?.layers || (!bounds && !screenRect)) return [];
  const areaKm2 = estimateBoundsAreaKm2(bounds);
  const geoReliable = isReliableMarqueeBounds(bounds, areaKm2);
  const picked = [];

  for (const layerId of layerIds) {
    const entry = dataManager.layers.get(layerId);
    if (!entry || !dataManager.isEnabled(layerId)) continue;

    const inSelection = layerRecordRows(entry.module, layerId, 4000)
      .filter((record) => recordMatchesSelection(viewer, record, bounds, screenRect, { geoReliable }))
      .slice(0, maxPerLayer);

    const center = bounds?.center;
    for (const record of inSelection) {
      picked.push({
        layerId,
        layerName: entry.module?.name || layerId,
        distanceKm: center
          ? haversineKm(center.lat, center.lon, record.lat, record.lon)
          : 0,
        record,
      });
    }
  }

  return picked
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, maxContacts)
    .map((item) => ({
      ...summarizeRecordForBrief({
        id: item.record.id || item.record.icao24 || item.record.mmsi || `${item.layerId}-${item.record.lat}`,
        layerId: item.layerId,
        layerName: item.layerName,
        label: item.record.callsign || item.record.registration || item.record.name
          || item.record.id || item.record.icao24 || item.record.mmsi || item.layerName,
        latitude: item.record.lat,
        longitude: item.record.lon,
        properties: item.record,
      }),
      distanceKm: Number(item.distanceKm.toFixed(2)),
    }));
}

function setCameraInputs(controller, enabled) {
  controller.enableRotate = enabled;
  controller.enableTranslate = enabled;
  controller.enableZoom = enabled;
  controller.enableTilt = enabled;
  controller.enableLook = enabled;
}

/**
 * @param {object} options
 * @param {import('cesium').Viewer} options.viewer
 * @param {(payload: object) => void} options.onComplete
 */
export function createIntelBriefMarquee(options = {}) {
  const viewer = options.viewer;
  const onComplete = typeof options.onComplete === 'function' ? options.onComplete : () => {};
  const layer = document.getElementById('intel-brief-marquee-layer');
  const box = document.getElementById('intel-brief-marquee-box');
  const hint = document.getElementById('intel-brief-marquee-hint');

  if (!viewer?.scene?.canvas || !layer || !box) {
    return { destroy() {} };
  }

  const scene = viewer.scene;
  const controller = scene.screenSpaceCameraController;
  const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
  let altArmed = false;
  let dragging = false;
  let start = null;
  let cameraLocked = false;
  const activeHighlights = new Set();

  function setHint(visible, text) {
    if (!hint) return;
    if (text) hint.textContent = text;
    hint.hidden = !visible;
    layer.classList.toggle('armed', visible);
  }

  function updateBox(rect) {
    if (!rect || rect.width < 1 || rect.height < 1) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    box.style.left = `${rect.left}px`;
    box.style.top = `${rect.top}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
  }

  function lockCamera() {
    if (cameraLocked) return;
    cameraLocked = true;
    setCameraInputs(controller, false);
  }

  function unlockCamera() {
    if (!cameraLocked) return;
    cameraLocked = false;
    setCameraInputs(controller, true);
  }

  function addHighlight(bounds) {
    if (!bounds) return () => {};
    const { west, south, east, north } = bounds;
    const entity = viewer.entities.add({
      name: 'intel-brief-selection',
      rectangle: {
        coordinates: Cesium.Rectangle.fromDegrees(west, south, east, north),
        material: Cesium.Color.fromCssColorString('#00d4ff').withAlpha(0.08),
        outline: true,
        outlineColor: Cesium.Color.fromCssColorString('#00d4ff').withAlpha(0.85),
        outlineWidth: 2,
        height: 0,
      },
    });
    activeHighlights.add(entity);
    return () => {
      try {
        viewer.entities.remove(entity);
      } catch { /* entity may already be gone */ }
      activeHighlights.delete(entity);
    };
  }

  function clearAllHighlights() {
    for (const entity of activeHighlights) {
      try {
        viewer.entities.remove(entity);
      } catch { /* ignore */ }
    }
    activeHighlights.clear();
  }

  function clientRectFromMovement(position) {
    const canvas = scene.canvas;
    const boxRect = canvas.getBoundingClientRect();
    return {
      left: boxRect.left + position.x,
      top: boxRect.top + position.y,
    };
  }

  function finishDrag(endEvent) {
    if (!dragging || !start) return;
    dragging = false;
    unlockCamera();
    setHint(false);

    const end = clientRectFromMovement(endEvent.position);
    const rect = normalizeScreenRect(start.left, start.top, end.left, end.top);
    updateBox(null);

    if (!marqueeLargeEnough(rect)) return;

    const bounds = screenRectToGeoBounds(viewer, rect);
    if (!bounds) return;

    const releaseHighlight = addHighlight(bounds);
    onComplete({ rect, bounds, releaseHighlight });
  }

  handler.setInputAction((movement) => {
    if (!altArmed) return;
    const point = clientRectFromMovement(movement.position);
    dragging = true;
    start = point;
    lockCamera();
    updateBox(normalizeScreenRect(point.left, point.top, point.left, point.top));
    setHint(true, 'Release to analyze selection');
  }, Cesium.ScreenSpaceEventType.LEFT_DOWN, Cesium.KeyboardEventModifier.ALT);

  handler.setInputAction((movement) => {
    if (!dragging || !start) return;
    const point = clientRectFromMovement(movement.endPosition);
    updateBox(normalizeScreenRect(start.left, start.top, point.left, point.top));
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE, Cesium.KeyboardEventModifier.ALT);

  handler.setInputAction((movement) => {
    finishDrag(movement);
  }, Cesium.ScreenSpaceEventType.LEFT_UP, Cesium.KeyboardEventModifier.ALT);

  const onKeyDown = (event) => {
    if (event.key !== 'Alt') return;
    altArmed = true;
    if (!dragging) setHint(true, 'Alt held · drag to identify this area');
  };

  const onKeyUp = (event) => {
    if (event.key !== 'Alt') return;
    altArmed = false;
    if (!dragging) setHint(false);
  };

  const onBlur = () => {
    altArmed = false;
    dragging = false;
    start = null;
    unlockCamera();
    updateBox(null);
    setHint(false);
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  return {
    destroy() {
      handler.destroy();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      unlockCamera();
      clearAllHighlights();
      updateBox(null);
      setHint(false);
    },
    addHighlight,
    clearAllHighlights,
  };
}

export default createIntelBriefMarquee;
