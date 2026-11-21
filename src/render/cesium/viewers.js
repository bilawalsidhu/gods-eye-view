/**
 * @module render/cesium/viewers
 * @description The Cesium viewer behind each renderer the application's
 * plugin made (`appRenderer.js`), and the viewer behind a scene object the app
 * holds: the one its bound renderer draws with, or the scene object itself
 * when it is a viewer with no renderer bound.
 */
import { rendererOf } from '../rendererOf.js';

const viewers = new WeakMap();

/**
 * Record `viewer` as the one behind `renderer`.
 * @param {object} renderer
 * @param {object} viewer
 */
export function recordViewer(renderer, viewer) {
  viewers.set(renderer, viewer);
}

/**
 * The Cesium viewer behind a renderer the application's plugin made, or
 * null for the test stub.
 * @param {object} renderer
 * @returns {object|null}
 */
export const cesiumViewerOf = (renderer) =>
  (renderer && viewers.get(renderer)) || null;

/**
 * The Cesium viewer behind the scene object `host`: its bound renderer's,
 * else `host` itself (a viewer with no renderer bound, or none at all).
 * @param {object|null|undefined} host
 * @returns {object|null|undefined}
 */
export const viewerBehind = (host) => cesiumViewerOf(rendererOf(host)) ?? host;
