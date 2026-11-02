<script setup>
import { storeToRefs } from 'pinia';
import { ref, watch, onBeforeUnmount } from 'vue';
import { t } from '../../i18n/index.js';
import { useWellRecordsStore } from '../stores/wellRecords.js';
import WellRecordDialog from './panels/WellRecordDialog.vue';

const { records: view, choices } = storeToRefs(useWellRecordsStore());
const focused = ref(null);
const active = ref(null);
const buttons = new Map();
let previous;
watch(view, (next) => {
  if (focused.value && !next?.records.some((record) => record.id === focused.value)) {
    previous?.focusMap();
    focused.value = null;
  }
  if (!next?.records.some((record) => record.id === active.value)) active.value = next?.records[0]?.id ?? null;
  previous = next;
  if (focused.value && !next?.disabled) next?.focus(focused.value, true);
}, { immediate: true });
function focus(id) {
  focused.value = active.value = id;
  if (!view.value?.disabled) view.value?.focus(id, true);
}
function blur(id) {
  focused.value = null;
  view.value?.focus(id, false);
}
function move(event, id) {
  const list = view.value?.records ?? [];
  const index = list.findIndex((record) => record.id === id);
  const next = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? (index + 1) % list.length
    : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? (index + list.length - 1) % list.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1 : -1;
  if (next >= 0 && list[next]) { event.preventDefault(); buttons.get(list[next].id)?.focus(); }
}
onBeforeUnmount(() => { if (focused.value) view.value?.focus(focused.value, false); });
</script>

<template>
  <Teleport v-if="view" to="#world-overlay-actions">
    <div class="world-overlay-accessibility" role="group" :aria-label="t('Visible source records')">
      <span id="well-record-navigation-instructions">{{ t('Use Arrow keys to move between source records, Home or End to jump, and Enter to inspect.') }}</span>
      <button v-for="record in view.records" :key="record.id" :ref="(el) => el ? buttons.set(record.id, el) : buttons.delete(record.id)" type="button"
        :data-record-id="record.id" :tabindex="active === record.id ? 0 : -1" :aria-disabled="String(view.disabled)"
        aria-describedby="well-record-navigation-instructions" @focus="focus(record.id)" @blur="blur(record.id)"
        @keydown="move($event, record.id)" @click="!view.disabled && view.select(record.id)">{{ record.label }}</button>
    </div>
  </Teleport>
  <Teleport to="body">
    <div v-if="focused && view && !view.disabled" class="gev-panel well-record-focus" role="status">{{ t('{record} · Enter: inspect record · Arrow keys: move', { record: view.records.find((record) => record.id === focused)?.label }) }}</div>
    <WellRecordDialog v-if="choices" :key="choices.id" :view="choices" />
  </Teleport>
</template>

<style scoped>
.well-record-focus { position: fixed; z-index: 1000; bottom: 110px; left: 50%; transform: translateX(-50%); max-width: calc(100vw - 32px); padding: 8px 12px; background: #0b1018; color: #dbe4ea; border: 1px solid #33434c; border-radius: 8px; font: 12px monospace; }
</style>
