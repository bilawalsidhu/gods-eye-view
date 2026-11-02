<script setup>
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { formatDate, t } from '../../../i18n/index.js';
import { useWorldTimeStore } from '../../stores/worldTime.js';
import UiButton from '../../kit/UiButton.vue';
import UiIcon from '../../kit/UiIcon.vue';

// The world time while it is away from live: what is playing, or where it
// was paused, with play and pause on the left and the way back to live on
// the right. It shows only while a layer with a time of its own (weather,
// satellites, launches, or one a host follows) is on with time to show; live,
// or with only live feeds such as flights on, the bar stays hidden.
const store = useWorldTimeStore();
const { time } = storeToRefs(store);

const DATE_TIME = Object.freeze({
  dateStyle: 'medium',
  timeStyle: 'medium',
  timeZone: 'UTC',
});
const readout = computed(() =>
  Number.isFinite(time.value.timeMs)
    ? `${formatDate(time.value.timeMs, DATE_TIME)} UTC`
    : '',
);
</script>

<template>
  <div v-if="!time.live && time.supported" id="world-timeline" role="group" :aria-label="t('World time')"
    ><UiButton class="world-timeline-play" :label="time.playing ? t('Pause') : t('Play')" @click="store.togglePlay()"
      ><UiIcon :name="time.playing ? 'pause' : 'play_arrow'" :size="20" /></UiButton
    ><time class="world-timeline-time" :datetime="new Date(time.timeMs).toISOString()" aria-live="off">{{ readout }}</time
    ><UiButton class="world-timeline-live" :label="t('Back to live')" @click="store.goLive()">{{ t('Live') }}</UiButton
  ></div>
</template>
