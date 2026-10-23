/**
 * Build the shared native slider. Feature owners retain their input/change
 * listeners, formatting and teardown; this component installs no handlers.
 * Static sliders use the same gev-quantitative-slider class in their template.
 * @param {object} options
 * @param {Document} [options.documentRef] Document that owns the input.
 * @param {string} [options.className] Additional feature/layout hooks.
 * @param {number|string} [options.min]
 * @param {number|string} [options.max]
 * @param {number|string} [options.step]
 * @param {number|string} [options.value]
 * @param {string} [options.ariaLabel] Already translated accessible name.
 * @returns {HTMLInputElement}
 */
export function createSlider({
  documentRef = globalThis.document,
  className = '',
  min,
  max,
  step,
  value,
  ariaLabel,
} = {}) {
  const input = documentRef.createElement('input');
  input.type = 'range';
  input.className = `gev-quantitative-slider${className ? ` ${className}` : ''}`;
  for (const [key, setting] of Object.entries({ min, max, step, value })) {
    if (setting !== undefined) input[key] = setting;
  }
  if (ariaLabel !== undefined) input.setAttribute('aria-label', ariaLabel);
  return input;
}
