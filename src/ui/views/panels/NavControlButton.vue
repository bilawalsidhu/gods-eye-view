<script setup>
import { useNavControlStore } from '../../stores/navControl.js';
import UiButton from '../../kit/UiButton.vue';

// One round button of the navigation control. A pointer press acts at once
// and, for the actions that repeat, keeps acting while it is held; a click
// with no pointer behind it (detail 0: the keyboard) acts once. The navigation
// owner decides what each action does and when the hold repeats.
const props = defineProps({
  /** The navigation action: `zoom-in`, `tilt-up`, `north`, ... */
  action: { type: String, required: true },
  /** The accessible name, already in the page's language. */
  label: { type: String, required: true },
  disabled: { type: Boolean, default: false },
});
const nav = useNavControlStore();
const press = (event) => {
  if (event.button > 0) return;
  nav.act('press', props.action);
};
const release = () => nav.act('release');
const activate = (event) => {
  if (!event.detail) nav.act('activate', props.action);
};
</script>

<template>
  <UiButton
    :data-nav="action"
    :label="label"
    :disabled="disabled"
    @pointerdown="press"
    @pointerup="release"
    @pointercancel="release"
    @pointerleave="release"
    @click="activate"
  >
    <slot />
  </UiButton>
</template>
