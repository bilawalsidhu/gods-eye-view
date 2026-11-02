<script setup>
import { computed, shallowRef, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { formatDate, t } from '../../../i18n/index.js';
import { useWorldTimeStore } from '../../stores/worldTime.js';
import UiButton from '../../kit/UiButton.vue';
import UiIcon from '../../kit/UiIcon.vue';
import UiSelect from '../../kit/UiSelect.js';

// The world timeline: play and pause and the speed on the left, a track
// across the stretch the layers on can show (each launch or frame a tick)
// with a handle to scrub and the time in a bubble over it, and the way back
// to live on the right, lit while live. Scrolling or pinching the track
// zooms it around the handle; a double-click shows it all again. It shows
// while a layer with a time of its own (weather, satellites, launches,
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
// Zooming: the shortest stretch the track narrows to, the step a key or a
// notch of the wheel takes, and how far a wheel's pixel of scroll zooms.
const MIN_VIEW_MS = 5 * 60_000;
const ZOOM_STEP = 1.5;
const WHEEL_ZOOM = 0.0025;
// Two presses this close are a double-click.
const DOUBLE_PRESS_MS = 500;

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
// Where the handle is, or null with no track.
const at = computed(() => {
  if (!span.value) return null;
  const { start, end } = span.value;
  return Math.min(end, Math.max(start, time.value.timeMs));
});

// The track shows the whole span, or zoomed, a stretch of it: `length` long,
// ending at `end`, or at the span's end (and so at now) while `end` is null.
// Everything still plays together; zooming only changes what the track shows.
const zoom = shallowRef(null);
const view = computed(() => {
  if (!span.value) return null;
  const { start, end } = span.value;
  const length = zoom.value?.length;
  if (!length || length >= end - start) return { start, end };
  const viewEnd = Math.min(end, Math.max(start + length, zoom.value.end ?? end));
  return { start: viewEnd - length, end: viewEnd };
});
const zoomed = computed(() => zoom.value !== null);
const viewLength = () => view.value.end - view.value.start;
// Narrow or widen the view to `length`, keeping the handle where it is on it.
function zoomTo(length) {
  const { start, end } = span.value;
  const next = Math.max(MIN_VIEW_MS, length);
  if (next >= end - start) {
    zoom.value = null;
    return;
  }
  const { start: from, end: to } = view.value;
  const share = Math.min(1, Math.max(0, (at.value - from) / (to - from)));
  const viewStart = Math.max(start, at.value - share * next);
  const viewEnd = viewStart + next;
  zoom.value = { length: next, end: viewEnd >= end ? null : viewEnd };
}
const zoomBy = (factor) => zoomTo(viewLength() * factor);
// The view keeps the handle on it: playing or stepping off it, or left behind
// as now moves the view on, the view goes to the handle. The span narrowing to
// the zoom or less, or going, lets go of the zoom.
watch([at, view], ([ms, shownView]) => {
  if (!zoom.value) return;
  if (ms === null || zoom.value.length >= span.value.end - span.value.start) {
    zoom.value = null;
    return;
  }
  if (ms >= shownView.start && ms <= shownView.end) return;
  const length = zoom.value.length;
  const viewEnd = ms + length / 2;
  zoom.value = { length, end: viewEnd >= span.value.end ? null : viewEnd };
});
// A wheel's lines and pages, in pixels.
const WHEEL_UNITS = [1, 16, 400];
const onWheel = (event) => {
  // A sideways swipe is not a zoom.
  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
  event.preventDefault();
  const pixels = event.deltaY * (WHEEL_UNITS[event.deltaMode] ?? 1);
  zoomBy(Math.exp(pixels * WHEEL_ZOOM));
};
// The input takes a press before it can tell a double-click or a pinch, so
// both put the time back where it was before their first touch.
let before = null;
let pressedAt = -Infinity;
const onPress = (event) => {
  if (event.timeStamp - pressedAt > DOUBLE_PRESS_MS)
    before = { live: time.value.live, timeMs: time.value.timeMs };
  pressedAt = event.timeStamp;
};
const restore = () => {
  if (!before) return;
  if (before.live) store.goLive();
  else store.scrub(before.timeMs, 0);
};
const showAll = () => {
  restore();
  zoom.value = null;
};
// Two fingers on the track pinch it, and the first finger stops scrubbing.
let pinch = null;
const spread = (touches) =>
  Math.hypot(
    touches[0].clientX - touches[1].clientX,
    touches[0].clientY - touches[1].clientY,
  );
const onTouchStart = (event) => {
  if (event.touches.length === 1) onPress(event);
  if (event.touches.length !== 2) return;
  restore();
  pinch = { spread: spread(event.touches), length: viewLength() };
};
const onTouchMove = (event) => {
  if (!pinch || event.touches.length !== 2) return;
  event.preventDefault();
  const now = spread(event.touches);
  if (now > 0) zoomTo((pinch.length * pinch.spread) / now);
};
const onTouchEnd = (event) => {
  if (event.touches.length === 0) pinch = null;
};

const place = (ms) => {
  const { start, end } = view.value;
  return end > start ? ((ms - start) / (end - start)) * 100 : 100;
};
const ticks = computed(() => {
  const { start, end } = view.value;
  return span.value.marks
    .filter((mark) => mark >= start && mark <= end)
    .map((mark) => `${place(mark)}%`);
});
const shown = computed(() =>
  Math.min(view.value.end, Math.max(view.value.start, at.value)),
);
const scrub = (event) => {
  // A pinch only zooms; the input goes back to the handle.
  if (pinch) {
    event.target.value = shown.value;
    return;
  }
  store.scrub(Number(event.target.value), viewLength());
};
// Arrows go to the previous or next mark (a launch, a frame), or a step along
// the track as shown; Page keys take a tenth of it; Home and End go to the
// ends of all of it. Plus and minus zoom, and zero shows it all; with a
// modifier they are the browser's own zoom.
const ZOOM_KEYS = ['+', '=', '-', '0'];
const onKey = (event) => {
  if (ZOOM_KEYS.includes(event.key)) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    if (event.key === '-') zoomBy(ZOOM_STEP);
    else if (event.key === '0') zoom.value = null;
    else zoomBy(1 / ZOOM_STEP);
    return;
  }
  const { start, end, marks } = span.value;
  const now = at.value;
  const length = viewLength();
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
  store.scrub(Math.min(end, Math.max(start, to)), length);
};
</script>

