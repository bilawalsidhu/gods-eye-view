<script setup>
import { storeToRefs } from 'pinia';
import { computed } from 'vue';
import { t } from '../../../i18n/index.js';
import { useGlobeActionsStore } from '../../stores/globeActions.js';
import UiButton from '../../kit/UiButton.vue';
import UiIcon from '../../kit/UiIcon.vue';

// The north-up button: its needle and label follow the published heading,
// which changes on every frame a rotating camera draws. Before the camera
// controls first publish, it shows no heading.
defineEmits(['click']);
const { camera } = storeToRefs(useGlobeActionsStore());
const heading = computed(() => camera.value?.heading);
const label = computed(() =>
  heading.value == null
    ? t('Reset map to north up')
    : t('Reset map to north up. Current heading {heading} degrees', {
        heading: heading.value,
      }),
);
</script>

<template>
<UiButton id="north-up-view" :aria-label="label" :data-north-up="heading == null ? undefined : String(heading === 0)" :style="heading == null ? undefined : { '--camera-heading': `${heading}deg` }" :title="t('Reset map bearing to north')" @click="$emit('click')">
  <span class="camera-compass-n" aria-hidden="true">N</span>
  <UiIcon class="camera-compass-needle" name="navigation" :size="null" />
</UiButton>
</template>
