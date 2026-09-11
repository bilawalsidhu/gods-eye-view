/**
 * @module intelAreaContext
 * Marquee selection context: viewport capture, bounds summary, landmarks, asset grouping.
 */

import { haversineKm } from './analystEngine.js';
import { CITY_POIS } from '../locations.js';

const LAYER_GROUP_ORDER = Object.freeze([
  ['cctv', 'Cameras'],
  ['flights', 'Aircraft'],
  ['military', 'Military aircraft'],
  ['ais-live-vessels', 'Vessels'],
  ['radio', 'Radio'],
  ['satellites', 'Satellites'],
  ['earthquakes', 'Seismic'],
  ['local-firms', 'Active fires'],
]);

const THUMB_MAX_WIDTH = 768;
const THUMB_MAX_HEIGHT = 768;

/** Rough bounding-box area in km² for marquee context. */
export function estimateBoundsAreaKm2(bounds) {
  if (!bounds) return null;
  const { south, north, west, east, center } = bounds;
  if (![south, north, west, east].every(Number.isFinite)) return null;
  const latMid = Number.isFinite(center?.lat) ? center.lat : (south + north) / 2;
  const kmPerDegLat = 111.32;
  const kmPerDegLon = kmPerDegLat * Math.cos(latMid * Math.PI / 180);
  const heightKm = Math.abs(north - south) * kmPerDegLat;
  const widthKm = Math.abs(east - west) * kmPerDegLon;
  const area = heightKm * widthKm;
  return Number.isFinite(area) && area > 0 ? Math.round(area) : null;
}

function poiInBounds(poi, bounds) {
  if (!poi || !bounds) return false;
  const { south, north, west, east, crossesAntimeridian } = bounds;
  if (poi.lat < south || poi.lat > north) return false;
  if (crossesAntimeridian) return poi.lon >= west || poi.lon <= east;
  return poi.lon >= west && poi.lon <= east;
}

/** Scale landmark search to selection size — avoid Dubai-at-160km noise on ocean boxes. */
export function landmarkSearchRadiusKm(bounds, areaKm2 = null) {
  const approx = areaKm2 ?? estimateBoundsAreaKm2(bounds);
  if (!Number.isFinite(approx) || approx <= 0) return 3;
  const radiusKm = Math.sqrt(approx / Math.PI);
  return Math.min(Math.max(radiusKm * 1.5, 3), 30);
}

/** Known catalog landmarks inside or near the marquee bounds (no hallucination). */
export function landmarksNearBounds(bounds, { maxDistanceKm, maxResults = 3, areaKm2 = null } = {}) {
  if (!bounds?.center) return [];
  const limitKm = Number.isFinite(maxDistanceKm)
    ? maxDistanceKm
    : landmarkSearchRadiusKm(bounds, areaKm2);
  const matches = [];

  for (const [, city] of Object.entries(CITY_POIS)) {
    for (const poi of city.pois || []) {
      const inSelection = poiInBounds(poi, bounds);
      const distanceKm = haversineKm(bounds.center.lat, bounds.center.lon, poi.lat, poi.lon);
      if (!inSelection && distanceKm > limitKm) continue;
      matches.push({
        name: poi.name,
        city: city.name,
        distanceKm: Number(distanceKm.toFixed(2)),
        inSelection,
      });
    }
  }

  return matches
    .sort((a, b) => {
      if (a.inSelection !== b.inSelection) return a.inSelection ? -1 : 1;
      return a.distanceKm - b.distanceKm;
    })
    .slice(0, maxResults);
}

export function formatCoord(value, positiveSuffix, negativeSuffix) {
  if (!Number.isFinite(value)) return '—';
  const suffix = value >= 0 ? positiveSuffix : negativeSuffix;
  return `${Math.abs(value).toFixed(3)}°${suffix}`;
}

/** Human-readable footprint — skip raw coordinate dumps for huge/oblique selections. */
export function formatBoundsSummary(bounds, areaKm2 = null) {
  if (!bounds) return '';
  const approx = areaKm2 ?? estimateBoundsAreaKm2(bounds);
  if (!Number.isFinite(approx) || approx <= 0) return '';
  if (approx >= 50_000) {
    return 'Wide on-screen selection — contacts match what you boxed, not the full geo footprint.';
  }
  if (approx < 1) return `Roughly ${(approx * 100).toFixed(0)} hectares.`;
  if (approx < 100) return `Roughly ${approx < 10 ? approx.toFixed(1) : Math.round(approx)} km across.`;
  return `Roughly ${Math.round(approx)} km² footprint.`;
}

export function summarizeAssetCounts(contacts = []) {
  const counts = {
    cctv: 0,
    aircraft: 0,
    radio: 0,
    vessels: 0,
    satellites: 0,
    seismic: 0,
    fires: 0,
    other: 0,
  };

  for (const contact of contacts) {
    switch (contact?.layerId) {
      case 'cctv': counts.cctv += 1; break;
      case 'flights':
      case 'military': counts.aircraft += 1; break;
      case 'radio': counts.radio += 1; break;
      case 'ais-live-vessels': counts.vessels += 1; break;
      case 'satellites': counts.satellites += 1; break;
      case 'earthquakes': counts.seismic += 1; break;
      case 'local-firms': counts.fires += 1; break;
      default: counts.other += 1; break;
    }
  }
  return counts;
}

