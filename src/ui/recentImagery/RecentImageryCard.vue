<script setup>
import { t } from '../../i18n/index.js';
import UiButton from '../kit/UiButton.vue';

// One imagery day in the strip. The owner computes every value; clicks reach
// it through the readout's delegated listener.
defineProps({
  card: { type: Object, required: true },
});
</script>

<template>
  <div
    :id="card.id"
    :class="[
      'ri-card',
      {
        focused: card.focused,
        pinned: card.pinned,
        preview: card.preview,
      },
    ]"
    :data-key="card.key"
    role="option"
    :aria-selected="String(card.focused)"
    :aria-label="card.ariaLabel"
    ><div class="ri-thumb" :data-status="card.status"
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
      ></div
    ><div class="ri-card-date">{{ card.date }}</div
    ><div class="ri-card-sensor">{{ card.sensor }}</div
    ><div class="ri-card-cloud">{{ card.cloud }}</div
    ><div class="ri-card-chips"
      ><UiButton
        v-for="chip in card.chips"
        :key="chip.slot"
        :class="['data-toggle-chip ri-chip', { 'is-reserved': chip.reserved }]"
        tabindex="-1"
        :data-slot="chip.slot"
        :disabled="Boolean(chip.disabled)"
        :pressed="Boolean(chip.active)"
        pressed-class="active"
        :aria-hidden="String(chip.reserved)"
        :aria-label="chip.ariaLabel"
        >{{ chip.label }}</UiButton
      ></div
    ></div
  >
</template>
