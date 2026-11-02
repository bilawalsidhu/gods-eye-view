<script setup>
import { computed } from 'vue';
import { rowTextRuns } from '../layerRowText.js';

// Row text that wraps well in every language: hyphenated codes and the
// space before a " · " separator never break (see rowTextRuns).
const props = defineProps({
  tag: { type: String, default: 'span' },
  text: { type: String, default: '' },
});
const runs = computed(() => rowTextRuns(props.text));
</script>

<template>
  <component :is="tag"
    ><template v-if="runs"
      ><span
        v-for="(run, index) in runs"
        :key="index"
        v-bind="run.keep ? { class: 'data-keep' } : {}"
        >{{ run.text }}</span
      ></template
    ><template v-else>{{ text }}</template></component
  >
</template>
