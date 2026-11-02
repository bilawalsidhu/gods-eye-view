<script setup>
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { formatDate, t } from '../../../i18n/index.js';
import { useWorldTimeStore } from '../../stores/worldTime.js';
import UiButton from '../../kit/UiButton.vue';
import UiIcon from '../../kit/UiIcon.vue';
import UiSelect from '../../kit/UiSelect.js';

// The world timeline: play and pause and the speed on the left, a track
// across the stretch the layers on can show (each launch or frame a tick)
// with a handle to scrub and the time in a bubble over it, and the way back
// to live on the right, lit while live. It
// shows while a layer with a time of its own (weather, satellites, launches,
// or one a host follows) is on with time to show; with only live feeds such
// as flights on, the bar stays hidden.
const store = useWorldTimeStore();
const { time, speed } = storeToRefs(store);
const speeds = computed(() => [
  { value: 'real', label: '1×' },
  { value: 'hour', label: t('1 h/s') },
  { value: 'day', label: t('1 d/s') },
  { value: 'week', label: t('1 wk/s') },
]);

const DATE_TIME = Object.freeze({
  dateStyle: 'medium',
  timeStyle: 'medium',
  timeZone: 'UTC',
});
// The bubble over the handle: the date and the minute, kept short.
const BUBBLE_DATE = Object.freeze({
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});
const BUBBLE_TIME = Object.freeze({
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});
// The keyboard's fallback step, as a share of the track, with no mark to go to.
const KEY_STEP = 0.01;
const PAGE_STEP = 0.1;

const readout = computed(() =>
  Number.isFinite(time.value.timeMs)
    ? `${formatDate(time.value.timeMs, DATE_TIME)} UTC`
    : '',
);
const bubble = computed(() =>
  Number.isFinite(time.value.timeMs)
    ? `${formatDate(time.value.timeMs, BUBBLE_DATE)} · ${formatDate(time.value.timeMs, BUBBLE_TIME)} UTC`
    : '',
);
const span = computed(() => time.value.span);
const at = computed(() => {
  const { start, end } = span.value;
  return Math.min(end, Math.max(start, time.value.timeMs));
});
const place = (ms) => {
  const { start, end } = span.value;
  return end > start ? ((ms - start) / (end - start)) * 100 : 100;
};
const ticks = computed(() =>
  span.value.marks.map((mark) => `${place(mark)}%`),
);
const scrub = (event) => store.scrub(Number(event.target.value));
// Arrows go to the previous or next mark (a launch, a frame), or a step along
// the track; Page keys take a tenth of it; Home and End go to its ends.
const onKey = (event) => {
  const { start, end, marks } = span.value;
  const now = at.value;
  const length = end - start;
  let to = null;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowDown')
    to = marks.findLast((mark) => mark < now) ?? now - length * KEY_STEP;
  else if (event.key === 'ArrowRight' || event.key === 'ArrowUp')
    to = marks.find((mark) => mark > now) ?? now + length * KEY_STEP;
  else if (event.key === 'PageDown') to = now - length * PAGE_STEP;
  else if (event.key === 'PageUp') to = now + length * PAGE_STEP;
  else if (event.key === 'Home') to = start;
  else if (event.key === 'End') to = end;
  if (to === null) return;
  event.preventDefault();
  store.scrub(Math.min(end, Math.max(start, to)));
};
</script>

<template>
  <div v-if="time.supported && time.span" id="world-timeline" role="group" :aria-label="t('World time')"
    ><UiButton class="world-timeline-play" :label="time.playing ? t('Pause') : t('Play')" @click="store.togglePlay()"
      ><UiIcon :name="time.playing ? 'pause' : 'play_arrow'" :size="20" /></UiButton
    ><UiSelect class="gev-field gev-field--compact world-timeline-speed" :aria-label="t('Play speed')" :title="t('Play speed')" :options="speeds" :model-value="speed" @update:model-value="store.setSpeed($event)"
    /><div class="world-timeline-track"
      ><time class="world-timeline-time" :class="{ 'is-buffering': time.buffering }" :style="{ '--at': place(at) / 100 }" :datetime="new Date(time.timeMs).toISOString()" aria-live="off">{{ bubble }}</time
      ><span v-for="(left, index) in ticks" :key="index" class="world-timeline-tick" :style="{ left }" aria-hidden="true"></span
      ><span class="world-timeline-fill" :style="{ width: `${place(at)}%` }" aria-hidden="true"></span
      ><input
        class="world-timeline-scrub"
        type="range"
        :aria-label="t('World time')"
        :aria-valuetext="readout"
        :min="span.start"
        :max="span.end"
        step="any"
        :value="at"
        @input="scrub"
        @keydown="onKey"
    /></div
    ><UiButton class="world-timeline-live" :label="time.live ? t('Live') : t('Back to live')" :pressed="time.live" pressed-class="is-live" :disabled="time.live" @click="store.goLive()">{{ t('Live') }}</UiButton
  ></div>
</template>
