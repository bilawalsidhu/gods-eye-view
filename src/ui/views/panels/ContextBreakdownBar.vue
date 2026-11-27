<script setup>
import { LEGEND_COLOR } from '../../fieldReading.js';
import { computed } from 'vue';
import { formatNumber, getLocale, t } from '../../../i18n/index.js';

const props = defineProps({
  parts: { type: Array, required: true },
  /** How many parts the key names; the bar draws them all. */
  keyLimit: { type: Number, default: 3 },
});
// A part may carry its own legend colour (a layer's band) in place of a tone.
const colour = (part) => (LEGEND_COLOR.test(part.color || '') ? { '--part-color': part.color } : {});

const listFormatter = computed(() => new Intl.ListFormat(getLocale(), { type: 'unit' }));
const partLabel = (part) => `${t(part.label)} ${formatNumber(part.count)}`;
const label = computed(() => listFormatter.value.format(props.parts.map(partLabel)));
</script>

<template>
  <div class="view-context__bar" role="img" :aria-label="label">
    <span v-for="part in parts" :key="part.label" :data-tone="part.tone" :data-color="colour(part)['--part-color'] ? '' : undefined" :style="{ flexGrow: part.share, ...colour(part) }"></span>
  </div>
  <p class="view-context__bar-key">
    <span v-for="part in parts.slice(0, keyLimit)" :key="part.label" :data-tone="part.tone" :data-color="colour(part)['--part-color'] ? '' : undefined" :style="colour(part)">{{ partLabel(part) }}</span>
  </p>
</template>
