<script setup>
import { t } from '../../i18n/index.js';
import ContextListCard from '../kit/ContextListCard.vue';
import RailCardBlocks from '../rail/RailCardBlocks.vue';

// Active weather: a short briefing (conditions at the map center, observed
// frames, wind, alerts) and the time of the observed frame, then the active
// products as rows, each with its short reading. A row opens the product's
// details. The world timeline moves time; the owner computes every value
// shown.
defineProps({
  view: { type: Object, required: true },
  selected: { type: String, default: null },
  onParams: { type: Function, default: () => {} },
  onSelect: { type: Function, default: () => {} },
});
</script>

<template>
  <ContextListCard
    v-if="!view.hidden"
    id="weather"
    class="weather-readout"
    :title="t('Active weather')"
    icon="partly_cloudy_day"
    :items="view.cards"
    :selected="selected"
    @select="onSelect($event.id)"
    @back="onSelect(null)"
  >
    <template #filter
      ><section
        class="weather-briefing"
        :hidden="!view.briefing.length"
        :aria-label="t('Weather briefing')"
        ><section
          v-for="section in view.briefing"
          :key="section.id"
          class="weather-briefing-section"
          :data-section-id="section.id"
          :aria-live="section.id === 'here' ? 'polite' : undefined"
          ><h3 class="panel-title">{{ section.title }}</h3
          ><RailCardBlocks
            :blocks="section.blocks"
            :card-id="section.layerId"
            :on-params="onParams" /></section></section
      ><div class="weather-frame-time" :hidden="!view.frameTime">{{
        view.frameTime
      }}</div></template
    >
    <template #row="{ item }"
      ><span class="data-icon" aria-hidden="true">{{ item.icon }}</span
      ><span class="nearby-lists__name" :data-card-id="item.id">{{
        item.title
      }}</span
      ><span
        class="nearby-lists__meta weather-compact"
        :class="{ status: item.compactStatus }"
        >{{ item.compact }}</span
      ></template
    >
    <template #detail="{ item }"
      ><h3 class="panel-title" :data-card-id="item.id"
        >{{ item.title }}
        <span class="weather-coverage">{{ item.badge }}</span></h3
      ><div class="weather-card"
        ><RailCardBlocks
          :blocks="item.blocks"
          :card-id="item.id"
          :on-params="onParams" /></div
    ></template>
  </ContextListCard>
</template>
