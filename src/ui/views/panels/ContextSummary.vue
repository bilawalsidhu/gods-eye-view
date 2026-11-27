<script setup>
import { computed } from 'vue';
import { greatCircleKm } from '../../../geoDistance.js';
import { distanceText } from '../../distanceText.js';
import UiButton from '../../kit/UiButton.vue';
import ContextBreakdownBar from './ContextBreakdownBar.vue';
import FieldPill from './FieldPill.vue';

// What a layer says of itself in Context (its `getContextSummary`): a line
// on what is counted, its items by legend band, a note on its coverage, and
// the items worth a look, each opening where it is. The parent owns
// selection and camera movement.
const props = defineProps({
  layerId: { type: String, required: true },
  summary: { type: Object, required: true },
  caption: { type: String, default: '' },
  // The view centre, for each item's distance from it.
  center: { type: Object, default: null },
});
const emit = defineEmits(['pick']);

const bar = computed(() => {
  const bands = (props.summary.bands || []).filter((band) => band.count > 0);
  const total = bands.reduce((sum, band) => sum + band.count, 0);
  if (!total) return null;
  return bands.map((band, index) => ({
    label: band.label,
    count: band.count,
    share: band.count / total,
    tone: index,
    color: band.color,
  }));
});
// How far each item is from the view centre, as Nearby rows show it.
function itemDistance(item) {
  if (!props.center) return '';
  const km = greatCircleKm(props.center, item);
  return Number.isFinite(km) ? distanceText(km) : '';
}
const rows = computed(() => (props.summary.items || []).map((item) => ({ item, distance: itemDistance(item) })));
// Its own row keys, apart from the Nearby rows of the same layer.
const rowKey = (item) => `summary:${props.layerId}:${item.key}`;
</script>

<template>
  <p v-if="caption" class="view-context__bar-key view-context__summary-caption">{{ caption }}</p>
  <ContextBreakdownBar v-if="bar" :parts="bar" :key-limit="bar.length" />
  <p v-if="summary.note" class="view-context__summary-note">{{ summary.note }}</p>
  <div v-if="rows.length" class="nearby-lists view-context__block-rows view-context__summary-rows">
    <ul :aria-label="summary.itemsLabel || undefined">
      <li v-for="({ item, distance }, index) in rows" :key="item.key">
        <UiButton :data-row-key="rowKey(item)" :data-row-layer="layerId" :data-row-index="index" :title="item.title || item.text" @click="emit('pick', item, $event)">
          <FieldPill tag="span" :text="item.lead" :level="item.level || ''" :color="item.color || ''" />
          <span class="nearby-lists__name">{{ item.text }}</span>
          <span v-if="distance" class="nearby-lists__meta">{{ distance }}</span>
        </UiButton>
      </li>
    </ul>
  </div>
</template>
