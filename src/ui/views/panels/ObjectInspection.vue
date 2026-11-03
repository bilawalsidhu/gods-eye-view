<script setup>
import { t } from '../../../i18n/index.js';
import { useObjectInspectionStore } from '../../stores/objectInspection.js';
import RailPanel from '../../rail/RailPanel.vue';
import UiButton from '../../kit/UiButton.vue';
const inspection = useObjectInspectionStore();
</script>

<template>
<RailPanel id="object-inspection-panel" start-collapsed :title="t('OBJECT DETAILS')" sideways scroll rail-scroller>
  <div class="cyber-panel-body ui-scroll object-inspection-body" data-rail-scroller>
    <template v-if="inspection.object">
      <h3>{{ inspection.object.label }}</h3>
      <p>{{ inspection.object.layerName }} · {{ inspection.object.source }} · {{ inspection.object.id }}</p>
      <div class="inspection-actions">
        <UiButton id="inspection-focus" @click="inspection.act('focus')">{{ t('FOCUS') }}</UiButton>
        <UiButton id="inspection-restore" :disabled="!inspection.canReturn" @click="inspection.act('restore')">{{ t('Restore last view') }}</UiButton>
      </div>
      <dl>
        <template v-if="Number.isFinite(inspection.object.latitude)">
          <dt>{{ t('Latitude') }}</dt><dd>{{ inspection.object.latitude.toFixed(6) }}</dd>
        </template>
        <template v-if="Number.isFinite(inspection.object.longitude)">
          <dt>{{ t('Longitude') }}</dt><dd>{{ inspection.object.longitude.toFixed(6) }}</dd>
        </template>
        <template v-for="field in inspection.object.fields" :key="field.label">
          <dt>{{ field.label }}</dt><dd>{{ field.value }}</dd>
        </template>
      </dl>
    </template>
    <p v-else>{{ t('No object selected') }}</p>
    <p v-if="inspection.error" role="alert">{{ inspection.error }}</p>
  </div>
</RailPanel>
</template>

<style scoped>
:deep(.object-inspection-panel-inner) { padding: 14px; background: var(--panel-bg, rgba(5, 15, 24, 0.94)); border: 1px solid var(--glass-border); border-radius: 12px; backdrop-filter: blur(16px); max-height: inherit; overflow: auto; }
.collapsed .object-inspection-body { display: none; }

h3 { margin: 0 0 8px; overflow-wrap: anywhere; }
p { font-size: 12px; opacity: 0.85; }
.inspection-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
.inspection-actions :deep(button) { padding: 7px 10px; color: inherit; background: var(--glass-bg); border: 1px solid var(--glass-border); border-radius: 6px; cursor: pointer; }
.inspection-actions :deep(button:disabled) { opacity: 0.4; cursor: default; }
dl { display: grid; grid-template-columns: minmax(70px, 1fr) minmax(0, 2fr); gap: 7px 12px; font-size: 12px; }
dt { opacity: 0.65; text-transform: capitalize; }
dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
