<script setup>
import { t } from '../../i18n/index.js';
import RailCards from '../rail/RailCards.vue';
import RailTimeline from '../rail/RailTimeline.vue';

// Active weather: forecast and event cards, then the observed products with
// their shared history timeline. The owner computes every value shown.
defineProps({
  view: { type: Object, required: true },
  onParams: { type: Function, default: () => {} },
  onOpen: { type: Function, default: () => {} },
  transport: { type: Object, required: true },
});
</script>

<template>
  <section
    class="weather-readout"
    :hidden="view.hidden"
    :aria-label="t('Active weather')"
    ><div class="weather-cards"
      ><RailCards
        :cards="view.cards"
        card-class-name="weather-card"
        badge-class-name="weather-coverage"
        :on-params="onParams"
        :on-open="onOpen" /></div
    ><section
      class="weather-observed-group"
      :hidden="!view.observed"
      :aria-label="t('Observed history')"
      ><h3 class="panel-title">{{ t('Observed history') }}</h3
      ><div class="weather-observed-scope">{{ view.scope }}</div
      ><div class="weather-timeline-block" :hidden="!view.observed"
        ><RailTimeline
          :state="view.timeline"
          slider-class-name="weather-timeline"
          :heading="false"
          :on-commit="transport.onCommit"
          :on-preview="transport.onPreview"
          :on-step="transport.onStep"
          :on-latest="transport.onLatest"
          :on-play="transport.onPlay" /></div
      ><div class="weather-cards"
        ><RailCards
          :cards="view.observedCards"
          card-class-name="weather-card"
          badge-class-name="weather-coverage"
          :on-params="onParams"
          :on-open="onOpen" /></div></section
  ></section>
</template>
