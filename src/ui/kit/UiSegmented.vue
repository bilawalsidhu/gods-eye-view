<script setup>
import { computed } from 'vue';

// Core's segmented control, with v-model, options, label, stacked and
// disabled. It adds `keyboard`, because its groups keep their own policy: `none`
// (Tab reaches every option and arrows do nothing), `arrows` (a roving tab
// stop that arrows move) or `radio` (arrows plus Home and
// End). Each option may carry `attrs` (an id, data attributes, a tip), and
// Core's classes sit beside the kit's: `gev-segmented`, `gev-segment` and the
// selected option's `activeClass`. Not mirrored yet: an option's icon.
const props = defineProps({
  modelValue: { type: String, default: undefined },
  /** `{value, label, icon?, disabled?, attrs?}`, labels already translated. */
  options: { type: Array, required: true },
  /** The group's accessible name, already translated. */
  label: { type: String, required: true },
  stacked: { type: Boolean, default: false },
  /** The whole group is off: no option is in the tab order or answers. */
  disabled: { type: Boolean, default: false },
  keyboard: {
    type: String,
    default: 'arrows',
    validator: (value) => ['none', 'arrows', 'radio'].includes(value),
  },
  /** Core's class on every option, beside `gev-segment`. */
  itemClass: { type: String, default: undefined },
  /** Core's class on the selected option. */
  activeClass: { type: String, default: 'active' },
});
const emit = defineEmits(['update:modelValue']);
// The option buttons, by index, for focus; not reactive state.
const items = [];

const selectedIndex = computed(() =>
  props.options.findIndex((option) => option.value === props.modelValue),
);
const optionOff = (option) => props.disabled || !!option.disabled;
/** The roving tab stop; with no selection, the first option. */
const tabStop = computed(() =>
  props.disabled ? -1 : Math.max(0, selectedIndex.value),
);
function tabindex(index) {
  if (props.keyboard === 'none') return undefined;
  return index === tabStop.value ? 0 : -1;
}

function choose(index) {
  const option = props.options[index];
  if (!option || optionOff(option)) return;
  emit('update:modelValue', option.value);
}
/**
 * Select the option `delta` away from `from`, wrapping past disabled ones, or
 * `to` an end. A key that lands where it started (Home on the first) only
 * moves focus.
 */
function move({ delta = 0, to = null, from }) {
  const count = props.options.length;
  if (!count || props.disabled) return;
  const enabled = props.options
    .map((option, index) => (option.disabled ? -1 : index))
    .filter((index) => index >= 0);
  if (!enabled.length) return;
  let target;
  if (to === 'first') target = enabled[0];
  else if (to === 'last') target = enabled.at(-1);
  else {
    target = from < 0 ? (delta > 0 ? -1 : count) : from;
    do target = (((target + delta) % count) + count) % count;
    while (props.options[target].disabled);
  }
  if (target !== from) choose(target);
  // Focus moves at once, as a radio group's does; the option is already there.
  items[target]?.focus();
}
const STEPS = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
function onKey(event) {
  if (props.keyboard === 'none') return;
  // A radio group moves from the option holding focus, `arrows` from the
  // selection.
  const from =
    props.keyboard === 'radio'
      ? items.indexOf(event.target)
      : selectedIndex.value;
  if (STEPS[event.key]) move({ delta: STEPS[event.key], from });
  else if (props.keyboard === 'radio' && event.key === 'Home')
    move({ to: 'first', from });
  else if (props.keyboard === 'radio' && event.key === 'End')
    move({ to: 'last', from });
  else return;
  event.preventDefault();
}
</script>

<template>
  <div
    role="radiogroup"
    class="ui-segmented gev-segmented"
    :class="{ 'ui-segmented--stacked': props.stacked }"
    :aria-label="props.label"
    :aria-disabled="props.disabled ? 'true' : undefined"
    @keydown="onKey"
  >
    <button
      v-for="(option, index) in props.options"
      :key="option.value"
      v-bind="option.attrs"
      :ref="(el) => (items[index] = el)"
      type="button"
      role="radio"
      class="ui-segmented__item ui-focus gev-segment"
      :class="[
        props.itemClass,
        {
          'ui-segmented__item--on': option.value === props.modelValue,
          [props.activeClass]: option.value === props.modelValue,
        },
      ]"
      :aria-checked="String(option.value === props.modelValue)"
      :disabled="optionOff(option)"
      :tabindex="tabindex(index)"
      @click="choose(index)"
      >{{ option.label }}</button
    >
  </div>
</template>
