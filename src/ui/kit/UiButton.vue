<script setup>
// Core's button, with @halfpixel/ui-vue UiButton's props, classes and
// attribute contract so the two kits can merge: the button is always the root,
// attributes passed in win over its own (a `title` replaces the label's), and
// `pressed` renders aria-pressed only when it is passed. Core styles the
// button through the classes its callers pass; the kit classes carry no Core
// styles yet. Not mirrored yet: icon, loading, disabledReason and the
// missing-label warning.
defineOptions({ inheritAttrs: false });

const props = defineProps({
  variant: { type: String, default: 'ghost' },
  tone: { type: String, default: 'accent' },
  /** The accessible name (aria-label) and, with nativeTitle, the tip. */
  label: { type: String, default: undefined },
  pressed: { type: Boolean, default: undefined },
  disabled: { type: Boolean, default: false },
  type: { type: String, default: 'button' },
  /** The id of the form a submit button belongs to, where it sits outside it. */
  form: { type: String, default: undefined },
  nativeTitle: { type: Boolean, default: true },
});
const emit = defineEmits(['click']);
</script>

<template>
  <button
    :type="props.type"
    :form="props.form"
    class="ui-button ui-focus"
    :class="[
      `ui-button--${props.variant}`,
      `ui-button--${props.tone}`,
      { 'ui-button--pressed': props.pressed },
    ]"
    :aria-label="props.label"
    :title="props.nativeTitle ? props.label : undefined"
    :aria-pressed="
      props.pressed === undefined ? undefined : props.pressed ? 'true' : 'false'
    "
    :disabled="props.disabled"
    v-bind="$attrs"
    @click="emit('click', $event)"
  >
    <slot />
  </button>
</template>
