<script setup>
import { LEGEND_COLOR } from '../../fieldReading.js';
import { computed } from 'vue';
import { getLocale } from '../../../i18n/index.js';
import FieldPill from './FieldPill.vue';

// An item's reading on its layer's banded scale (describeReading), leading
// its card: the value in its band's colour, the band, where the value sits
// on the scale's bands, and the band's health message.
const props = defineProps({
  reading: { type: Object, required: true },
});
const color = computed(() => (LEGEND_COLOR.test(props.reading.band?.color || '') ? props.reading.band.color : ''));
const shown = computed(() => [props.reading.scale, props.reading.value].filter(Boolean).join(' '));
const label = computed(() =>
  new Intl.ListFormat(getLocale(), { type: 'unit' }).format([shown.value, props.reading.risk || props.reading.band?.label].filter(Boolean)),
);
const segments = computed(() => (props.reading.segments || []).filter((segment) => segment.share > 0 && LEGEND_COLOR.test(segment.color || '')));
const at = computed(() => `${Math.round(Math.min(1, Math.max(0, Number(props.reading.at) || 0)) * 1000) / 10}%`);
</script>

<template>
  <section class="reading-hero" role="group" :aria-label="label" :style="color ? { '--field-band': color } : undefined">
    <div class="reading-hero__top">
      <strong class="reading-hero__value"><small>{{ reading.scale }}</small>{{ reading.value }}</strong>
      <FieldPill v-if="reading.band" tag="span" :text="reading.band.label" :level="reading.band.id || ''" :color="color" />
    </div>
    <div v-if="segments.length" class="reading-hero__scale" aria-hidden="true">
      <span v-for="segment in segments" :key="segment.id" :title="segment.label" :style="{ flexGrow: segment.share, background: segment.color }"></span>
      <i class="reading-hero__marker" :style="{ insetInlineStart: at }"></i>
    </div>
    <p v-if="reading.risk" class="reading-hero__risk">{{ reading.risk }}</p>
  </section>
</template>
