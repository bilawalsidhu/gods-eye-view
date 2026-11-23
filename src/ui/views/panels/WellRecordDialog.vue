<script setup>
import { ref, onMounted, onUnmounted, useTemplateRef } from 'vue';
import { t } from '../../../i18n/index.js';
import UiButton from '../../kit/UiButton.vue';
import UiDialog from '../../kit/UiDialog.vue';
import UiSelect from '../../kit/UiSelect.js';
// One open chooser. The parent keys it by choice, so each one is a fresh
// modal: UiDialog opens it on mount and closes it on unmount.
const props = defineProps({ view: { type: Object, required: true } });
const dialog = useTemplateRef('dialog');
const selected = ref(props.view.records[0]?.id);
// Read before the dialog opens and takes the focus.
const previous = document.activeElement;
onMounted(() => dialog.value?.element?.querySelector('select')?.focus());
onUnmounted(() => {
  if (previous?.isConnected) previous.focus();
});
</script>

<template>
  <UiDialog ref="dialog" open class="gev-panel well-record-dialog" aria-labelledby="well-record-choice-title" @dismiss="view.cancel()" @browser-close="view.cancel()">
    <h3 id="well-record-choice-title">{{ t('Source records at this location') }}</h3>
    <p>{{ t('These records may describe the same physical well. Choose a source record.') }}</p>
    <UiSelect v-model="selected" class="gev-field" :aria-label="t('Source record')" :options="view.records.map((record) => ({ value: record.id, label: record.label }))" />
    <UiButton type="button" class="gev-action-button" @click="view.select(selected)">{{ t('View record') }}</UiButton>
    <UiButton type="button" class="gev-action-button" @click="view.cancel()">{{ t('Cancel') }}</UiButton>
  </UiDialog>
</template>

<style scoped>
.well-record-dialog { position: fixed; inset: 0; margin: auto; width: min(28rem, calc(100vw - 32px)); box-sizing: border-box; font: 12px/1.5 var(--font-mono, monospace); background: var(--menu-bg); color: var(--text-primary); border: 1px solid var(--glass-border-hover); border-radius: 12px; padding: 16px; max-height: 75vh; overflow: auto; }
h3 { font-size: 14px; margin: 0 0 8px; }
select { max-width: 100%; }
</style>
