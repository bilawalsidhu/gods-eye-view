<script setup>
import { t } from '../../../i18n/index.js';
import { useChesterCountyPanelStore } from '../../stores/chesterCountyPanel.js';
import RailPanel from '../../rail/RailPanel.vue';
import RailRowList from '../../rail/RailRowList.vue';
import UiButton from '../../kit/UiButton.vue';
const incidents = useChesterCountyPanelStore();
</script>

<template>
  <RailPanel id="chester-county-panel" :hidden="!incidents.view?.enabled" start-collapsed :title="t('COUNTY EMS')" sideways rail-scroller>
    <template #badge><span :aria-label="t('County EMS')">{{ incidents.view?.list?.items?.length || 0 }}</span></template>
    <div class="cyber-panel-body ui-scroll county-incidents-body" data-rail-scroller>
      <div class="county-incidents-filters" role="group" :aria-label="t('Incident categories')">
        <UiButton data-county-category="fire" :pressed="incidents.view?.categories.includes('fire')" @click="incidents.act('category', 'fire')">{{ t('Fire') }}</UiButton>
        <UiButton data-county-category="ems" :pressed="incidents.view?.categories.includes('ems')" @click="incidents.act('category', 'ems')">{{ t('EMS') }}</UiButton>
        <UiButton data-county-category="traffic" :title="t('Public WebCAD traffic reports')" :pressed="incidents.view?.categories.includes('traffic')" @click="incidents.act('category', 'traffic')">{{ t('Police / traffic') }}</UiButton>
      </div>
      <div class="county-incidents-filters" role="group" :aria-label="t('County coverage')">
        <UiButton v-for="county in incidents.view?.counties || []" :key="county.id" :data-county-filter="county.id" :pressed="county.active" @click="incidents.act('county', county.id)">{{ county.label }}</UiButton>
      </div>
      <div class="county-incidents-actions">
        <UiButton v-for="chip in incidents.view?.chips || []" :key="chip.id" :data-county-action="chip.id" :disabled="!!chip.disabled" @click="incidents.act('chip', chip.id)">{{ chip.label }}</UiButton>
      </div>
      <p role="status">{{ incidents.view?.info }}</p>
      <RailRowList :list="incidents.view?.list" :on-select="item => incidents.act('select', item.id)" />
      <p v-if="incidents.error" role="alert">{{ incidents.error }}</p>
    </div>
  </RailPanel>
</template>

<style scoped>
#chester-county-panel { position: relative; inset: auto; flex: 0 1 var(--right-panel-allocated-height, auto); width: 100%; height: var(--right-panel-allocated-height, auto); max-height: var(--right-panel-allocated-height, 100%); min-height: 0; pointer-events: auto; }
#chester-county-panel:not([hidden]) { display: flex; flex-direction: column; }
#chester-county-panel[hidden] { display: none !important; }
:deep(.chester-county-panel-inner) { display: flex; flex-direction: column; padding: 0; background: var(--panel-bg, rgba(5,15,24,.94)); border: 1px solid var(--glass-border); border-radius: 12px; max-height: inherit; overflow: hidden; box-sizing: border-box; }
:deep(.chester-county-panel-inner > .panel-header) { flex: none; margin: 0; padding: 12px 14px; }
.collapsed .county-incidents-body { display: none; }
.county-incidents-body { flex: 1; min-height: 0; overflow-y: auto; padding: 0 12px 12px; font-size: 12px; }
.county-incidents-filters, .county-incidents-actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0; }
.county-incidents-filters :deep(button), .county-incidents-actions :deep(button) { padding: 7px 9px; border: 1px solid var(--glass-border, #354b5a); background: var(--glass-bg, #0c1c26); color: inherit; border-radius: 4px; cursor: pointer; }
.county-incidents-filters :deep(button[aria-pressed=true]) { border-color: var(--display-accent, var(--accent)); background: var(--glass-hover, rgba(80,180,220,.14)); }
p { opacity: .85; line-height: 1.45; overflow-wrap: anywhere; }
:deep(.data-row-list) { max-height: none; overflow: visible; padding: 0; }
:deep(.data-row-list-item) { display: grid; gap: 5px; margin: 5px 0; padding: 9px; font-size: 11px; line-height: 1.45; letter-spacing: 0; }
:deep(.data-row-list-item::before) { display: none; }
:deep(.data-row-list-lead), :deep(.data-row-list-text) { min-width: 0; white-space: normal; overflow-wrap: anywhere; }
:deep(.data-row-list-lead) { color: var(--text-primary); font-weight: 600; opacity: 1; }
</style>
