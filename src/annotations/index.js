import { createAnnotationEngine } from './annotationEngine.js';
import { createHybridAnnotationRenderer } from './hybridAnnotationRenderer.js';

/**
 * Initialize the map-annotation engine and expose it for the voice agent and
 * for manual/dev use via `window.__gevAnnotations`.
 *
 * This module is the single swap point between annotation rendering strategies.
 * This branch (Direction C) uses the HYBRID renderer: world-space draping for
 * footprints + screen-space SVG for callouts/rings/arrows. The engine, resolver,
 * and voice tool wiring are identical to the other two branches.
 */
export function initAnnotations({
  viewer,
  engine: globe = null,
  tileset = null,
  placeSearch,
  resolver,
}) {
  const engine = createSessionAnnotations({ placeSearch, resolver });
  engine.attachScene({ viewer, engine: globe, tileset });
  return engine;
}

/**
 * The page's annotation board, kept across globe engine switches: the marks
 * belong to the page session, their drawing to the attached globe. The board
 * works on the globe `engine` (camera, picks, surface); its drawing is the
 * `renderer` built for that engine (Navara:
 * src/annotations/navaraAnnotationRenderer.js, built by the caller so this
 * module never loads it), or on a Cesium `viewer` the hybrid renderer built
 * here. `attachScene({ engine, viewer, tileset })` or
 * `attachScene({ engine, renderer })`; with neither the marks stay undrawn.
 * `detachScene()` releases the drawing and keeps the marks.
 */
export function createSessionAnnotations({ placeSearch, resolver }) {
  const engine = createAnnotationEngine({
    placeSearch,
    resolveTarget: resolver?.resolveAnnotationTarget,
  });
  engine.attachScene = ({
    viewer = null,
    tileset = null,
    engine: globe = null,
    renderer = null,
  } = {}) => {
    if (renderer) return engine.attachRenderer({ engine: globe, renderer });
    if (!viewer) return engine.detachRenderer();
    // World-space footprint draping; clamped marks can use the photoreal tiles.
    if (tileset) {
      try {
        tileset.enableCollision = true;
      } catch {
        /* older tileset */
      }
    }
    engine.attachRenderer({
      engine: globe,
      renderer: createHybridAnnotationRenderer(viewer, { engine: globe }),
    });
  };
  engine.detachScene = () => engine.detachRenderer();
  window.__gevAnnotations = engine;
  return engine;
}
