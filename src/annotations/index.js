import { createAnnotationEngine } from './annotationEngine.js';
import { createHybridAnnotationRenderer } from './hybridAnnotationRenderer.js';

/**
 * Create the map-annotation engine over the hybrid renderer (world-space footprints,
 * screen-space callouts) and expose it as `window.__gevAnnotations`.
 */
export function initAnnotations({
  viewer,
  tileset = null,
  placeSearch,
  resolver,
}) {
  // World-space footprint draping; clamped marks can use the photoreal tiles.
  if (tileset) tileset.enableCollision = true;
  const renderer = createHybridAnnotationRenderer(viewer);
  const engine = createAnnotationEngine({
    viewer,
    renderer,
    placeSearch,
    resolveTarget: resolver?.resolveAnnotationTarget,
  });
  window.__gevAnnotations = engine;
  return engine;
}
