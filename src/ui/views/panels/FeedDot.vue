<script setup>
import { computed } from 'vue';
import { t } from '../../../i18n/index.js';

// A view's feed state as one dot, the same on the docked view, the radio
// mini player and pinned tiles: green and gently pulsing while live (steady
// with reduced motion), an amber ring while loading, amber while paused, red
// with no feed. Its state is also said, not only shown in colour.
const props = defineProps({
  /** 'live', 'loading', 'paused' or 'lost'. */
  state: { type: String, default: 'live' },
  /** What it says instead of the state's own word, already translated ("Docked · stalled"). */
  label: { type: String, default: '' },
});
const LABELS = { live: () => t('Live'), loading: () => t('Loading'), paused: () => t('Paused'), lost: () => t('No feed') };
const label = computed(() => props.label || (LABELS[props.state] || LABELS.lost)());
</script>

<template>
  <span class="feed-dot" :data-state="state" role="img" :aria-label="label" :title="label"></span>
</template>
