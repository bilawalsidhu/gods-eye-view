<script setup>
import { formatNumber, t } from '../../../i18n/index.js';
import { shownLayerName } from '../../layerNames.js';
import { approximatePosition, distanceText as distance } from '../../distanceText.js';
import EntityMark from './EntityMark.vue';
import { markKind } from '../../entityMark.js';
import UiButton from '../../kit/UiButton.vue';
import UiIcon from '../../kit/UiIcon.vue';

// Selecting a row belongs to the parent: it moves the camera.
defineProps({
  /** From the store's `nearbyLayers`. */
  lists: { type: Array, required: true },
  /** Shown on the line above the lists. */
  title: { type: String, required: true },
});

const emit = defineEmits(['select']);

// What a moving item is doing, as the layer's own display shows it (transit
// vehicles report it): an icon on its row, its words on hover.
const MOTION_STATES = {
  moving: { icon: 'play_arrow', label: () => t('Moving') },
  stopped: { icon: 'pause', label: () => t('Stopped', { context: 'vehicle motion' }) },
  waiting: { icon: 'schedule', label: () => t('Waiting for update') },
  'no-fix': { icon: 'location_off', label: () => t('No recent fix') },
};
const motionOf = (item) => MOTION_STATES[item.identity?.record?.motion] || null;

</script>

<template>
  <section v-if="lists.some((list) => list.items.length)" class="nearby-lists" :aria-label="title">
    <h4 class="nearby-lists__title" tabindex="-1">{{ title }}</h4>
    <template v-for="list in lists" :key="list.layerId">
      <div v-if="list.items.length" class="nearby-lists__layer" :data-layer="list.layerId">
        <h5 class="nearby-lists__head">
          <UiIcon :name="list.icon" :size="null" />
          <span>{{ shownLayerName(list.layerName, list.layerId) }}</span>
          <span class="nearby-lists__count"><template v-if="list.layerId === 'traffic'">{{ t('Road segments') }} · </template>{{ formatNumber(list.count) }}</span>
        </h5>
        <ul>
          <li v-for="(item, index) in list.items" :key="item.key" :class="{ 'nearby-lists__row--nearest': index === 0 }">
            <UiButton
              :data-row-key="item.key"
              :data-row-layer="list.layerId"
              :data-row-index="index"
              @click="emit('select', item, $event)"
            >
              <UiIcon
                v-if="motionOf(item)"
                :name="motionOf(item).icon"
                :size="null"
                class="nearby-lists__motion"
                :data-motion="item.identity.record.motion"
                :title="motionOf(item).label()"
                role="img"
                :aria-label="motionOf(item).label()"
                :aria-hidden="null"
              />
              <EntityMark class="nearby-lists__mark" :layer="item.layerId" :kind="markKind(item.layerId, item.identity?.record)" :icon="list.icon" :size="16" />
              <span class="nearby-lists__name" :title="item.title">{{ item.title }}</span>
              <span v-if="index === 0" class="nearby-lists__badge">{{ t('Nearest') }}</span>
              <span class="nearby-lists__meta">{{ distance(item.distanceKm, approximatePosition(item.identity.record)) }}</span>
            </UiButton>
          </li>
        </ul>
      </div>
    </template>
  </section>
</template>
