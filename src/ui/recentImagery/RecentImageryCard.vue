<script setup>
import { t } from '../../i18n/index.js';
import UiButton from '../kit/UiButton.vue';

// One imagery day, a row of the readout's list: the day (a click previews
// it), then its SHOW or A / B chips. The owner computes every value; clicks
// reach it through the readout's delegated listener.
defineProps({
  card: { type: Object, required: true },
});
</script>

<template>
  <div
    :class="[
      'ri-card',
      {
        focused: card.focused,
        pinned: card.pinned,
        preview: card.preview,
      },
    ]"
    :data-key="card.key"
    ><UiButton
      class="ri-card-open"
      data-list-primary
      :aria-label="card.ariaLabel"
      ><span class="ri-thumb" :data-status="card.status"
        ><img
          v-if="card.image"
          class="ri-thumb-img"
          alt=""
          decoding="async"
          :src="card.image.src"
          :hidden="card.image.hidden"
        /><span
          class="ri-thumb-text"
          :hidden="Boolean(card.image && !card.image.hidden)"
          >{{ card.placeholder }}</span
        ><span class="ri-card-flag" :hidden="!card.flag">{{ card.flag }}</span
        ><span
          class="ri-card-start"
          :hidden="!card.start"
          :title="card.start || undefined"
          >{{ t('START HERE') }}</span
        ></span
      ><span class="ri-card-date">{{ card.date }}</span
      ><span class="ri-card-sensor">{{ card.sensor }}</span
      ><span class="ri-card-cloud">{{ card.cloud }}</span></UiButton
    ><span class="ri-card-chips"
      ><UiButton
        v-for="chip in card.chips"
        :key="chip.slot"
        :class="['data-toggle-chip ri-chip', { 'is-reserved': chip.reserved }]"
        :data-slot="chip.slot"
        :disabled="Boolean(chip.disabled)"
        :pressed="Boolean(chip.active)"
        pressed-class="active"
        :aria-hidden="String(chip.reserved)"
        :aria-label="chip.ariaLabel"
        >{{ chip.label }}</UiButton
      ></span
    ></div
  >
</template>
