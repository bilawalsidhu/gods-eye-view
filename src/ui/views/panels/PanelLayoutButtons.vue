<script setup>
import { t } from '../../../i18n/index.js';
import UiButton from '../../kit/UiButton.vue';

// Minimize or expand the assistant panel.
const props = defineProps({
  minimized: { type: Boolean, default: false },
});
defineEmits(['minimize']);
</script>

<template>
  <div class="gev-panel-layout">
    <UiButton data-layout-minimize :label="props.minimized ? t('Expand panel') : t('Minimize panel')" @click="$emit('minimize')"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path :d="props.minimized ? 'M6 6h12v12H6Z' : 'M6 12h12'"></path></svg></UiButton>
  </div>
</template>
