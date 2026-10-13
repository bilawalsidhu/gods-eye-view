import { POWER_PROFILES, powerBudget } from '../powerBudget.js';

const preferenceKey = 'gev-power-profile-v1';
const descriptions = {
  battery:
    'Battery saver: reduced rendering detail and frame rate. Live data remains enabled.',
  balanced:
    'Balanced: moderate rendering detail and smoothness. Live data remains enabled.',
  quality:
    'High quality: full rendering detail and smoothness, with higher power use.',
};

/** Own the rendering preference without modifying layer, tracking or style choices. */
export function installPowerSaving(
  viewer,
  {
    documentRef = globalThis.document,
    windowRef = globalThis.window,
    storage,
  } = {},
) {
  const original = {
    fps: viewer.targetFrameRate,
    scale: viewer.resolutionScale,
    msaa: viewer.scene.msaaSamples,
    overlayDpr: viewer.gevOverlayDprLimit,
  };
  const select = documentRef?.getElementById?.('performance-profile-select');
  const status = documentRef?.getElementById?.('performance-profile-status');
  let profile = 'battery';
  let destroyed = false;
  try {
    if (storage === undefined) storage = globalThis.localStorage;
    const saved = storage?.getItem(preferenceKey);
    if (Object.hasOwn(POWER_PROFILES, saved)) profile = saved;
  } catch {
    /* Optional local preference. */
  }
  const apply = () => {
    const budget = powerBudget(profile);
    viewer.targetFrameRate = budget.fps;
    viewer.resolutionScale = budget.scale;
    viewer.scene.msaaSamples = budget.msaa;
    viewer.gevOverlayDprLimit = budget.overlayDpr;
    if (select) select.value = profile;
    if (status) status.textContent = descriptions[profile];
    // Overlay backing stores and layout are resized only on a profile change.
    windowRef?.dispatchEvent?.(new Event('resize'));
    viewer.scene.requestRender?.();
  };
  const setProfile = (value) => {
    if (destroyed || !Object.hasOwn(POWER_PROFILES, value)) return false;
    profile = value;
    try {
      storage?.setItem(preferenceKey, profile);
    } catch {
      /* Optional. */
    }
    apply();
    return true;
  };
  const onChange = () => setProfile(select.value);
  select?.addEventListener('change', onChange);
  apply();
  return {
    setProfile,
    getState: () => ({ profile, ...powerBudget(profile) }),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      select?.removeEventListener('change', onChange);
      viewer.targetFrameRate = original.fps;
      viewer.resolutionScale = original.scale;
      viewer.scene.msaaSamples = original.msaa;
      if (original.overlayDpr === undefined) delete viewer.gevOverlayDprLimit;
      else viewer.gevOverlayDprLimit = original.overlayDpr;
    },
  };
}
