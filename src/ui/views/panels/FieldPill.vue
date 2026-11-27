<script setup>
import { LEGEND_COLOR } from '../../fieldReading.js';
// A reading in its legend band: the band's colour as a dot beside its words,
// as Conditions here shows it. Without a band, the words alone.
defineProps({
  text: { type: String, default: '' },
  level: { type: String, default: '' },
  color: { type: String, default: '' },
  tag: { type: String, default: 'strong' },
});
</script>

<template>
  <!-- Whitespace is preserved in templates: the pill's children touch so no
       space renders before the swatch or the words. -->
  <component :is="tag" class="field-pill" :data-level="(level && LEGEND_COLOR.test(color) && level) || undefined" :style="LEGEND_COLOR.test(color) ? { '--field-band': color } : undefined"><i v-if="LEGEND_COLOR.test(color)" class="spot-conditions__field-swatch" aria-hidden="true"></i><span class="field-pill__text">{{ text }}</span></component>
</template>
