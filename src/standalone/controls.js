import { StyleManager } from '../ui.js';
import { flyToAustin } from '../camera.js';
import { initCockpitCloudEffects } from '../cockpitCloudEffects.js';
import { t } from '../i18n/index.js';

/** Construct the existing controls and camera presentation. */
export function createStandaloneControls({
  scene: { viewer, mapStackController },
  loaderStatus,
  placeSearch,
  defer,
}) {
  // Initialize the style manager (post-processing, HUD, locations, share links)
  const styleManager = new StyleManager(viewer, {
    mapStackController,
    placeSearch,
  });
  defer(() => styleManager.orbitController.stop());
  defer(() => styleManager.hud.destroy());
  defer(() => styleManager.dispose());
  // The previous multi-canvas weather compositor remains disabled. Cockpit
  // clouds use a separate, capped low-resolution GPU pass that never attaches
  // Cesium fog or post-process stages and is fully stopped in map mode.
  const weatherEffects = null;
  const cockpitCloudEffects = initCockpitCloudEffects(viewer);
  defer(() => cockpitCloudEffects?.destroy());

  // If no share link state, do default fly-to Austin
  if (!styleManager.hasShareState) {
    loaderStatus.textContent = t('shell.loading.status.flying');
    defer(flyToAustin(viewer));
  } else {
    loaderStatus.textContent = t('shell.loading.status.restoring');
  }

  return { styleManager, weatherEffects, cockpitCloudEffects };
}
