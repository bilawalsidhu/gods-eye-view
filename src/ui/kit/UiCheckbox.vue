<script setup>
import { nextTick, ref } from 'vue';

// Core's checkbox: a `<label>` wrapping a native `<input type="checkbox">`
// and the default slot, which names it. The box comes first, or after the
// slot with `trailing`. Attributes and classes pass through to the label, so
// each site keeps its feature class and tip; the input takes `inputId` and
// `inputAttrs` (other attributes it needs, such as aria-describedby or a
// data hook). With v-model the box shows `modelValue` and a change emits the
// checked state; `change` is emitted with the event too. Without a
// modelValue the box is the browser's own and keeps whatever is ticked.
// `restore` puts the box back to `modelValue` after a change its owner did
// not take, so a refused preference shows the applied value again. The kit
// classes `ui-checkbox` and `ui-checkbox__input` (checkbox.css) are the
// label's centred flex row and the box, which keeps each skin's look.
const props = defineProps({
  modelValue: { type: Boolean, default: undefined },
  inputId: { type: String, default: undefined },
  inputAttrs: { type: Object, default: undefined },
  trailing: { type: Boolean, default: false },
  restore: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue', 'change']);
const input = ref(null);

function onChange(event) {
  emit('update:modelValue', event.target.checked);
  emit('change', event);
  if (!props.restore) return;
  // The owner has answered once the update it caused has rendered.
  nextTick(() => {
    const box = input.value;
    if (
      box &&
      props.modelValue !== undefined &&
      box.checked !== props.modelValue
    )
      box.checked = props.modelValue;
  });
}
</script>

<template>
  <label class="ui-checkbox">
    <slot v-if="props.trailing" />
    <input
      ref="input"
      type="checkbox"
      :id="props.inputId"
      class="ui-checkbox__input"
      v-bind="props.inputAttrs"
      :checked="props.modelValue"
      @change="onChange"
    />
    <slot v-if="!props.trailing" />
  </label>
</template>
