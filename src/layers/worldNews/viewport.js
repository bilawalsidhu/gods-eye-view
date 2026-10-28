/**
 * @file Camera → news region for the "NEWS IN VIEW" chip.
 *
 * The geometry and the band rules live in src/data/worldNewsRegion.js, which
 * is Cesium-free so the proxy can share them. This module is the thin Cesium
 * half: it reads the camera, hands that module a plain rectangle and look-at
 * point, and reports when the camera has settled somewhere new so the chip can
 * repaint. Nothing here fetches.
 *
 * @module layers/worldNews/viewport
 */

import * as Cesium from 'cesium';
import { deriveFetchCenter } from '../../data/trafficBounds.js';
import { resolveNewsRegion } from '../../data/worldNewsRegion.js';
import { REGION_LOOKAT_PULL_KM } from './policy.js';

/**
 * The camera's view rectangle in degrees.
 * @param {object} viewer Cesium viewer (or a stand-in exposing `camera`).
 * @returns {{west:number, south:number, east:number, north:number}|null}
 *   Degrees, or null when the camera sees no globe (looking at the sky).
 */
export function readViewRect(viewer) {
  const rect = viewer?.camera?.computeViewRectangle?.();
  if (!rect) return null;
  const { west, south, east, north } = rect;
  if (![west, south, east, north].every(Number.isFinite)) return null;
  return {
    west: Cesium.Math.toDegrees(west),
    south: Cesium.Math.toDegrees(south),
    east: Cesium.Math.toDegrees(east),
    north: Cesium.Math.toDegrees(north),
  };
}

/**
 * The ground point the camera is aimed at, in degrees.
 *
 * Follows the traffic layer's C4 rule: the rectangle's midpoint drifts toward
 * the horizon at oblique pitch, so the ellipsoid hit under the canvas centre
 * wins, with the camera nadir as the fallback on a sky look and a pull-back
 * for horizon gazes. `pickEllipsoid` is used rather than `scene.globe.pick`
 * because the globe is hidden under Google's 3D tiles.
 *
 * @param {object} viewer Cesium viewer.
 * @returns {{lat:number, lon:number, source:'hit'|'nadir'|'pulled'}|null}
 *   Look-at point, or null when the camera position is unavailable.
 */
export function readLookAt(viewer) {
  const carto = viewer?.camera?.positionCartographic;
  if (!carto || !Number.isFinite(carto.latitude)) return null;
  const nadirLat = Cesium.Math.toDegrees(carto.latitude);
  const nadirLon = Cesium.Math.toDegrees(carto.longitude);

  let hitLat;
  let hitLon;
  const canvas = viewer?.scene?.canvas;
  const width = canvas?.clientWidth || canvas?.width || 0;
  const height = canvas?.clientHeight || canvas?.height || 0;
  if (width > 0 && height > 0 && viewer.camera.pickEllipsoid) {
    const hit = viewer.camera.pickEllipsoid(
      new Cesium.Cartesian2(width / 2, height / 2),
      Cesium.Ellipsoid.WGS84,
    );
    if (hit) {
      const hitCarto = Cesium.Cartographic.fromCartesian(hit);
      hitLat = Cesium.Math.toDegrees(hitCarto.latitude);
      hitLon = Cesium.Math.toDegrees(hitCarto.longitude);
    }
  }
  return deriveFetchCenter({
    nadirLat,
    nadirLon,
    hitLat,
    hitLon,
    maxPullKm: REGION_LOOKAT_PULL_KM,
  });
}

/**
 * Which news region the current camera is asking for.
 *
 * The returned `key` is local bookkeeping only: the proxy re-derives its own
 * cache key from lat/lon/radius under ITS configured language, and the region
 * it echoes back in the payload is the authoritative one.
 *
 * @param {object} viewer Cesium viewer.
 * @returns {{band:'local'|'global', key:string,
 *   center?:{lat:number,lon:number}, radiusKm?:number}} Band 'global' means no
 *   circle covers this view — the operator is too high for a metro query.
 */
export function resolveViewerRegion(viewer) {
  return resolveNewsRegion({
    rect: readViewRect(viewer),
    lookAt: readLookAt(viewer),
  });
}

/**
 * Call `onSettle` whenever the camera comes to rest.
 *
 * The chip's enabled state is a function of the camera, but the layer panel
 * only repaints on layer status changes — without this the chip would stay
 * greyed out after the operator zoomed in far enough to use it. `moveEnd`
 * fires once when the camera stops, so this costs nothing while flying.
 *
 * @param {object} viewer Cesium viewer.
 * @param {() => void} onSettle Called after each camera move completes.
 * @returns {() => void} Disposer; safe to call more than once.
 */
export function watchCameraSettle(viewer, onSettle) {
  const moveEnd = viewer?.camera?.moveEnd;
  if (typeof moveEnd?.addEventListener !== 'function') return () => {};
  const listener = () => {
    try {
      onSettle();
    } catch (error) {
      console.warn('[Data:WorldNews] camera settle listener failed:', error);
    }
  };
  moveEnd.addEventListener(listener);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    moveEnd.removeEventListener?.(listener);
  };
}
