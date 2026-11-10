// The page session's tools that outlive a globe engine: the annotation board,
// UTILITIES ▸ Draw and UTILITIES ▸ Import. Each is created once per page
// session (destroyed with the page) and attaches its drawing to whichever
// engine the page shows (src/app/tools.js; on Navara through its tool
// backend, src/app/navaraMode.js).

import { createSessionAnnotations } from '../annotations/index.js';
import { createSessionDrawTool } from '../annotations/drawTool.js';
import { createGeoFileImport } from '../ui/geoFileImport.js';
import { useDisplayStore } from '../ui/stores/display.js';
import { applicationPinia } from '../ui/vueRuntime.js';

/**
 * The annotation board: the page session's when there is one (created once,
 * destroyed with the page), else this application's.
 */
export function sessionAnnotations({
  layerSession,
  placeSearch,
  resolver,
  defer,
}) {
  const create = () => createSessionAnnotations({ placeSearch, resolver });
  if (!layerSession) {
    const annotations = create();
    defer(() => destroyAnnotations(annotations));
    return annotations;
  }
  if (!layerSession.annotations) {
    const annotations = (layerSession.annotations = create());
    layerSession.lifetime.signal.addEventListener(
      'abort',
      () => destroyAnnotations(annotations),
      { once: true },
    );
  }
  return layerSession.annotations;
}

/**
 * A tool of the page session (created once, destroyed with the page) when
 * there is one, else of this application. `create()` may return null.
 */
export function sessionTool(layerSession, name, defer, create) {
  if (!layerSession) {
    const tool = create();
    defer(() => tool?.destroy());
    return tool;
  }
  const tools = (layerSession.tools ??= {});
  if (!(name in tools)) {
    const tool = (tools[name] = create());
    layerSession.lifetime.signal.addEventListener(
      'abort',
      () => tool?.destroy(),
      { once: true },
    );
  }
  return tools[name];
}

function destroyAnnotations(annotations) {
  if (window.__gevAnnotations === annotations) delete window.__gevAnnotations;
  annotations.destroy();
}

/**
 * The Display panel's store and `connectDisplay(actions)`: the panel's
 * controls answer through the store; returns the disconnect.
 */
export function displayControls() {
  const displayStore = useDisplayStore(applicationPinia());
  const connectDisplay = (actions) => {
    const token = displayStore.connect(actions);
    return () => displayStore.detach(token);
  };
  return { displayStore, connectDisplay };
}

/**
 * UTILITIES ▸ Draw: the same whiteboard, drawn by hand. The marks and the
 * chosen shape belong to the page session; the tool claims the attached
 * globe's pointer while a sketch is open, so an engine switch ends the
 * sketch. A row's fly-to goes through the shell's navigation policy, as
 * Import's does. Null on a page without the Draw controls.
 */
export function sessionDrawTool({
  layerSession,
  annotations,
  styleManager,
  markActions = [],
  defer,
}) {
  const { displayStore, connectDisplay } = displayControls();
  return sessionTool(layerSession, 'draw', defer, () =>
    createSessionDrawTool({
      annotations,
      navigation: styleManager,
      publish: (view) => displayStore.publishDraw(view),
      connect: connectDisplay,
      markActions,
    }),
  );
}

/**
 * UTILITIES ▸ Import: the person's own GeoJSON/KML/KMZ/GPX files, each its
 * own data source. They live for the page session: an engine switch takes
 * them off the globe, and the next globe reads them again. The drop
 * listeners belong to the attached globe. Null on a page without the
 * Import control.
 */
export function sessionGeoImport({
  layerSession,
  styleManager,
  operations,
  defer,
}) {
  const { displayStore, connectDisplay } = displayControls();
  return sessionTool(layerSession, 'geoImport', defer, () =>
    createGeoFileImport({
      navigation: styleManager,
      ground: operations.surface?.groundFloor,
      publish: (view) => displayStore.publishGeoImport(view),
      connect: connectDisplay,
    }),
  );
}
