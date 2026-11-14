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
        <UiButton data-county-category="traffic" :title="t('Public WebCAD traffic reports')" :pressed="incidents.view?.categories.includes('traffic')" @click="incidents.act('category', 'traffic')">{{ t('Traffic') }}</UiButton>
      </div>
      <fieldset class="county-coverage">
        <legend>{{ t('County coverage') }}</legend>
        <label v-for="county in incidents.view?.counties || []" :key="county.id">
          <input type="checkbox" :data-county-filter="county.id" :checked="county.active" @change="incidents.act('county', county.id)">
          <span>{{ county.label }}<small v-if="county.hint">{{ county.hint }}</small></span>
        </label>
      </fieldset>
      <div class="county-incidents-actions">
        <UiButton v-for="chip in (incidents.view?.chips || []).filter(chip => chip.id === 'county')" :key="chip.id" :data-county-action="chip.id" :disabled="!!chip.disabled" @click="incidents.act('chip', chip.id)">{{ chip.label }}</UiButton>
      </div>
      <details v-if="incidents.view?.feedInfo?.length" class="county-source-details">
        <summary>{{ t('Sources and freshness') }}</summary>
        <p v-for="feed in incidents.view?.feedInfo || []" :key="feed">{{ feed }}</p>
      </details>
      <p role="status">{{ incidents.view?.info }}</p>
      <section v-if="incidents.view?.selection" class="county-selection" aria-live="polite">
        <strong>{{ incidents.view.selection.title }}</strong>
        <p v-for="(line, index) in incidents.view.selection.lines" :key="index">{{ line }}</p>
      </section>
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
.county-coverage { border: 0; padding: 0; margin: 10px 0; display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 7px; }
.county-coverage legend { margin-bottom: 7px; opacity: .8; }
.county-coverage label { display: flex; align-items: start; gap: 6px; cursor: pointer; font-size: 11px; }
.county-coverage input { accent-color: var(--accent); margin: 2px 0 0; flex: none; }
.county-coverage small { display: block; opacity: .75; font-size: 10px; }
.county-selection { border: 1px solid var(--glass-border); border-radius: 6px; padding: 10px; margin: 10px 0; }
.county-selection p { margin: 6px 0; }
.county-source-details summary { cursor: pointer; padding: 7px 0; }
p { opacity: .85; line-height: 1.45; overflow-wrap: anywhere; }
:deep(.data-row-list) { max-height: none; overflow: visible; padding: 0; }
:deep(.data-row-list-item) { display: grid; gap: 5px; margin: 5px 0; padding: 9px; font-size: 11px; line-height: 1.45; letter-spacing: 0; }
:deep(.data-row-list-item::before) { display: none; }
:deep(.data-row-list-lead), :deep(.data-row-list-text) { min-width: 0; white-space: normal; overflow-wrap: anywhere; }
:deep(.data-row-list-lead) { color: var(--text-primary); font-weight: 600; opacity: 1; }
</style>
