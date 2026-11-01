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
 * single-file-component compiler. The Display panel renders it too.
 */
export const StyleParameterRows = {
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
 * A value as a range input holds it: clamped to its bounds and snapped to
 * its step from the minimum, as the browser snaps the slider.
 * @param {number} value
 * @param {{min: number, max: number, step: string}} row
 */
export function snapToStep(value, { min, max, step }) {
  const size = Number(step);
  const decimals = (String(step).split('.')[1] || '').length;
  // Rounded to nine places first, so a value halfway between two steps
  // (1.15 from 1 by 0.1) rounds up as the browser does, not down through
  // floating point error.
  const count = (span) => Number((span / size).toFixed(9));
  // A maximum off the step grid holds the last step below it, as the browser
  // does.
  const steps = Math.min(
    Math.floor(count(max - min)),
    Math.max(0, Math.round(count(Number(value) - min))),
  );
  return Number((min + steps * size).toFixed(decimals));
}

/**
 * The parameter rows of a style's uniforms: each one's label, bounds, step,
 * value and the value's text in the UI language.
 * @param {object} uniforms The style's uniform metadata.
 * @param {(name: string) => number} readValue A uniform's current value.
 */
export function styleParameterRows(uniforms, readValue) {
  return Object.entries(uniforms).map(([name, metadata]) =>
    withValue(
      {
        name,
        label: t(metadata.label),
        min: metadata.min,
        max: metadata.max,
        step: metadata.max <= 1 ? '0.01' : '0.1',
        digits: metadata.max <= 1 ? 2 : 1,
      },
      readValue(name),
    ),
  );
}

/**
 * The rows with one parameter's value changed.
 * @param {object[]} rows From {@link styleParameterRows}.
 * @param {string} name
 * @param {number} value
 */
export function withParameterValue(rows, name, value) {
  return rows.map((row) => (row.name === name ? withValue(row, value) : row));
}

function withValue(row, value) {
  return {
    ...row,
    value,
    text: formatParam(snapToStep(value, row), row.digits),
  };
}

/**
 * Own generated parameter rows and their input handling. Renders
 * StyleParameterRows into `container` and patches it synchronously.
 * The caller supplies uniform metadata/value access and rendering/persistence
 * callbacks. Replacing or destroying rows revokes all old input handlers.
 * @param {object} options
 * @param {HTMLElement} options.container Container owned by this component.
 * @returns {{render: Function, clear: Function, destroy: Function}}
 * @deprecated The Display panel renders the rows VisualSettings publishes to
 * the display store (styleParameterRows); this stays exported from
 * `./ui/input` for hosts that imported it.
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
      rows = styleParameterRows(uniforms, readValue);
      onInput = (name, value) => {
        if (destroyed || current !== generation) return;
        writeValue(name, value);
        rows = withParameterValue(rows, name, value);
        paint();
        onChange();
      };
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
