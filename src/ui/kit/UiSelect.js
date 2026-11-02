import { h, mergeProps, nextTick, withDirectives } from 'vue';
import { vFieldValue } from '../rail/fieldValue.js';
import { vRangeValue } from '../rail/rangeValue.js';

// A null model leaves the select as it is.
const live = (el, binding) => {
  if (binding.value != null) vRangeValue.updated(el, binding);
};
const LIVE = { mounted: live, updated: live };

/** Put the model back on the select. */
function takeModel(select, props) {
  const next = props.modelValue;
  if (next != null && select.value !== String(next))
    select.value = String(next);
}

/**
 * Core's select, with v-model, options and disabled. Core renders the bare select: its
 * labels sit outside it or come as an `aria-label` attribute, so the attribute
 * pass translates them. Options come from `options` ({ value, label }) or,
 * where they carry their own attributes, the default slot. A change emits the
 * chosen value; a caller's own `@change` still reaches the select.
 *
 * The select takes the model's value only when it differs (`v-range-value`),
 * after its options are in place; a null model leaves it as it is. With
 * `hold`, it never takes it while focused (`v-field-value`), and takes it back
 * when it loses focus. Without `hold`, it takes the model back once the
 * change's render has run: an owner that refuses a pick republishes the same
 * value, which renders nothing, so this puts the refused pick back. The
 * owners of these selects answer synchronously. Like UiSlider it is a functional render-function
 * component. Not mirrored yet: `label` and `hideLabel`.
 */
export default function UiSelect(props, { attrs, emit, slots }) {
  const options = props.options
    ? props.options.map((option) =>
        h('option', { key: option.value, value: option.value }, option.label),
      )
    : slots.default?.();
  const select = h(
    'select',
    mergeProps(attrs, {
      disabled: props.disabled,
      onChange: (event) => {
        const select = event.target;
        emit('update:modelValue', select.value);
        if (!props.hold) void nextTick(() => takeModel(select, props));
      },
      onBlur: props.hold
        ? (event) => takeModel(event.target, props)
        : undefined,
    }),
    options,
  );
  return withDirectives(select, [
    [props.hold ? vFieldValue : LIVE, props.modelValue],
  ]);
}

UiSelect.props = {
  modelValue: { type: [String, Number], default: undefined },
  options: { type: Array, default: undefined },
  disabled: { type: Boolean, default: false },
  hold: { type: Boolean, default: false },
};
UiSelect.emits = ['update:modelValue'];
UiSelect.inheritAttrs = false;
