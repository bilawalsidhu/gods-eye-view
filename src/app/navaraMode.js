import { t } from '../i18n/index.js';
// The experimental Navara mode (?engine=navara) of the application: its
// scene and the Navara side of the application tools. src/app/scene.js and
// src/app/tools.js load this module with import() only in that mode, and it
// loads the Navara globe the same way, so the Cesium-mode bundle carries
// none of it.

import { DATA_CREDITS, registerDataCredits } from '../data/dataCredits.js';
import { createLayerAvailability } from './layers/renderers.js';
import {
  governorRequestRender,
  installEngineRenderGovernor,
  uninstallRenderGovernor,
} from '../renderGovernor.js';
import { createNavaraAnnotationRenderer } from '../annotations/navaraAnnotationRenderer.js';
import { navaraDrawSurface } from '../annotations/drawInputNavara.js';

/** The Navara globe module, loaded on demand. */
const loadNavaraGlobeModule = async () =>
  (await import('../globe/navara/index.js')).createNavaraGlobe;

/**
 * The shell's notice in the experimental Navara mode (label and detail): the
 * data layers this engine shows (its catalog, from the layer manifest) and
 * what it does not have.
 * @param {import('./layers/renderers.js').LayerAvailability} availability
 */
export function navaraModeNotice(availability) {
  const names = availability.available().map(({ name }) => name);
  return Object.freeze({
    label: t('Experimental Navara engine'),
    detail: names.length
      ? `Data layers: ${names.join(', ')}`
      : 'No registered data layers',
  });
}

/** Static attribution for the shell and the layers available on Navara. */
const NAVARA_CREDIT_KEYS = new Set([
  'inaturalist',
  'photon-geocoder',
  'openstreetmap',
  'reearth-terrain',
  'opensky',
  'adsblol',
  'adsbdb',
  'aisstream',
  'celestrak',
  'launch-library-2',
  'usgs',
  'eccc-aqhi',
  'wfigs',
  's2-ghostmaps',
  'telegeography',
  'wind-gfs',
  'ecmwf-ifs',
  'weather-noaa',
  'weather-lightning',
  'weather-cyclones',
  'dams',
  'firms',
  'gbfs',
  'overture-military-names',
  'radio-browser',
]);

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
  // The tools install the governor on this engine; it goes before the engine.
  defer(() => uninstallRenderGovernor(engine));
  signal.throwIfAborted();
  loaderStatus.textContent = t('Initializing systems...');
  const mapStackController = new MapController(null, {
    requestRender: governorRequestRender,
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
  registerDataCredits(
    engine,
    (credits ?? DATA_CREDITS).filter(({ key }) => NAVARA_CREDIT_KEYS.has(key)),
  );
  return {
    viewer: null,
    engine,
    tileset: null,
    suspend() {
      uninstallRenderGovernor(engine);
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
 * annotation board and Draw draw (on the engine and Navara's view; null
 * without the view), the Recent Imagery panel's globe, the render
 * governor on the engine, and this engine's own parts: the daylight of a
 * restored view and the engine notice.
 */
export function navaraToolBackend({ engine }) {
  const views = engine.extensions?.navara ?? null;
  const drawn = Boolean(views?.view);
  return {
    board: () =>
      drawn
        ? { engine, renderer: createNavaraAnnotationRenderer(engine, views) }
        : null,
    // The session's tool on the engine's input and preview
    // (src/annotations/drawInputNavara.js).
    draw: () => ({ surface: navaraDrawSurface(engine) }),
    recentImagery: () => ({ engine }),
    // Holds drive engine.render.setContinuous; requests go to the engine. A
    // parked engine uninstalls it (createNavaraScene suspend).
    installGovernor: () => installEngineRenderGovernor(engine),
    attach({ data, styleManager }, { signal, defer }) {
      void styleManager.initialRestorePromise?.then(() => {
        if (!signal.aborted) views.alignDaylightToRestoredView();
      });
      const notice = navaraModeNotice(
        data.catalog?.availability ?? createLayerAvailability(engine.kind),
      );
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
