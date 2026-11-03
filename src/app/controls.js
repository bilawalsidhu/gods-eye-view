import { catalogControlServices } from './catalog.js';
import { StyleManager } from '../ui/composition.js';
import { flyToAustin } from '../camera.js';
import { initCockpitCloudEffects } from '../cockpitCloudEffects.js';
import { t } from '../i18n/index.js';
import { attachScenePart, currentSceneOf } from './sceneParts.js';

/**
 * Construct the existing controls and camera presentation. `initialShareCode`
 * opens a share code (the `<code>` of `/share/<code>`) at start-up, for a host
 * whose address does not carry one. `localePicker: false` removes the language
 * picker, for a host that does not initialize Core's locale.
 *
 * The shell is built once, on the first globe; on a page that switches
 * engines it attaches to each later one (StyleManager.attachScene) with that
 * engine's catalog, and the Cockpit cloud effects follow the viewer.
 */
export function createApplicationControls({
  scene,
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
  const { viewer, engine, mapStackController, operations } = scene;
  const sharedServices = {
    ...services,
    ...operations.surface.controlServices,
    searchAndFlyTo: operations.searchAndFlyTo,
    fetchRegionalBrief: (...args) =>
      operations.requests.regional.getBrief(...args),
  };
  // Initialize the style manager (post-processing, HUD, locations, share links)
  const styleManager = new Controls(viewer, {
    services: {
      ...sharedServices,
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
  // The shell was built on this globe; later globes attach to it.
  let builtOn = currentSceneOf(scene);
  attachScenePart(
    scene,
    {
      name: 'shell',
      attachScene(next) {
        if (next === builtOn) {
          builtOn = null;
          return;
        }
        builtOn = null;
        styleManager.attachScene({
          viewer: next.viewer,
          engine: next.engine,
          mapStackController: next.mapStackController,
          services: catalogControlServices(next.catalog ?? catalog),
          engineSwitch: true,
        });
      },
      // The shell leaves its globe in 'shell-release' (the tools phase),
      // before the data layers detach, as its teardown always did.
    },
    { defer },
  );
  // The previous multi-canvas weather compositor remains disabled. Cockpit
  // clouds use a separate, capped low-resolution GPU pass that never attaches
  // Cesium fog or post-process stages and is fully stopped in map mode.
  const weatherEffects = null;
  let cockpitCloudEffects = null;
  attachScenePart(
    scene,
    {
      name: 'cockpit-clouds',
      attachScene(next, { defer: release }) {
        if (!next.viewer) return;
        const effects = initCockpitCloudEffects(next.viewer, {
          weatherService: operations.requests.weather,
        });
        cockpitCloudEffects = effects;
        release(() => {
          if (cockpitCloudEffects === effects) cockpitCloudEffects = null;
          effects?.destroy();
        });
      },
    },
    { defer },
  );

  // If no share link state, do default fly-to Austin
  if (!styleManager.hasShareState) {
    loaderStatus.textContent = t('Flying to Austin, TX...');
    defer(flyToAustin(engine));
  } else {
    loaderStatus.textContent = t('Restoring shared view...');
  }

  return {
    styleManager,
    weatherEffects,
    get cockpitCloudEffects() {
      return cockpitCloudEffects;
    },
  };
}
