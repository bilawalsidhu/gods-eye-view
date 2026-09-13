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
    ['scopeButton', 'toggleScope'],
    ['cleanViewButton', 'toggleCleanView'],
    ['cleanViewExitButton', 'exitCleanView'],
    ['celestialButton', 'toggleCelestial'],
    ['hudButton', 'toggleHud'],
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
  listen(elements.densitySlider, 'input', 'setDensity', (el) => el.value);
  listen(elements.hudLayout, 'change', 'setHudLayout', (el) => el.value);
  for (const el of elements.styleButtons || [])
    listen(el, 'click', 'setStyle', (el) => el.dataset.style);
  for (const el of elements.allocationButtons || [])
    listen(el, 'click', 'setAllocation', (el) => el.dataset.allocation);
  for (const el of elements.modelModeButtons || [])
    listen(el, 'click', 'setModelsMode', (el) =>
      el.dataset.mode === 'all' ? 'all' : 'proximity',
    );
  for (const el of elements.fadeSliders || []) listen(el, 'input', 'setFade');
  return {
    destroy() {
      for (const remove of removers.splice(0)) remove();
    },
  };
}
