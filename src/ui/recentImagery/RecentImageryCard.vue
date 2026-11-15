<script setup>
import { t } from '../../i18n/index.js';

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
      ><button
        v-for="chip in card.chips"
        :key="chip.slot"
        type="button"
        :class="[
          'data-toggle-chip ri-chip',
          { active: chip.active, 'is-reserved': chip.reserved },
        ]"
        tabindex="-1"
        :data-slot="chip.slot"
        :disabled="chip.disabled"
        :aria-pressed="String(chip.active)"
        :aria-hidden="String(chip.reserved)"
        :aria-label="chip.ariaLabel"
        >{{ chip.label }}</button
      ></div
    ></div
  >
</template>
