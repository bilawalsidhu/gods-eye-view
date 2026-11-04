<script setup>
import { computed, watch } from 'vue';
import { t } from '../../../i18n/index.js';
import { VESSEL_TYPES } from '../../../data/vesselDisplayFilters.js';
import { displayVesselType } from '../../../data/vesselLabels.js';
import { useVesselPanelStore } from '../../stores/vesselPanel.js';
import { usePanelChromeStore } from '../../stores/panelChrome.js';
import RailPanel from '../../rail/RailPanel.vue';
import UiButton from '../../kit/UiButton.vue';

const typeLabel = type => type === 'UNKNOWN' ? t('Unknown') : displayVesselType(type);
const vessels = useVesselPanelStore();
const chrome = usePanelChromeStore();
const filters = computed(() => vessels.filters);
watch(() => vessels.available && !(chrome.panels['vessel-panel']?.collapsed ?? true),
  (visible) => vessels.act('visibility', visible), { immediate: true });
const change = (patch) => vessels.act('filter', patch);
function toggleType(kind, checked) {
  change({ types: checked ? [...filters.value.types, kind] : filters.value.types.filter((value) => value !== kind) });
}
</script>

<template>
  <RailPanel id="vessel-panel" :hidden="!vessels.available" start-collapsed :title="t('VESSELS')" sideways>
    <div class="cyber-panel-body ui-scroll vessel-panel-body" data-rail-scroller>
      <fieldset>
        <legend>{{ t('Map filters') }}</legend>
        <label><input id="vessel-declutter" type="checkbox" :checked="filters.declutterEnabled" @change="change({ declutterEnabled: $event.target.checked })">{{ t('Declutter') }}</label>
        <label class="vessel-select-label">{{ t('Density') }}
          <select id="vessel-density" :disabled="!filters.declutterEnabled" :value="filters.density" @change="change({ density: $event.target.value })">
            <option value="balanced">{{ t('Balanced') }}</option><option value="sparse">{{ t('Sparse') }}</option>
          </select>
        </label>
        <label><input id="vessel-underway" type="checkbox" :checked="filters.underwayOnly" @change="change({ underwayOnly: $event.target.checked })">{{ t('Underway only') }}</label>
        <p>{{ t('Decluttering reduces icons in wide views. Zoom in to reveal more vessels.') }}</p>
        <p>{{ t('Underway means a reported speed above 1 kn. Unknown speeds are excluded when speed filters are enabled.') }}</p>
      </fieldset>
      <fieldset>
        <legend><label><input id="vessel-type-enabled" type="checkbox" :checked="filters.typeFilterEnabled" @change="change({ typeFilterEnabled: $event.target.checked })">{{ t('Vessel types') }}</label></legend>
        <div class="vessel-type-grid">
          <label v-for="kind in VESSEL_TYPES" :key="kind"><input type="checkbox" :data-vessel-type="kind" :disabled="!filters.typeFilterEnabled" :checked="filters.types.includes(kind)" @change="toggleType(kind, $event.target.checked)">{{ typeLabel(kind) }}</label>
        </div>
        <div class="vessel-feed-tabs">
          <UiButton :disabled="!filters.typeFilterEnabled" @click="change({ types: [...VESSEL_TYPES] })">{{ t('All types') }}</UiButton>
          <UiButton :disabled="!filters.typeFilterEnabled" @click="change({ types: [] })">{{ t('Clear types') }}</UiButton>
        </div>
      </fieldset>
      <fieldset>
        <legend><label><input id="vessel-speed-enabled" type="checkbox" :checked="filters.speedFilterEnabled" @change="change({ speedFilterEnabled: $event.target.checked })">{{ t('Speed range') }}</label></legend>
        <div class="vessel-speed-inputs">
          <label>{{ t('Minimum speed (kn)') }}<input id="vessel-min-speed" type="number" min="0" max="102.2" step="0.5" :disabled="!filters.speedFilterEnabled" :value="filters.minSpeedKn" @change="change({ minSpeedKn: Number($event.target.value) })"></label>
          <label>{{ t('Maximum speed (kn)') }}<input id="vessel-max-speed" type="number" min="0" max="102.2" step="0.5" :disabled="!filters.speedFilterEnabled" :value="filters.maxSpeedKn" @change="change({ maxSpeedKn: Number($event.target.value) })"></label>
        </div>
      </fieldset>
      <p>{{ t('Selected vessels remain visible. Filters are saved in this browser.') }}</p>
      <UiButton id="vessel-reset-filters" @click="vessels.act('reset')">{{ t('Reset filters') }}</UiButton>
      <div class="vessel-roster">
        <label>{{ t('Vessel list') }}<input id="vessel-search" type="search" :value="vessels.search" :placeholder="t('Search name, MMSI, IMO or destination')" @input="vessels.act('search', $event.target.value)"></label>
        <p role="status">{{ t('{matching} matching · {total} loaded', { matching: vessels.list.matching, total: vessels.list.total }) }}</p>
        <p>{{ t('The list includes matching vessels hidden by decluttering. Select a vessel to inspect it.') }}</p>
        <ul>
          <li v-for="vessel in vessels.list.rows" :key="vessel.id">
            <UiButton :pressed="vessel.selected" :disabled="!vessels.enabled" :data-vessel-id="vessel.id" @click="vessels.act('select', vessel.id)">
              <strong>{{ vessel.label }}</strong><span>{{ vessel.id }} · {{ typeLabel(vessel.type) }}</span>
              <span>{{ vessel.speedKn === null ? '—' : `${vessel.speedKn.toLocaleString()} kn` }} · {{ vessel.visible ? t('On map') : t('Hidden on map') }}</span>
            </UiButton>
          </li>
        </ul>
        <p v-if="!vessels.list.rows.length">{{ t('No matching vessels') }}</p>
        <div class="vessel-pagination">
          <UiButton :disabled="vessels.list.page === 0" @click="vessels.act('page', vessels.list.page - 1)">{{ t('Previous') }}</UiButton>
          <span>{{ vessels.list.page + 1 }} / {{ vessels.list.pages }}</span>
          <UiButton :disabled="vessels.list.page + 1 >= vessels.list.pages" @click="vessels.act('page', vessels.list.page + 1)">{{ t('Next') }}</UiButton>
        </div>
      </div>
      <p v-if="vessels.error" role="alert">{{ vessels.error }}</p>
    </div>
  </RailPanel>
