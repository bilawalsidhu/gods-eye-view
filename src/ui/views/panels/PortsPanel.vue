<script setup>
import { storeToRefs } from 'pinia';
import { msg, t } from '../../../i18n/index.js';
import { usePortsStore } from '../../stores/ports.js';
import UiSelect from '../../kit/UiSelect.js';
import UiButton from '../../kit/UiButton.vue';
import UiPanel from '../../kit/UiPanel.vue';
const store = usePortsStore();
const { panel, collapsed } = storeToRefs(store);
const date = (ms) =>
  ms ? new Date(ms).toISOString() : t('Unknown');
const fields = [
  'operator',
  'ownership',
  'throughput',
  'capacity',
  'status',
  'expansion',
];
const facilityLabels = {
  container: msg('Container'),
  bulk: msg('Solid bulk'),
  oil: msg('Oil terminal'),
  lng: msg('LNG terminal'),
};
const labels = {
  operator: msg('Operator'),
  ownership: msg('Ownership'),
  throughput: msg('Annual throughput'),
  capacity: msg('Handling capacity'),
  status: msg('Operational status'),
  expansion: msg('Expansion projects'),
};
</script>

<template>
  <Teleport to="body"
    ><UiPanel
      v-if="panel"
      id="ports-panel"
      :title="t('Ports & terminals')"
      scroll
    >
      <template #actions>
        <UiButton :label="collapsed ? t('Expand {name}', { name: t('Ports & terminals') }) : t('Collapse {name}', { name: t('Ports & terminals') })" @click="collapsed = !collapsed">{{ collapsed ? '+' : '−' }}</UiButton>
      </template>
      <div v-show="!collapsed">
      <p>{{ t('Reference data, not live port status') }}</p>
      <label
        >{{ t('Country') }}
        <UiSelect
          :model-value="panel.country"
          @update:model-value="store.act('filter', { country: $event })"
        >
          <option value="">{{ t('All countries') }}</option>
          <option
            v-for="country in panel.countries"
            :key="country"
            :value="country"
            >{{ country }}</option
          >
        </UiSelect>
      </label>
      <label
        >{{ t('Terminal type') }}
        <UiSelect
          :model-value="panel.facility"
          @update:model-value="store.act('filter', { facility: $event })"
        >
          <option value="">{{ t('All types') }}</option>
          <option value="container">{{ t('Container') }}</option>
          <option value="bulk">{{ t('Solid bulk') }}</option>
          <option value="oil">{{ t('Oil terminal') }}</option>
          <option value="lng">{{ t('LNG terminal') }}</option>
        </UiSelect>
      </label>
      <p role="status"
        >{{ panel.rows.length }} / {{ panel.total }} ·
        {{ panel.loading ? t('Loading…') : t('Ports') }}</p
      >
      <p v-if="panel.error" role="alert">{{
        t(
          'Port reference unavailable; previously loaded records may be retained',
        )
      }}</p>
      <p v-if="panel.partial">{{
        t('Some source records could not be displayed')
      }}: {{ panel.excluded }}</p>
      <label
        >{{ t('Select a port') }}
        <UiSelect
          :model-value="panel.selected?.id || ''"
          @update:model-value="store.act('select', $event)"
        >
          <option value="">{{ t('Select a port') }}</option>
          <option v-for="row in panel.rows" :key="row.id" :value="row.id">{{
            row.name
          }}</option>
        </UiSelect>
      </label>
      <template v-if="panel.selected">
        <h3>{{ panel.selected.name }}</h3>
        <p
          >{{ panel.selected.country || t('Unknown') }} · {{ 'WPI' }} {{ panel.selected.id }} ·
          {{ panel.selected.unlocode || t('Unknown') }}</p
        >
        <dl>
          <template
            v-for="(value, type) in panel.selected.facilities"
            :key="type"
          >
            <dt>{{
              t(facilityLabels[type])
            }}</dt>
            <dd>{{
              value === null ? t('Unknown') : value ? t('Yes') : t('No')
            }}</dd>
          </template>
          <template v-for="field in fields" :key="field">
            <dt>{{ t(labels[field]) }}</dt>
            <dd v-if="panel.selected.facts[field]">
              {{ panel.selected.facts[field].value }}
              <small
                >{{ panel.selected.facts[field].scope }} ·
                {{ panel.selected.facts[field].period }}<template v-if="panel.selected.facts[field].published"> · {{ panel.selected.facts[field].published }}</template></small
              >
              <a
                :href="panel.selected.facts[field].source"
                target="_blank"
                rel="noopener noreferrer"
                >{{ t('Source') }}</a
              >
              <small
                >{{ t('Reviewed') }}:
                {{ panel.selected.facts[field].reviewed }}</small
              >
            </dd>
            <dd v-else>{{ t('Not provided by source') }}</dd>
          </template>
        </dl>
      </template>
      <p
        >{{ t('Mirror updated') }}: {{ date(panel.sourceUpdatedAt) }} ·
        {{ t('Retrieved') }}: {{ date(panel.fetchedAt) }}</p
      >
      <p>{{
        t('Mirror date is not a verification date for individual ports')
      }}</p>
      <a
        href="https://msi.nga.mil/Publications/WPI"
        target="_blank"
        rel="noopener noreferrer"
        >{{ 'NGA World Port Index' }}</a
      >
      <a
        href="https://arcgis.netl.doe.gov/server/rest/services/Hosted/CCS_EJ_SJ_Data/FeatureServer/17"
        target="_blank"
        rel="noopener noreferrer"
        >{{ 'DOE NETL' }}</a
      >
      </div>
    </UiPanel></Teleport
  >
</template>

<style scoped>
#ports-panel {
  position: fixed;
  top: 16vh;
  inset-inline-end: 6vw;
  width: min(340px, calc(100vw - 32px));
  max-height: 70vh;
  overflow-y: auto;
  pointer-events: auto;
  z-index: 180;
  padding: 14px;
  box-sizing: border-box;
  background: rgba(10, 20, 36, 0.98);
  border: 1px solid var(--glass-border, #277b89);
  border-radius: var(--panel-radius, 12px);
}
@media (max-width: 600px) {
  #ports-panel {
    top: 12vh;
    inset-inline-end: 16px;
    max-height: 65vh;
  }
}
label {
  display: block;
  margin: 0.65rem 0;
}
select {
  width: 100%;
  margin-top: 0.25rem;
}
dl {
  overflow-wrap: anywhere;
}
dt {
  margin-top: 0.65rem;
  font-weight: bold;
}
dd {
  margin: 0.25rem 0;
}
small {
  display: block;
  opacity: 0.8;
}
a {
  color: var(--accent, #4fd1c5);
  display: inline-block;
  margin-right: 0.6rem;
}
</style>
