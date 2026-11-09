import { t } from '../i18n/index.js';
// The experimental Navara mode (?engine=navara) of the application: its
// scene and the Navara side of the application tools. src/app/scene.js and
// src/app/tools.js load this module with import() only in that mode, and it
// loads the Navara globe the same way, so the Cesium-mode bundle carries
// none of it.

import { registerDataCredits } from '../data/dataCredits.js';
import { APPLICATION_LAYER_DIRECTORY } from './layers/directory.js';
import { LAYER_MANIFEST } from './layers/renderers.js';
import { createNavaraAnnotationRenderer } from '../annotations/navaraAnnotationRenderer.js';
import { localizeLayerName } from '../ui/layerNames.js';

/** The Navara globe module, loaded on demand. */
const loadNavaraGlobeModule = async () =>
  (await import('../globe/navara/index.js')).createNavaraGlobe;

/**
 * The shell's notice in the experimental Navara mode (label and detail): the
 * data layers this engine shows (its catalog, from the layer manifest) and
 * what it does not have.
 */
export function navaraModeNotice(manifest = LAYER_MANIFEST) {
  const names = APPLICATION_LAYER_DIRECTORY.filter(({ id }) =>
    Object.hasOwn(manifest, id),
  ).map(({ name }) => name);
  return Object.freeze({
    label: t('Experimental Navara engine'),
    detail: names.length
      ? t('Data layers: {layers}', {
          layers: names.map(localizeLayerName).join(', '),
        })
      : t('No registered data layers'),
  });
}

/**
 * The scene on the experimental Navara engine: no viewer and no Cesium
 * objects. Navara builds the map sources from the controller's descriptions
 * (Google 3D tiles from the browser key, else base imagery) and shows their
 * credits in its own attribution UI.
 */
export async function createNavaraScene({
  container = document.getElementById('cesiumContainer'),
  cesiumToken,
  credits,
  MapController,
  mapOptions,
  loaderStatus,
  loadNavaraGlobe = loadNavaraGlobeModule,
  hd = false,
  signal,
  defer,
}) {
  loaderStatus.textContent = t('Loading the experimental Navara engine...');
  const createNavaraGlobe = await loadNavaraGlobe();
  signal.throwIfAborted();
  const globe = await createNavaraGlobe({
    container,
    // The cinematic look unless `?look=photoreal|minimal` asks otherwise.
    search: globalThis.location?.search ?? '',
    // Navara HD: the device pixel ratio and MSAA (viewOptions.js).
    hd,
  });
  defer(() => globe.destroy());
  const { engine } = globe;
  signal.throwIfAborted();
  loaderStatus.textContent = t('Initializing systems...');
  const mapStackController = new MapController({
    requestRender: (reason) => engine.render.request(reason),
    engine,
    ...mapOptions,
    cesiumToken,
    onChange: (state) => {
      window.dispatchEvent(
        new CustomEvent('gev:map-stack-changed', { detail: state }),
      );
    },
    onError: (message) => console.warn('[MapStack]', message),
  });
  defer(() => mapStackController.destroy());
  await mapStackController.setStack(mapStackController.getActiveId(), {
    silent: true,
  });
  signal.throwIfAborted();
  // After the map's own credits, so Google's copyright lines come first in
  // Navara's attribution card.
  registerDataCredits(engine, credits);
  return {
    viewer: null,
    engine,
    tileset: null,
    suspend() {
      engine.camera.cancelFlight();
      engine.render.setContinuous(false);
      globe.setRenderLoop(false);
    },
    resume() {
      globe.setRenderLoop(true);
    },
    mapStackController,
  };
}

/**
 * The Navara tool backend (src/app/tools.js) of one Navara scene: where the
 * annotation board draws (on the engine and Navara's view; null
 * without the view), the Recent Imagery panel's globe, the render
 * governor on the engine, and this engine's own parts: the daylight of a
 * restored view and the engine notice.
 */
export function navaraToolBackend({ engine }) {
  const views = engine.extensions?.navara ?? null;
  const drawn = Boolean(views?.view);
  return {
    startupChrome: { initializeWelcome: null },
    board: () =>
      drawn
        ? { engine, renderer: createNavaraAnnotationRenderer(engine, views) }
        : null,
    recentImagery: () => ({ engine }),
    attach({ styleManager }, { signal, defer }) {
      void styleManager.initialRestorePromise?.then(() => {
        if (!signal.aborted) views.alignDaylightToRestoredView();
      });
      const notice = navaraModeNotice();
      styleManager._showGlobalStatusNotice?.(notice.label, {
        state: 'retry',
        detail: notice.detail,
        persistent: true,
      });
      // The notice is this engine's: it goes when the engine does.
      defer(() => styleManager._clearPersistentStatusNotice?.());
    },
  };
}
