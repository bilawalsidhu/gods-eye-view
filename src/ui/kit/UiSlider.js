import { h, mergeProps, normalizeClass, withDirectives } from 'vue';
import { vFieldValue } from '../rail/fieldValue.js';
import { vRangeValue } from '../rail/rangeValue.js';

// Server-rendered markup carries the model as the input's value.
const ssrValue = ({ value }) => (value == null ? {} : { value });
// A null model leaves the input as it is.
const live = (el, binding) => {
  if (binding.value != null) vRangeValue.updated(el, binding);
};
const LIVE = { mounted: live, updated: live, getSSRProps: ssrValue };
const HOLD = { ...vFieldValue, getSSRProps: ssrValue };

/** Put the model back on a held input that lost focus. */
function takeModel(input, props) {
  const next = props.modelValue;
  if (next != null && input.value !== String(next)) input.value = String(next);
}

/**
 * Core's slider, with v-model, min, max, step and disabled. Core keeps the
 * native range input (its keyboard, form and styling) rather than drawing a
 * `role="slider"` track. The input carries Core's `gev-quantitative-slider` class ahead of
 * the caller's (`unstyled` leaves it off, for a range drawn as the browser's
 * own), the caller's attributes come first, as in the markup this replaced,
 * and the accessible name comes as an `aria-label` attribute so the attribute
 * pass translates it. The value emits as a number, and a caller's own input,
 * change or blur handler still reaches the input.
 *
 * The input takes the model's value only when it differs (`v-range-value`),
 * and a null model leaves it as it is;
 * with `hold`, never while it is focused (`v-field-value`), so a render
 * cannot move a handle a person is dragging, and it takes the model back
 * when it loses focus: a model left unchanged renders nothing. Owners take
 * every value their slider can reach, some only after a delay, so an input
 * is never put back on its own. It is a functional component written as a
 * render function, so portable entries need no component compiler. Not
 * mirrored yet: `label`, `format`, `markers` and `endLabels`.
 */
export default function UiSlider(props, { attrs, emit }) {
  const { class: className, ...rest } = attrs;
  const classes = normalizeClass([
    props.unstyled ? null : 'gev-quantitative-slider',
    className,
  ]);
  return withDirectives(
    h(
      'input',
      mergeProps(rest, {
        class: classes || undefined,
        type: 'range',
        min: props.min,
        max: props.max,
        step: props.step,
        disabled: props.disabled,
        onInput: (event) =>
          emit('update:modelValue', Number(event.target.value)),
        onBlur: props.hold
          ? (event) => takeModel(event.target, props)
          : undefined,
      }),
    ),
    [[props.hold ? HOLD : LIVE, props.modelValue]],
  );
}

UiSlider.props = {
  modelValue: { type: [Number, String], default: undefined },
  min: { type: [Number, String], required: true },
  max: { type: [Number, String], required: true },
  step: { type: [Number, String], default: undefined },
  disabled: { type: Boolean, default: false },
  hold: { type: Boolean, default: false },
  unstyled: { type: Boolean, default: false },
};
UiSlider.emits = ['update:modelValue'];
UiSlider.inheritAttrs = false;
