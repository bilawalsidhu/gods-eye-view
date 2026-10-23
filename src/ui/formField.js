/**
 * Build a native numeric field without listeners, parsing or commit policy.
 * Owners retain drafts, validation, input/change timing and disposal. Static
 * selects and number inputs share the gev-field surface in their templates;
 * options remain owned by each feature (no replacement popup or keyboard code).
 * @param {object} options
 * @param {Document} [options.documentRef]
 * @param {string} [options.className] Additional density/layout hooks.
 * @param {number|string} [options.min]
 * @param {number|string} [options.max]
 * @param {number|string} [options.step]
 * @param {number|string} [options.value]
 * @param {boolean} [options.disabled]
 * @param {string} [options.ariaLabel] Already translated accessible name.
 * @returns {HTMLInputElement}
 */
export function createNumberInput({
  documentRef = globalThis.document,
  className = '',
  min,
  max,
  step,
  value,
  disabled = false,
  ariaLabel,
} = {}) {
  const input = documentRef.createElement('input');
  input.type = 'number';
  input.className = `gev-field${className ? ` ${className}` : ''}`;
  for (const [key, setting] of Object.entries({ min, max, step, value })) {
    if (setting !== undefined) input[key] = setting;
  }
  input.disabled = disabled;
  if (ariaLabel !== undefined) input.setAttribute('aria-label', ariaLabel);
  return input;
}
