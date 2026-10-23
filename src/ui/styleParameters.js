import { formatNumber, t } from '../i18n/index.js';
import { createSlider } from './slider.js';

/** A slider value in the UI language: 0.85 in English, 0,85 in Spanish. */
const formatParam = (value, digits) =>
  formatNumber(value, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: false,
  });

/**
 * Own generated parameter rows and their input listeners.
 * The caller supplies uniform metadata/value access and rendering/persistence
 * callbacks. Replacing or destroying rows revokes all old input handlers.
 * @param {object} options
 * @param {HTMLElement} options.container Container owned by this component.
 * @param {Document} [options.documentRef] Document used to construct rows.
 * @returns {{render: Function, clear: Function, destroy: Function}}
 */
export function createStyleParameters({
  container,
  documentRef = container.ownerDocument,
}) {
  let listeners = [];
  let destroyed = false;
  const clear = () => {
    if (destroyed) return;
    for (const [slider, listener] of listeners)
      slider.removeEventListener('input', listener);
    listeners = [];
    container.replaceChildren();
  };
  return {
    /** Render uniform metadata with readValue, writeValue and onChange callbacks. */
    render({ uniforms, readValue, writeValue, onChange }) {
      if (destroyed) return;
      clear();
      for (const [name, metadata] of Object.entries(uniforms)) {
        const row = documentRef.createElement('div');
        row.className = 'param-slider-row';
        const label = documentRef.createElement('span');
        label.className = 'param-label';
        label.textContent = t(metadata.label);
        const slider = createSlider({
          documentRef,
          className: 'param-slider',
          ariaLabel: t(metadata.label),
          min: metadata.min,
          max: metadata.max,
          step: metadata.max <= 1 ? '0.01' : '0.1',
          value: readValue(name),
        });
        const digits = metadata.max <= 1 ? 2 : 1;
        const valueDisplay = documentRef.createElement('span');
        valueDisplay.className = 'param-value';
        valueDisplay.textContent = formatParam(
          parseFloat(slider.value),
          digits,
        );
        const onInput = () => {
          const value = parseFloat(slider.value);
          writeValue(name, value);
          valueDisplay.textContent = formatParam(value, digits);
          onChange();
        };
        slider.addEventListener('input', onInput);
        listeners.push([slider, onInput]);
        row.append(label, slider, valueDisplay);
        container.appendChild(row);
      }
    },
    clear,
    destroy() {
      if (destroyed) return;
      clear();
      destroyed = true;
    },
  };
}
