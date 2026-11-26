import { catalogControlServices } from './catalog.js';
import { StyleManager } from '../ui/composition.js';
import { applyStartView, START_VIEW } from '../camera.js';
import { initCockpitCloudEffects } from '../cockpitCloudEffects.js';
import { createViewSky } from '../viewSky.js';
import { createViewFrameRate } from '../viewFrameRate.js';
import { findGlobe } from '../render/rendererOf.js';
import { useDisplayStore } from '../ui/stores/display.js';
import { applicationPinia } from '../ui/vueRuntime.js';
import { t } from '../i18n/index.js';

/** Where the camera starts unless a host gives a `startView`. */
export { START_VIEW };

/**
 * Construct the existing controls and camera presentation. `initialShareCode`
 * opens a share code (the `<code>` of `/share/<code>`) at start-up, for a host
 * whose address does not carry one. `localePicker: false` removes the language
 * picker, for a host that offers its own language choice (`switchLocale` from
 * the `./i18n` entry). `startView` is where the camera starts (the whole
 * planet by default; a host may pass a city); a shared view flies from there.
 * `homeView` is where the title's logo goes back to (with the clock live): the
 * start view unless given, for a host whose `startView` only carries a view
 * across a rebuild.
 * `startLayers` are the layer ids a bare address (one that carries no link)
 * starts with: none by default; a host may pass `['flights', 'satellites']`.
 * `services.cockpitSubjects` adds the application's own first-person subjects
 * to the Cockpit (src/cockpitSubjectProviders.js).
 * `entityLookup`, optional, finds aircraft, ships, cameras and satellites
 * anywhere for the search box, beside those already loaded:
 * `entityLookup({text, at, signal})` resolves with `[{kind: 'aircraft' |
 * 'vessel' | 'camera' | 'satellite', id, name, detail?, lat, lon, layerId?,
 * mmsi?, placed?}]`, `id` being the id the item's layer holds it under (see
 * docs/CODE-BOUNDARIES.md, "Entity lookup provider"). `at` is the world
 * time in epoch ms while the timeline is held away from live (absent while
 * live): positions are then wanted as of that time. `placed: false` marks
 * one its layer will not draw at that time (no position then), its `lat`
 * and `lon` where it was last seen, if known, and its `detail` saying so.
 * Without it the search box finds only what is already loaded.
 */
export function createApplicationControls({
  scene: { viewer, mapStackController, operations, viewerDrawsEntity },
  loaderStatus,
  Controls = StyleManager,
  services,
  spotWeatherService = operations.requests.weather,
  catalog,
  placeSearch,
  entityLookup = null,
  defer,
  initialShareCode = null,
  localePicker = true,
  startView = START_VIEW,
  homeView = startView,
  startLayers = [],
}) {
  // Every boot starts from the same view, before share restoration flies on.
  applyStartView(viewer, startView);
  // Initialize the style manager (post-processing, HUD, locations, share links)
  const styleManager = new Controls(viewer, {
    services: {
      fetchSpotWeather: (...args) => spotWeatherService.getConditions(...args),
      ...services,
      ...operations.surface.controlServices,
      searchAndFlyTo: operations.searchAndFlyTo,
      pickWorldFromScreen: operations.annotationResolver?.pickWorldFromScreen,
      fetchRegionalBrief: (...args) =>
        operations.requests.regional.getBrief(...args),
      ...catalogControlServices(catalog),
      // Whether an entity is one of the viewer's own; the scene answers it.
      viewerDrawsEntity: viewerDrawsEntity ?? services?.viewerDrawsEntity,
    },
    requestServices: operations.requests,
    mapStackController,
    placeSearch,
    entityLookup,
    // A share code to open at start-up instead of the page's address.
    initialShareCode,
    localePicker,
    homeView,
    startLayers,
  });
  defer(() => styleManager.orbitController.stop());
  defer(() => styleManager.hud.destroy());
  defer(() => styleManager.dispose());
  // The previous multi-canvas weather compositor remains disabled. Cockpit
  // clouds use a separate, capped low-resolution GPU pass that never attaches
  // Cesium fog or post-process stages and is fully stopped in map mode.
  const weatherEffects = null;
  // Where the renderer draws weather, it draws the cockpit's clouds too.
  const cockpitCloudEffects = findGlobe(viewer)?.weather
    ? null
    : initCockpitCloudEffects(viewer, {
        weatherService: operations.requests.weather,
      });
  defer(() => cockpitCloudEffects?.destroy());
  // The atmosphere, sun lighting, sun, moon, stars and Milky Way the user
  // chooses in the Display panel.
  const viewSky = createViewSky(viewer, {
    store: useDisplayStore(applicationPinia()),
  });
  defer(() => viewSky.destroy());
  // The most frames a second the globe draws, as the user sets it.
  const viewFrameRate = createViewFrameRate({
    store: useDisplayStore(applicationPinia()),
  });
  defer(() => viewFrameRate.destroy());

  loaderStatus.textContent = styleManager.hasShareState
    ? t('Restoring shared view...')
    : t('Loading');

  return { styleManager, weatherEffects, cockpitCloudEffects };
}
