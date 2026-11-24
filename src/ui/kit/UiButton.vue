<script setup>
import { computed } from 'vue';
import { vClassToggle } from '../rail/classToggle.js';

// Core's button and its attribute contract: the button is always the root,
// attributes passed in win over its own (a `title` replaces the label's), and
// `pressed` renders aria-pressed only when it is passed. The variant picks
// the look:
// - `ghost` (the default) carries no style; the caller's classes style it.
// - `action` wears Core's action surface (action-button.css), with
//   `tone="danger"` for a red hover and `size="compact"` for the smaller
//   shot-row footprint.
// - `primary` is that surface with the accent emphasis of a group's one main
//   action (action-button.css).
// - `icon` is the 22px square glyph button of a panel's collapse toggle
//   (controls.css).
// A pressed action, primary or icon button looks as a hovered regular one
// does (a compact action's quieter hover is for an unpressed button); a
// disabled one dims and ignores hover and press. `size` styles the action
// variant only. Each
// resting rule selects one kit class, so a feature class loaded later still
// wins. Core adds `pressedClass`, its class on a pressed button (most
// toggles use `active`). The pressed classes toggle through `classList`, so
// classes other code adds to the button (a voice highlight) survive a press.
// Not mirrored yet: icon, loading, disabledReason and the missing-label
// warning.
defineOptions({ inheritAttrs: false });

const props = defineProps({
  variant: {
    type: String,
    default: 'ghost',
    validator: (value) =>
      ['ghost', 'action', 'primary', 'icon'].includes(value),
  },
  /** `accent`, or `danger` for an action that destroys or stops. */
  tone: {
    type: String,
    default: 'accent',
    validator: (value) => ['accent', 'danger'].includes(value),
  },
  /** `compact` for an action's smaller footprint. */
  size: {
    type: String,
    default: 'regular',
    validator: (value) => ['regular', 'compact'].includes(value),
  },
  /** The accessible name (aria-label) and, with nativeTitle, the tip. */
  label: { type: String, default: undefined },
  pressed: { type: Boolean, default: undefined },
  /** Core's class on the button while it is pressed. */
  pressedClass: { type: String, default: undefined },
  disabled: { type: Boolean, default: false },
  type: { type: String, default: 'button' },
  /** The id of the form a submit button belongs to, where it sits outside it. */
  form: { type: String, default: undefined },
  nativeTitle: { type: Boolean, default: true },
});
const emit = defineEmits(['click']);

// A pressedClass that changes keeps its old name, switched off, so the class
// leaves the button with it.
const pressedClasses = computed((previous) => {
  const on = Boolean(props.pressed);
  const classes = { 'ui-button--pressed': on };
  for (const name of Object.keys(previous || {}))
    if (name !== 'ui-button--pressed') classes[name] = false;
  if (props.pressedClass) classes[props.pressedClass] = on;
  return classes;
});
// Server-rendered markup carries the pressed classes in its class attribute.
const vPressedClasses = {
  ...vClassToggle,
  getSSRProps: ({ value }) => ({
    class: Object.keys(value).filter((name) => value[name]),
  }),
};
</script>

<template>
  <button
    :type="props.type"
    :form="props.form"
    class="ui-button ui-focus"
    :class="[
      `ui-button--${props.variant}`,
      `ui-button--${props.tone}`,
      { 'ui-button--compact': props.size === 'compact' },
    ]"
    :aria-label="props.label"
    :title="props.nativeTitle ? props.label : undefined"
    :aria-pressed="
      props.pressed === undefined ? undefined : props.pressed ? 'true' : 'false'
    "
    :disabled="props.disabled"
    v-bind="$attrs"
    v-pressed-classes="pressedClasses"
    @click="emit('click', $event)"
  >
    <slot />
  </button>
</template>
