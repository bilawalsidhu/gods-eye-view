import { createAnnotationEngine } from './annotationEngine.js';
import { createHybridAnnotationRenderer } from './hybridAnnotationRenderer.js';

/**
 * Initialize the map-annotation engine and expose it for the voice agent and
 * for manual/dev use via `window.__gevAnnotations`.
 *
 * This module is the single swap point between annotation rendering strategies.
 * The HYBRID renderer uses world-space draping for
 * footprints + screen-space SVG for callouts/rings/arrows. The engine, resolver,
 * and voice tool wiring are shared across rendering strategies.
 *
 * @param {object} root0 - Bootstrap inputs, both coming from the Cesium boot in main.js.
 * @param {import('cesium').Viewer} root0.viewer - Live viewer; the engine borrows its
 *   camera for flyTo/framing and both sub-renderers attach their surfaces to its scene.
 * @param {import('cesium').Cesium3DTileset|null} root0.tileset - Photoreal 3D tiles when that
 *   stack booted, else null; collision is enabled on it so clamped marks sit on the
 *   tiles instead of at sea level.
 * @returns {object} The initialized annotation engine (also published as
 *   `window.__gevAnnotations`).
 */
export function initAnnotations({ viewer, tileset = null }) {
  // World-space footprint draping; clamped marks can use the photoreal tiles.
  if (tileset) {
    try { tileset.enableCollision = true; } catch { /* older tileset */ }
  }
  const renderer = createHybridAnnotationRenderer(viewer);
  const engine = createAnnotationEngine({ viewer, renderer });
  window.__gevAnnotations = engine;
  return engine;
}
