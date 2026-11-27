<script setup>
import { t } from '../../../i18n/index.js';
import FeedDot from './FeedDot.vue';

// A paused view's chip, one line, top left of its picture: an amber dot and
// "Paused", the reason ("Cameras off · last frame") in its tooltip and label.
// As an image, the chip is read by its label, so the reason is announced.
// The same chip on pinned tiles, the docked view and a card's top image.
defineProps({
  /** Why it is paused. */
  reason: { type: String, default: '' },
});
</script>

<template>
  <span class="paused-chip" role="img" :title="reason || undefined" :aria-label="reason ? t('Paused: {reason}', { reason }) : t('Paused')">
    <FeedDot state="paused" aria-hidden="true" />{{ t('Paused') }}
  </span>
</template>
