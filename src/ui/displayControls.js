import { createSegmentedControl } from './segmentedControl.js';

/**
 * Bind Display controls to application actions. Inputs remain native DOM controls;
 * the caller owns settings and effect state. Destroy before replacing the view.
 * @param {{ elements: object, actions: object }} options
 * @returns {{ destroy(): void }}
 */
export function bindDisplayControls({ elements, actions }) {
  const removers = [];
  const listen = (element, type, action, read) => {
    if (!element) return;
    const handler = () => actions[action](...(read ? [read(element)] : []));
    element.addEventListener(type, handler);
    removers.push(() => element.removeEventListener(type, handler));
  };
  const integer = (element) => parseInt(element.value, 10);
  for (const [name, action] of [
    ['bloomButton', 'toggleBloom'],
    ['sharpenButton', 'toggleSharpen'],
    ['cleanViewButton', 'toggleCleanView'],
    ['cleanViewExitButton', 'exitCleanView'],
    ['celestialButton', 'toggleCelestial'],
    ['hudButton', 'toggleHud'],
    ['sonarButton', 'toggleSonar'],
    ['detectionButton', 'cycleDetection'],
    ['modelsButton', 'toggleModels'],
  ])
    listen(elements[name], 'click', action);
  for (const [name, action] of [
    ['bloomSlider', 'setBloomIntensity'],
    ['sharpenSlider', 'setSharpenIntensity'],
    ['scopeFeatherSlider', 'setScopeFeather'],
  ])
    listen(elements[name], 'input', action, integer);
  listen(elements.scopeToggle, 'change', 'setScopeEnabled', (el) => el.checked);
  listen(elements.densitySlider, 'input', 'setDensity', (el) => el.value);
  listen(elements.hudLayout, 'change', 'setHudLayout', (el) => el.value);
  for (const [name, action] of [
    ['sonarRingsSlider', 'setSonarRings'],
    ['sonarRangeSlider', 'setSonarRange'],
    ['sonarIntensitySlider', 'setSonarIntensity'],
    ['sonarOpacitySlider', 'setSonarOpacity'],
    ['sonarSectorSlider', 'setSonarSector'],
  ])
    listen(elements[name], 'input', action, integer);
  for (const el of elements.styleButtons || [])
    listen(el, 'click', 'setStyle', (el) => el.dataset.style);
  for (const [buttons, valueOf, action] of [
    [
      elements.allocationButtons || [],
      (el) => el.dataset.allocation,
      'setAllocation',
    ],
    [
      elements.modelModeButtons || [],
      (el) => (el.dataset.mode === 'all' ? 'all' : 'proximity'),
      'setModelsMode',
    ],
  ]) {
    const control = createSegmentedControl({
      buttons,
      valueOf,
      onChange: (value) => actions[action](value),
    });
    removers.push(() => control.destroy());
  }
  for (const el of elements.fadeSliders || []) listen(el, 'input', 'setFade');
  return {
    destroy() {
      for (const remove of removers.splice(0)) remove();
    },
  };
}

/** Keep the native Scope checkbox and feather availability in step with the mask. */
export function syncScopeControls(toggle, featherSlider, enabled) {
  if (toggle) toggle.checked = enabled;
  if (featherSlider) featherSlider.disabled = !enabled;
}
