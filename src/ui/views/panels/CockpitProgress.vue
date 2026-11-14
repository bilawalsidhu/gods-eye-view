<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { cockpitProgressLayout } from '../../../cockpitProgress.js';

// A provider subject's progress line (src/cockpitSubjectProviders.js): a thin
// line along the bottom of the view, its ticks, labels and marker laid out
// at the line's own width (src/cockpitProgress.js). The part before the
// marker is dimmed. Everything it shows is worded by the provider. It is an
// image named by the provider's summary; with no summary it is decoration,
// hidden from assistive technology.

const props = defineProps({
  progress: { type: Object, required: true },
});

/** The width laid out at before the line is measured (px). */
const FALLBACK_WIDTH_PX = 960;

const root = ref(null);
const widthPx = ref(0);
let observer = null;

const measure = () => {
  widthPx.value = root.value?.clientWidth || 0;
};

onMounted(() => {
  measure();
  if (typeof ResizeObserver === 'function' && root.value) {
    observer = new ResizeObserver(measure);
    observer.observe(root.value);
  }
});
onBeforeUnmount(() => observer?.disconnect());

const width = computed(() => widthPx.value || FALLBACK_WIDTH_PX);
const layout = computed(() =>
  cockpitProgressLayout(props.progress, width.value),
);
// Positions as shares of the line, so a resize between measurements keeps
// every mark in place.
const percent = (x) => `${((x / width.value) * 100).toFixed(3)}%`;
</script>

<template>
  <div ref="root" class="cockpit-progress" :role="progress.summary ? 'img' : undefined" :aria-label="progress.summary || undefined" :aria-hidden="progress.summary ? undefined : 'true'">
    <template v-if="layout">
      <div class="cockpit-progress-line" aria-hidden="true">
        <span class="cockpit-progress-travelled" :style="{ width: percent(layout.travelledX) }"></span>
      </div>
      <i v-for="(tick, index) in layout.ticks" :key="`t${index}`" class="cockpit-progress-tick" :class="{ labelled: tick.labelled, merged: tick.count > 1, travelled: tick.x <= layout.travelledX }" :data-tone="tick.tone" :style="{ left: percent(tick.x) }" aria-hidden="true"></i>
      <span v-for="(label, index) in layout.labels" :key="`l${index}`" class="cockpit-progress-label" :data-align="label.align" :data-tone="label.tone" :style="{ left: percent(label.left), width: `${label.width}px` }" aria-hidden="true"><b>{{ label.text }}</b><small v-if="label.detail">{{ label.detail }}</small></span>
      <i v-if="layout.marker" class="cockpit-progress-marker" :class="{ dwell: layout.marker.dwell }" :style="{ left: percent(layout.marker.x) }" aria-hidden="true"></i>
      <span v-if="layout.tag" class="cockpit-progress-tag" aria-hidden="true">{{ layout.tag }}</span>
    </template>
  </div>
</template>