</template>

<style scoped>
:deep(.vessel-panel-inner) { display: flex; flex-direction: column; padding: 0; background: var(--panel-bg, rgba(5,15,24,.94)); border: 1px solid var(--glass-border); border-radius: 12px; max-height: inherit; overflow: hidden; box-sizing: border-box; }
:deep(.vessel-panel-inner > .panel-header) { flex: none; margin: 0; padding: 12px 14px; }
.collapsed .vessel-panel-body { display: none; }
.vessel-panel-body { display: block; flex: 1; min-height: 0; overflow-y: auto; padding: 0 12px 12px; font-size: 12px; }
.vessel-feed-tabs, .vessel-pagination { display: flex; align-items: center; gap: 6px; margin-bottom: 10px; }
fieldset { min-width: 0; border: 1px solid var(--glass-border, #354b5a); margin: 12px 0; padding: 10px; }
label { display: flex; align-items: center; gap: 6px; margin: 5px 0; }
input[type=checkbox] { flex: none; }
select, input[type=number], input[type=search] { min-width: 0; width: 100%; color: inherit; background: var(--glass-bg, #0c1c26); border: 1px solid var(--glass-border, #354b5a); padding: 6px; border-radius: 4px; }
.vessel-type-grid, .vessel-speed-inputs { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 4px; }
.vessel-speed-inputs label, .vessel-roster > label { display: block; }
.vessel-select-label { justify-content: space-between; }
.vessel-select-label select { width: auto; }
p { opacity: .78; line-height: 1.45; margin: 8px 0; }
ul { list-style: none; margin: 10px 0; padding: 0; }
li { margin: 5px 0; }
li :deep(button) { width: 100%; text-align: left; display: grid; gap: 3px; }
li span { font-size: 11px; opacity: .8; }
:deep(button) { padding: 7px 9px; border: 1px solid var(--glass-border, #354b5a); background: var(--glass-bg, #0c1c26); color: inherit; border-radius: 4px; cursor: pointer; }
:deep(button[aria-pressed=true]) { border-color: var(--display-accent, #69cbd1); }
:deep(button:disabled), input:disabled, select:disabled { opacity: .45; cursor: default; }
.vessel-pagination { justify-content: space-between; }
</style>
