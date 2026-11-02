import { catalogControlServices } from './catalog.js';
import { StyleManager } from '../ui/composition.js';
import { flyToAustin } from '../camera.js';
import { initCockpitCloudEffects } from '../cockpitCloudEffects.js';
import { t } from '../i18n/index.js';

/**
 * Construct the existing controls and camera presentation. `initialShareCode`
 * opens a share code (the `<code>` of `/share/<code>`) at start-up, for a host
 * whose address does not carry one. `localePicker: false` removes the language
 * picker, for a host that does not initialize Core's locale.
 */
export function createApplicationControls({
  scene: { viewer, engine, mapStackController, operations },
  loaderStatus,
  Controls = StyleManager,
  services,
  catalog,
  placeSearch,
  defer,
  initialShareCode = null,
  localePicker = true,
  engineSwitch = false,
  layerSession,
}) {
  // Initialize the style manager (post-processing, HUD, locations, share links)
  const styleManager = new Controls(viewer, {
    services: {
      ...services,
      ...operations.surface.controlServices,
      searchAndFlyTo: operations.searchAndFlyTo,
      fetchRegionalBrief: (...args) =>
        operations.requests.regional.getBrief(...args),
      // The catalog's layers; the ones this engine cannot show (Navara)
      // are empty stand-ins.
      ...catalogControlServices(catalog),
    },
    requestServices: operations.requests,
    // The page's globe engine: the shell's overlay host runs on it.
    engine,
    mapStackController,
    placeSearch,
    // A share code to open at start-up instead of the page's address.
    initialShareCode,
    engineSwitch,
    layerSession,
    localePicker,
  });
  defer(() => styleManager.orbitController.stop());
  defer(() => styleManager.hud.destroy());
  defer(() => styleManager.dispose());
  // The previous multi-canvas weather compositor remains disabled. Cockpit
  // clouds use a separate, capped low-resolution GPU pass that never attaches
  // Cesium fog or post-process stages and is fully stopped in map mode.
  const weatherEffects = null;
  const cockpitCloudEffects = viewer
    ? initCockpitCloudEffects(viewer, {
        weatherService: operations.requests.weather,
      })
    : null;
  defer(() => cockpitCloudEffects?.destroy());

  // If no share link state, do default fly-to Austin
  if (!styleManager.hasShareState) {
    loaderStatus.textContent = t('Flying to Austin, TX...');
    defer(flyToAustin(engine));
  } else {
    loaderStatus.textContent = t('Restoring shared view...');
  }

  return { styleManager, weatherEffects, cockpitCloudEffects };
}
