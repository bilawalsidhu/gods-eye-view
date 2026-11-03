// The page session's annotation board, Draw and Import on the experimental
// Navara engine (src/app/sessionTools.js holds the tools themselves). Loaded
// with src/app/navaraMode.js, so the Cesium-mode bundle carries none of it.

import { createNavaraAnnotationRenderer } from '../annotations/navaraAnnotationRenderer.js';
import { navaraDrawSurface } from '../annotations/drawInputNavara.js';
import { destroyScopeMask, installScopeMask } from '../scopeMask.js';
import {
  sessionAnnotations,
  sessionDrawTool,
  sessionGeoImport,
} from './sessionTools.js';

/**
 * The annotation board drawn on this Navara scene: draped areas and routes
 * on the engine, every other mark on the shared screen board. The board
 * belongs to the page session; an engine switch takes only its drawing off
 * this engine. Returns the board (null without the Navara view).
 * @param {{ engine: object, views: object }} scene `views`: the Navara view
 *   and its classes (src/app/navaraMode.js).
 */
export function attachNavaraAnnotations(
  { engine, views },
  { layerSession, placeSearch, operations },
  { defer },
) {
  if (!views?.view) return null;
  const annotations = sessionAnnotations({
    layerSession,
    placeSearch,
    resolver: operations.annotationResolver,
    defer,
  });
  annotations.attachScene({
    engine,
    renderer: createNavaraAnnotationRenderer(engine, views),
  });
  defer(() => annotations.detachScene());
  return annotations;
}

/**
 * UTILITIES ▸ Draw on this Navara scene: the session's tool on the engine's
 * input and preview (src/annotations/drawInputNavara.js). A switch ends an
 * open sketch and keeps the chosen shape and colour. Returns the tool (null
 * on a page without it or without the board).
 */
export function attachNavaraDraw(
  { engine },
  { layerSession, annotations, styleManager },
  { defer },
) {
  if (!annotations) return null;
  const drawTool = sessionDrawTool({
    layerSession,
    annotations,
    styleManager,
    defer,
  });
  drawTool?.attachScene({
    surface: navaraDrawSurface(engine),
    navigation: styleManager,
  });
  defer(() => drawTool?.detachScene());
  return drawTool;
}

/**
 * UTILITIES ▸ Import on this Navara scene: the session's files drawn by
 * `drawImported(engine, dataSource)` (src/layers/shared/render/navaraStory.js,
 * loaded by src/app/navaraMode.js), what Navara leaves out of them reported
 * in the control's hint; drops and camera gestures on this engine's canvas.
 * Returns the control (null on a page without it or without the view).
 */
export function attachNavaraGeoImport(
  { engine, views, mapStackController },
  { layerSession, styleManager, operations, drawImported },
  { defer },
) {
  if (!views?.view || typeof drawImported !== 'function') return null;
  const geoFileImport = sessionGeoImport({
    layerSession,
    styleManager,
    operations,
    defer,
  });
  geoFileImport?.attachScene({
    engine,
    draw: (dataSource) => drawImported(engine, dataSource),
    navigation: styleManager,
    subscribeMapSource: (listener) => mapStackController?.subscribe?.(listener),
  });
  defer(() => geoFileImport?.detachScene());
  return geoFileImport;
}

/**
 * The DISPLAY scope mask over this Navara scene: the same canvas as on
 * Cesium, in the engine's container, its terminus following the engine
 * camera's height. It goes with the engine.
 */
export function attachNavaraScopeMask({ engine }, _context, { defer }) {
  installScopeMask(engine);
  defer(() => destroyScopeMask());
}
