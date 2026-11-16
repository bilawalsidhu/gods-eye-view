import { catalogControlServices } from './catalog.js';
import { StyleManager } from '../ui/composition.js';
import { applyStartView, START_VIEW } from '../camera.js';
import { initCockpitCloudEffects } from '../cockpitCloudEffects.js';
import { createViewSky } from '../viewSky.js';
import { findGlobe } from '../render/rendererOf.js';
import { useDisplayStore } from '../ui/stores/display.js';
import { applicationPinia } from '../ui/vueRuntime.js';
import { t } from '../i18n/index.js';

/**
 * Construct the existing controls and camera presentation. `initialShareCode`
 * opens a share code (the `<code>` of `/share/<code>`) at start-up, for a host
 * whose address does not carry one. `localePicker: false` removes the language
 * picker, for a host that offers its own language choice (`switchLocale` from
 * the `./i18n` entry). `startView` is where the camera starts (the whole
 * planet by default; a host may pass a city); a shared view flies from there.
 * `services.cockpitSubjects` adds the application's own first-person subjects
 * to the Cockpit (src/cockpitSubjectProviders.js).
 */
export function createApplicationControls({
  scene: { viewer, mapStackController, operations, viewerDrawsEntity },
  loaderStatus,
  Controls = StyleManager,
  services,
  catalog,
  placeSearch,
  defer,
  initialShareCode = null,
  localePicker = true,
  startView = START_VIEW,
}) {
  // Every boot starts from the same view, before share restoration flies on.
  applyStartView(viewer, startView);
  // Initialize the style manager (post-processing, HUD, locations, share links)
  const styleManager = new Controls(viewer, {
    services: {
      ...services,
      ...operations.surface.controlServices,
      searchAndFlyTo: operations.searchAndFlyTo,
      fetchRegionalBrief: (...args) =>
        operations.requests.regional.getBrief(...args),
      ...catalogControlServices(catalog),
      // Whether an entity is one of the viewer's own; the scene answers it.
      viewerDrawsEntity: viewerDrawsEntity ?? services?.viewerDrawsEntity,
    },
    requestServices: operations.requests,
    mapStackController,
    placeSearch,
    // A share code to open at start-up instead of the page's address.
    initialShareCode,
    localePicker,
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

  loaderStatus.textContent = styleManager.hasShareState
    ? t('Restoring shared view...')
    : t('Loading');

  return { styleManager, weatherEffects, cockpitCloudEffects };
}