export function assetCountLabel(counts = {}) {
  const parts = [];
  if (counts.cctv) parts.push(`${counts.cctv} cam${counts.cctv > 1 ? 's' : ''}`);
  if (counts.aircraft) parts.push(`${counts.aircraft} aircraft`);
  if (counts.vessels) parts.push(`${counts.vessels} vessel${counts.vessels > 1 ? 's' : ''}`);
  if (counts.radio) parts.push(`${counts.radio} radio`);
  if (counts.satellites) parts.push(`${counts.satellites} sat${counts.satellites > 1 ? 's' : ''}`);
  if (counts.seismic) parts.push(`${counts.seismic} quake${counts.seismic > 1 ? 's' : ''}`);
  if (counts.fires) parts.push(`${counts.fires} fire${counts.fires > 1 ? 's' : ''}`);
  if (counts.other) parts.push(`${counts.other} other`);
  return parts.join(' · ');
}

export function groupContactsForBrief(contacts = []) {
  const byLayer = new Map();
  for (const contact of contacts) {
    const layerId = contact?.layerId || 'other';
    if (!byLayer.has(layerId)) byLayer.set(layerId, []);
    byLayer.get(layerId).push(contact);
  }

  const groups = [];
  for (const [layerId, label] of LAYER_GROUP_ORDER) {
    const items = byLayer.get(layerId);
    if (items?.length) groups.push({ layerId, label, items });
    byLayer.delete(layerId);
  }
  for (const [layerId, items] of byLayer) {
    groups.push({ layerId, label: layerId.replace(/-/g, ' '), items });
  }
  return groups;
}

/** @returns {{ mimeType: string, width: number, height: number, dataBase64: string } | null} */
export function formatViewportCapture(thumbnail) {
  if (!thumbnail?.dataUrl) return null;
  const comma = thumbnail.dataUrl.indexOf(',');
  const dataBase64 = comma >= 0 ? thumbnail.dataUrl.slice(comma + 1) : thumbnail.dataUrl;
  if (!dataBase64) return null;
  return {
    mimeType: 'image/jpeg',
    width: thumbnail.width,
    height: thumbnail.height,
    dataBase64,
  };
}

/**
 * Wait for the next rendered frame, then crop the live Cesium canvas to the marquee.
 * @returns {Promise<{ mimeType: string, width: number, height: number, dataBase64: string } | null>}
 */
export function captureMarqueeWhenReady(viewer, screenRect, { timeoutMs = 600 } = {}) {
  return new Promise((resolve) => {
    if (!viewer?.scene?.canvas || !screenRect?.width || !screenRect?.height) {
      resolve(null);
      return;
    }

    const scene = viewer.scene;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      scene.postRender.removeEventListener(listener);
      clearTimeout(timerId);
      resolve(formatViewportCapture(captureMarqueeThumbnail(viewer, screenRect)));
    };

    const listener = () => finish();
    const timerId = setTimeout(finish, timeoutMs);

    scene.postRender.addEventListener(listener);
    scene.requestRender();
  });
}

/**
 * Crop the live Cesium canvas to the marquee screen rectangle.
 * @returns {{ dataUrl: string, width: number, height: number } | null}
 */
export function captureMarqueeThumbnail(viewer, screenRect) {
  if (!viewer?.scene?.canvas || !screenRect?.width || !screenRect?.height) return null;

  const canvas = viewer.scene.canvas;
  const canvasRect = canvas.getBoundingClientRect();
  const dpr = canvas.width / (canvasRect.width || canvas.width || 1);

  let sx = Math.round((screenRect.left - canvasRect.left) * dpr);
  let sy = Math.round((screenRect.top - canvasRect.top) * dpr);
  let sw = Math.round(screenRect.width * dpr);
  let sh = Math.round(screenRect.height * dpr);

  sx = Math.max(0, Math.min(sx, canvas.width - 1));
  sy = Math.max(0, Math.min(sy, canvas.height - 1));
  sw = Math.max(1, Math.min(sw, canvas.width - sx));
  sh = Math.max(1, Math.min(sh, canvas.height - sy));

  const aspect = sw / sh;
  let outW = THUMB_MAX_WIDTH;
  let outH = Math.round(outW / aspect);
  if (outH > THUMB_MAX_HEIGHT) {
    outH = THUMB_MAX_HEIGHT;
    outW = Math.round(outH * aspect);
  }

  const thumb = document.createElement('canvas');
  thumb.width = outW;
  thumb.height = outH;
  const ctx = thumb.getContext('2d');
  if (!ctx) return null;

  try {
    ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, outW, outH);
    return {
      dataUrl: thumb.toDataURL('image/jpeg', 0.74),
      width: outW,
      height: outH,
    };
  } catch {
    return null;
  }
}

export function buildAreaIntelSnapshot({
  bounds = null,
  contacts = [],
  landmarks = [],
  thumbnail = null,
  areaKm2 = null,
} = {}) {
  const approxKm2 = areaKm2 ?? estimateBoundsAreaKm2(bounds);
  const assetSummary = summarizeAssetCounts(contacts);
  return {
    boundsSummary: formatBoundsSummary(bounds, approxKm2),
    approxAreaKm2: approxKm2,
    assetSummary,
    assetSummaryLabel: assetCountLabel(assetSummary),
    landmarks,
    assetGroups: groupContactsForBrief(contacts),
    thumbnail,
  };
}

export default {
  landmarksNearBounds,
  formatBoundsSummary,
  estimateBoundsAreaKm2,
  summarizeAssetCounts,
  assetCountLabel,
  groupContactsForBrief,
  captureMarqueeThumbnail,
  captureMarqueeWhenReady,
  formatViewportCapture,
  buildAreaIntelSnapshot,
};
