<script setup>
import { ref, onMounted, onBeforeUnmount, useTemplateRef } from 'vue';
import { t } from '../../../i18n/index.js';
import UiSelect from '../../kit/UiSelect.js';
import UiButton from '../../kit/UiButton.vue';
const props = defineProps({ view: { type: Object, required: true } });
const root = useTemplateRef('root');
const selected = ref(props.view.records[0]?.id);
let previous;
onMounted(() => {
  previous = document.activeElement;
  root.value?.showModal?.();
  root.value?.querySelector('select')?.focus();
});
onBeforeUnmount(() => {
  if (root.value?.open) root.value.close();
  if (previous?.isConnected) previous.focus();
});
</script>

<template>
  <dialog ref="root" class="gev-panel well-record-dialog" aria-labelledby="well-record-choice-title" @cancel.prevent="view.cancel()">
    <h3 id="well-record-choice-title">{{ t('Source records at this location') }}</h3>
    <p>{{ t('These records may describe the same physical well. Choose a source record.') }}</p>
    <UiSelect v-model="selected" class="gev-field" :aria-label="t('Source record')" :options="view.records.map((record) => ({ value: record.id, label: record.label }))" />
    <UiButton type="button" class="gev-action-button" @click="view.select(selected)">{{ t('View record') }}</UiButton>
    <UiButton type="button" class="gev-action-button" @click="view.cancel()">{{ t('Cancel') }}</UiButton>
  </dialog>
</template>

<style scoped>
.well-record-dialog { position: fixed; inset: 0; margin: auto; width: min(28rem, calc(100vw - 32px)); box-sizing: border-box; font: 12px/1.5 var(--font-mono, monospace); background: #0b1018; color: #dbe4ea; border: 1px solid #33434c; border-radius: 12px; padding: 16px; max-height: 75vh; overflow: auto; }
h3 { font-size: 14px; margin: 0 0 8px; }
select { max-width: 100%; }
</style>
