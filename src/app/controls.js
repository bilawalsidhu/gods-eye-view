import { catalogControlServices } from './catalog.js';
import { StyleManager } from '../ui/composition.js';
import { applyStartView, START_VIEW } from '../camera.js';
import { initCockpitCloudEffects } from '../cockpitCloudEffects.js';
import { t } from '../i18n/index.js';

/**
 * Construct the existing controls and camera presentation. `initialShareCode`
 * opens a share code (the `<code>` of `/share/<code>`) at start-up, for a host
 * whose address does not carry one. `localePicker: false` removes the language
 * picker, for a page that does not initialize the app's locale. `startView` is
 * where the camera starts (the whole planet by default; a host may pass a
 * city); a shared view flies from there.
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
  const cockpitCloudEffects = initCockpitCloudEffects(viewer, {
    weatherService: operations.requests.weather,
  });
  defer(() => cockpitCloudEffects?.destroy());

  loaderStatus.textContent = styleManager.hasShareState
    ? t('Restoring shared view...')
    : t('Loading');

  return { styleManager, weatherEffects, cockpitCloudEffects };
}
