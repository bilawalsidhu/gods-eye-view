import { catalogControlServices } from './catalog.js';
import { StyleManager } from '../ui/composition.js';
import { flyToAustin } from '../camera.js';
import { installZoomOutGuard } from '../globe/cesium/zoomOutGuard.js';
import {
  initCockpitCloudEffects,
  initEngineCockpitClouds,
} from '../cockpitCloudEffects.js';
import { engineCapabilities } from '../globe/contract.js';
import { t } from '../i18n/index.js';
import { attachScenePart, currentSceneOf } from './sceneParts.js';
import { shellScenePart } from './shellPart.js';

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
export async function createApplicationControls({
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
    sceneHost: scene.sceneHost,
    localePicker,
  });
  defer(() => styleManager.orbitController.stop());
  defer(() => styleManager.hud.destroy());
  defer(() => styleManager.dispose(scene.transaction));
  // The shell was built on this globe; later globes attach to it.
  await attachScenePart(
    scene,
    shellScenePart(styleManager, { builtOn: currentSceneOf(scene), catalog }),
    { defer },
  );
  // Outward zooms stay bounded and framed. The guard works through Cesium's
  // camera controller, so it attaches to Cesium globes only.
  await attachScenePart(
    scene,
    {
      name: 'zoom-out-guard',
      attachScene(next, { defer: release }) {
        if (!next.viewer) return;
        release(
          installZoomOutGuard(next.viewer, {
            subscribeCameraHandoff: (listener) =>
              styleManager.subscribeCameraHandoff?.(listener),
          }),
        );
      },
    },
    { defer },
  );
  // The previous multi-canvas weather compositor remains disabled. Cockpit
  // clouds use a separate, capped low-resolution GPU pass that never attaches
  // Cesium fog or post-process stages and is fully stopped in map mode. An
  // engine that draws its own clouds (Navara, render.setCloudCover) gets
  // their cover from the same weather instead, with no canvas of its own.
  const weatherEffects = null;
  let cockpitCloudEffects = null;
  await attachScenePart(
    scene,
    {
      name: 'cockpit-clouds',
      attachScene(next, { defer: release }) {
        const weatherService = operations.requests.weather;
        let effects = null;
        if (next.viewer)
          effects = initCockpitCloudEffects(next.viewer, { weatherService });
        else if (engineCapabilities(next.engine).cloudCover)
          effects = initEngineCockpitClouds(next.engine, { weatherService });
        if (!effects) return;
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
