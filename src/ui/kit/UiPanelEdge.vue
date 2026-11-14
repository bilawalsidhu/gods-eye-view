<script setup>
import { computed, onMounted, ref } from 'vue';
import { t } from '../../i18n/index.js';
import { panelEdge, panelSide, togglePanelEdge } from '../panelEdge.js';

// A panel header's edge switch: it slides this side's panels over their rail
// to the screen edge, and back. The side comes from the column the panel is in.
const button = ref(null);
const side = ref('left');
const on = computed(() => panelEdge.value[side.value]);
function toggle() {
  side.value = panelSide(button.value);
  togglePanelEdge(side.value);
}
function sync() {
  side.value = panelSide(button.value);
}
// The layout moves some panels to the right column after they mount, so the
// side is read again once that has happened.
onMounted(() => {
  sync();
  globalThis.requestAnimationFrame?.(sync);
});
const icon = computed(() =>
  side.value === 'right' ? 'align_horizontal_right' : 'align_horizontal_left',
);
const label = computed(() =>
  on.value
    ? t('Move panels back beside the rail')
    : t('Move panels over the rail, to the edge'),
);
</script>

<template>
  <button
    ref="button"
    type="button"
    class="ui-panel-edge panel-edge-btn"
    :aria-pressed="String(on)"
    :aria-label="label"
    :title="label"
    @pointerenter="sync"
    @focus="sync"
    @click="toggle"
  >
    <span class="material-symbols-outlined" aria-hidden="true">{{ icon }}</span>
  </button>
</template>
