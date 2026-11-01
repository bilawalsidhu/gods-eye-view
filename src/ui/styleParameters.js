import { h, render } from 'vue';
import { formatNumber, t } from '../i18n/index.js';
import UiSlider from './kit/UiSlider.js';

/** A slider value in the UI language: 0.85 in English, 0,85 in Spanish. */
const formatParam = (value, digits) =>
  formatNumber(value, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: false,
  });

/**
 * The generated rows: a label, the kit's slider and its value in the UI
 * language. A render function, so the portable input package needs no
 * single-file-component compiler.
 */
const StyleParameterRows = {
  props: {
    rows: { type: Array, required: true },
    onInput: { type: Function, required: true },
  },
  render() {
    return this.rows.map((row) =>
      h('div', { key: row.name, class: 'param-slider-row' }, [
        h('span', { class: 'param-label' }, row.label),
        h(UiSlider, {
          class: 'param-slider',
          min: row.min,
          max: row.max,
          step: row.step,
          'aria-label': row.label,
          modelValue: row.value,
          'onUpdate:modelValue': (value) => this.onInput(row.name, value),
        }),
        h('span', { class: 'param-value' }, row.text),
      ]),
    );
  },
};

/**
 * Own generated parameter rows and their input handling. Renders
 * StyleParameterRows into `container` and patches it synchronously.
 * The caller supplies uniform metadata/value access and rendering/persistence
 * callbacks. Replacing or destroying rows revokes all old input handlers.
 * @param {object} options
 * @param {HTMLElement} options.container Container owned by this component.
 * @returns {{render: Function, clear: Function, destroy: Function}}
 */
export function createStyleParameters({ container }) {
  let rows = [];
  let onInput = () => {};
  // Each render's handlers act only while that render is current.
  let generation = 0;
  let destroyed = false;
  const paint = () =>
    render(h(StyleParameterRows, { rows, onInput }), container);
  const clear = () => {
    if (destroyed) return;
    generation++;
    rows = [];
    onInput = () => {};
    render(null, container);
  };
  return {
    /** Render uniform metadata with readValue, writeValue and onChange callbacks. */
    render({ uniforms, readValue, writeValue, onChange }) {
      if (destroyed) return;
      clear();
      const current = generation;
      rows = Object.entries(uniforms).map(([name, metadata]) => ({
        name,
        label: t(metadata.label),
        min: metadata.min,
        max: metadata.max,
        step: metadata.max <= 1 ? '0.01' : '0.1',
        digits: metadata.max <= 1 ? 2 : 1,
        value: readValue(name),
        text: '',
      }));
      onInput = (name, value) => {
        if (destroyed || current !== generation) return;
        writeValue(name, value);
        rows = rows.map((row) =>
          row.name === name
            ? { ...row, value, text: formatParam(value, row.digits) }
            : row,
        );
        paint();
        onChange();
      };
      paint();
      // The readout shows the value the slider holds once the browser has
      // clamped and snapped it to its step.
      const sliders = container.querySelectorAll('input.param-slider');
      rows = rows.map((row, index) => ({
        ...row,
        text: formatParam(parseFloat(sliders[index].value), row.digits),
      }));
      paint();
    },
    clear,
    destroy() {
      if (destroyed) return;
      clear();
      destroyed = true;
    },
  };
}
