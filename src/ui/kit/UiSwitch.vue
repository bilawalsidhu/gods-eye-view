<script setup>
import { computed } from 'vue';

// The kit's on/off switch: a `role="switch"` button whose `aria-checked`
// shows the state and whose knob slides across a pill track. The state is
// `modelValue` (v-model) or `checked`, so an owner that applies the change
// itself, as a rail card does through its params, passes `checked` and
// listens for `change`. A click emits `update:modelValue` and `change` with
// the state asked for; the switch keeps showing the prop until its owner
// passes the new one, so a refused change never shows. `label` is the
// accessible name, already translated, which a visible label beside the
// switch repeats. Attributes and classes pass through to the button, so a
// site keeps its data hooks. The kit classes `ui-switch` and
// `ui-switch__knob` (switch.css) draw the track and knob.
const props = defineProps({
  modelValue: { type: Boolean, default: undefined },
  checked: { type: Boolean, default: undefined },
  /** The accessible name, already translated. */
  label: { type: String, required: true },
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue', 'change']);

const on = computed(() => Boolean(props.modelValue ?? props.checked));

function toggle() {
  if (props.disabled) return;
  emit('update:modelValue', !on.value);
  emit('change', !on.value);
}
</script>

<template>
  <button
    type="button"
    role="switch"
    class="ui-switch ui-focus"
    :aria-checked="on ? 'true' : 'false'"
    :aria-label="props.label"
    :disabled="props.disabled"
    @click="toggle"
  >
    <i class="ui-switch__knob" aria-hidden="true"></i>
  </button>
</template>
