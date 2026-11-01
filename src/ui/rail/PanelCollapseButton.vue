<script setup>
import { storeToRefs } from 'pinia';
import { computed } from 'vue';
import { msg, t } from '../../i18n/index.js';
import UiButton from '../kit/UiButton.vue';
import { usePanelChromeStore } from '../stores/panelChrome.js';

// A panel's collapse button: its glyph, aria-expanded and words follow the
// panel's state in the panel chrome store, and a click asks PanelChrome to
// toggle it. Until PanelChrome presents the panel it shows its markup's glyph
// and tip.
const props = defineProps({
  target: { type: String, required: true },
  /** The panel's name in "Expand {name}", already translated. */
  name: { type: String, default: () => t('panel') },
  /** A right-rail panel opens and closes sideways: ◀ / ▶, not + / −. */
  sideways: { type: Boolean, default: false },
  /** The glyph and tip before the panel is presented. */
  initial: { type: String, required: true },
  initialTitle: { type: String, default: () => t('Collapse panel') },
  /** Words that replace "Expand/Collapse {name}" (Radio's own wording). */
  words: { type: Object, default: null },
});

const chrome = usePanelChromeStore();
const { panels } = storeToRefs(chrome);
const state = computed(() => panels.value[props.target]);

const glyph = computed(() => {
  if (!state.value) return props.initial;
  if (props.sideways) return state.value.collapsed ? '◀' : '▶';
  return state.value.collapsed ? '+' : '−';
});
const label = computed(() => {
  if (!state.value) return props.words?.initialLabel;
  if (props.words)
    return state.value.collapsed
      ? props.words.expandLabel
      : props.words.collapseLabel;
  const key = state.value.collapsed
    ? msg('Expand {name}')
    : msg('Collapse {name}');
  return t(key, { name: props.name });
});
const title = computed(() => {
  if (!state.value) return props.initialTitle;
  if (props.words)
    return state.value.collapsed
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
    :aria-expanded="state ? String(!state.collapsed) : undefined"
    @click="chrome.act('toggle', target)"
    >{{ glyph }}</UiButton
  >
</template>
