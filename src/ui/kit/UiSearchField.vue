<script setup>
import { computed, ref } from 'vue';
import UiCloseButton from './UiCloseButton.vue';

// Core's search field: the Material `search` glyph, then an
// `<input type="search">` bound with v-model, and, when `clearLabel` is set,
// a UiCloseButton (the `close` symbol, its label as its tip) shown while
// text is typed, which empties the field and focuses the input again. `tag`
// is the frame: a `div` (give it role="search") or a `label`, which names
// the input by wrapping it. Attributes and classes pass through to the frame,
// so each site keeps its feature class; the input takes `inputId`,
// `inputClass`, `autocomplete` and `spellcheck`, and the clear button
// `clearClass`. Escape, pressed in the input, stops there and is emitted
// with its event, so a caller that also prevents the browser's own Escape
// does so. `focus()` focuses the input. The kit classes `ui-search-field`
// and `ui-search-field__input` (search-field.css) are the frame's flex row
// and the bare input; the browser's own cancel button is left as it is.
const props = defineProps({
  modelValue: { type: String, default: '' },
  /** The input's accessible name (aria-label). */
  label: { type: String, required: true },
  placeholder: { type: String, default: undefined },
  tag: {
    type: String,
    default: 'div',
    validator: (value) => ['div', 'label'].includes(value),
  },
  inputId: { type: String, default: undefined },
  inputClass: { type: String, default: undefined },
  autocomplete: { type: String, default: undefined },
  spellcheck: { type: String, default: undefined },
  /** The clear button's accessible name and tip; none without it. */
  clearLabel: { type: String, default: undefined },
  clearClass: { type: String, default: undefined },
});
const emit = defineEmits(['update:modelValue', 'escape']);
const input = ref(null);
// The input keeps Vue's native v-model, as both fields had.
const text = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value),
});

function focus() {
  input.value?.focus();
}

function clear() {
  emit('update:modelValue', '');
  focus();
}

defineExpose({ focus });
</script>

<template>
  <component :is="props.tag" class="ui-search-field">
    <span class="material-symbols-outlined" aria-hidden="true">search</span>
    <input
      :id="props.inputId"
      ref="input"
      v-model="text"
      type="search"
      class="ui-search-field__input"
      :class="props.inputClass"
      :placeholder="props.placeholder"
      :aria-label="props.label"
      :autocomplete="props.autocomplete"
      :spellcheck="props.spellcheck"
      @keydown.esc.stop="emit('escape', $event)"
    />
    <UiCloseButton
      v-if="props.clearLabel && props.modelValue"
      :class="props.clearClass"
      glyph="icon"
      :label="props.clearLabel"
      :title="props.clearLabel"
      @click="clear"
    />
  </component>
</template>