<template>
  <div v-if="time.supported && time.span" id="world-timeline" role="group" :aria-label="t('World time')"
    ><UiButton class="world-timeline-play" :label="time.playing ? t('Pause') : t('Play')" @click="store.togglePlay()"
      ><UiIcon :name="time.playing ? 'pause' : 'play_arrow'" :size="20" /></UiButton
    ><UiSelect class="gev-field gev-field--compact world-timeline-speed" :aria-label="t('Play speed')" :title="t('Play speed')" :options="speeds" :model-value="speed" @update:model-value="store.setSpeed($event)"
    /><div class="world-timeline-track" :class="{ 'is-zoomed': zoomed }" :title="t('Scroll or pinch to zoom · double-click to see it all')" @wheel="onWheel" @mousedown="onPress" @dblclick="showAll" @touchstart="onTouchStart" @touchmove="onTouchMove" @touchend="onTouchEnd" @touchcancel="onTouchEnd"
      ><time class="world-timeline-time" :class="{ 'is-buffering': time.buffering }" :style="{ '--at': place(shown) / 100 }" :datetime="new Date(time.timeMs).toISOString()" aria-live="off">{{ bubble }}</time
      ><span v-for="(left, index) in ticks" :key="index" class="world-timeline-tick" :style="{ left }" aria-hidden="true"></span
      ><span class="world-timeline-fill" :style="{ width: `${place(shown)}%` }" aria-hidden="true"></span
      ><input
        class="world-timeline-scrub"
        type="range"
        :aria-label="t('World time')"
        :aria-valuetext="readout"
        :min="view.start"
        :max="view.end"
        step="any"
        :value="shown"
        @input="scrub"
        aria-keyshortcuts="+ - 0"
        @keydown="onKey"
    /></div
    ><UiButton class="world-timeline-live" :label="time.live ? t('Live') : t('Back to live')" :pressed="time.live" pressed-class="is-live" :disabled="time.live" @click="store.goLive()">{{ t('Live') }}</UiButton
  ></div>
</template>
