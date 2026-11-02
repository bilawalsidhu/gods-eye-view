<script setup>
import { computed } from 'vue';
import { msg, t } from '../../i18n/index.js';
import UiButton from './UiButton.vue';

// A panel's collapse button, internal to the kit: UiPanel draws it, and so
// does PanelCollapseButton for the panels not built on UiPanel. Its glyph and
// words follow `collapsed`; a click asks for the other state.
const props = defineProps({
  /** The panel's id, which PanelChrome finds the button by. */
  target: { type: String, required: true },
  /** The panel's name in "Expand {name}", already translated; "panel" when unset. */
  name: { type: String, default: null },
  collapsed: { type: Boolean, required: true },
  /** A right-rail panel opens and closes sideways: ◀ / ▶, not + / −. */
  sideways: { type: Boolean, default: false },
  /** Words that replace "Expand/Collapse {name}" (Radio's own wording). */
  words: { type: Object, default: null },
});
const emit = defineEmits(['update:collapsed']);

const glyph = computed(() => {
  if (props.sideways) return props.collapsed ? '◀' : '▶';
  return props.collapsed ? '+' : '−';
});
const label = computed(() => {
  if (props.words)
    return props.collapsed
      ? props.words.expandLabel
      : props.words.collapseLabel;
  const key = props.collapsed ? msg('Expand {name}') : msg('Collapse {name}');
  return t(key, { name: props.name ?? t('panel') });
});
const title = computed(() => {
  if (props.words)
    return props.collapsed
      ? props.words.expandTitle
      : props.words.collapseTitle;
  return label.value;
});
</script>

<template>
  <UiButton
    variant="icon"
    class="panel-collapse-btn"
    :data-collapse-target="target"
    :label="label"
    :title="title"
    :aria-expanded="String(!collapsed)"
    @click="emit('update:collapsed', !collapsed)"
    >{{ glyph }}</UiButton
  >
</template>
