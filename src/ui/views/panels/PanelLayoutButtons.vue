<script setup>
import { t } from '../../../i18n/index.js';
import UiButton from '../../kit/UiButton.vue';

// Dock and minimize for an assistant panel (chat or voice). The owner
// (src/voice/panelLayout.js) places the panel; this reports the choice.
const props = defineProps({
  docked: { type: Boolean, default: false },
  minimized: { type: Boolean, default: false },
});
defineEmits(['dock', 'minimize']);
</script>

<template>
  <div class="gev-panel-layout" role="group" :aria-label="t('Panel position')">
    <UiButton data-layout-dock :pressed="props.docked" :label="props.docked ? t('Move above the dock') : t('Dock to the right')" @click="$emit('dock')"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path :d="props.docked ? 'M4 5h16v14H4ZM4 14h16' : 'M4 5h16v14H4ZM14 5v14'"></path></svg></UiButton>
    <UiButton data-layout-minimize :label="props.minimized ? t('Expand panel') : t('Minimize panel')" @click="$emit('minimize')"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path :d="props.minimized ? 'M6 6h12v12H6Z' : 'M6 12h12'"></path></svg></UiButton>
  </div>
</template>
