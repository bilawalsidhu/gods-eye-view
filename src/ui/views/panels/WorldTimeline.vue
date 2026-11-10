<script setup>
import { computed, onBeforeUnmount, shallowRef, watch } from 'vue';
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
// zooms it around the handle, dragging it moves along it, and a double-click
// shows it all again. It shows
// while a layer with a time of its own (weather, satellites, launches,
// or one a host follows) is on with time to show; with only live feeds such
// as flights on, the bar stays hidden.
const store = useWorldTimeStore();
const { time, speed } = storeToRefs(store);
const speeds = computed(() => [
  { value: 'real', label: '1×' },
  { value: 'minute', label: t('1 min/s') },
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
// Play held while a layer loads the time's data shows a spinner by the time,
// once the hold lasts long enough to notice, so a quick frame does not flash
// it, and until play has run a while, so a run of slow frames keeps it still.
const WAIT_SHOWN_MS = 300;
const WAIT_HIDDEN_MS = 500;
const waiting = shallowRef(false);
let waitTimer = null;
watch(
  () => time.value.buffering,
  (buffering) => {
    clearTimeout(waitTimer);
    waitTimer = null;
    if (buffering === waiting.value) return;
    waitTimer = setTimeout(
      () => {
        waitTimer = null;
        waiting.value = buffering;
      },
      buffering ? WAIT_SHOWN_MS : WAIT_HIDDEN_MS,
    );
  },
);
onBeforeUnmount(() => clearTimeout(waitTimer));
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
// Show `length` of the span ending at `viewEnd`, held to the span.
function showView(length, viewEnd) {
  const { start, end } = span.value;
  if (length >= end - start) {
    showWhole();
    return;
  }
  const clamped = Math.min(end, Math.max(start + length, viewEnd));
  zoom.value = { length, end: clamped >= end ? null : clamped };
}
// Narrow or widen the view to `length`, keeping the handle where it is on it,
// or with the handle off it, the middle.
function zoomTo(length) {
  const { start: from, end: to } = view.value;
  const pivot = offView(at.value) ? (from + to) / 2 : at.value;
  const share = (pivot - from) / (to - from);
  const next = Math.max(MIN_VIEW_MS, length);
  showView(next, pivot + (1 - share) * next);
}
const zoomBy = (factor) => zoomTo(viewLength() * factor);
// A view dragged off the handle stays where it was put while the handle only
// creeps on with now; playing or a move of the handle takes it back.
let panned = false;
const follow = (ms) => {
  panned = false;
  showView(zoom.value.length, ms + zoom.value.length / 2);
};
const offView = (ms) => ms < view.value.start || ms > view.value.end;
const showWhole = () => {
  zoom.value = null;
  panned = false;
};
// The span narrowing to the zoom or less, or going, lets go of the zoom.
watch(span, (next) => {
  if (zoom.value && (!next || zoom.value.length >= next.end - next.start))
    showWhole();
});
watch(at, (ms) => {
  if (!zoom.value || ms === null || !offView(ms)) return;
  if (panned && time.value.live && !time.value.playing) return;
  follow(ms);
});
// Left behind as now moves the view on, the handle takes the view back.
watch(view, () => {
  if (zoom.value && !panned && at.value !== null && offView(at.value))
    follow(at.value);
});
const pan = (ms) => {
  panned = true;
  showView(zoom.value.length, view.value.end + ms);
};
// A wheel's lines and pages, in pixels.
const WHEEL_UNITS = [1, 16, 400];
const onWheel = (event) => {
  const unit = WHEEL_UNITS[event.deltaMode] ?? 1;
  const sideways = Math.abs(event.deltaX) > Math.abs(event.deltaY);
  // A sideways swipe, or a wheel with shift, drags; a wheel zooms.
  if (sideways || event.shiftKey) {
    if (!zoom.value) return;
    event.preventDefault();
    const width = event.currentTarget.clientWidth;
    const pixels = (sideways ? event.deltaX : event.deltaY) * unit;
    if (width > 0) pan((pixels / width) * viewLength());
    return;
  }
  event.preventDefault();
  zoomBy(Math.exp(event.deltaY * unit * WHEEL_ZOOM));
};
// A double-click starts with presses that move the time, so it puts back the
// time from before its first; so does a pinch, which may start on the handle.
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
  showWhole();
};

// The handle drags the time. The rest of the track takes the pointer: a tap
// goes to the time under it, a drag drags a zoomed track along (or the time,
// with all of it shown), and two fingers pinch it.
const DRAG_PX = 4;
const pointers = new Map();
let gesture = null;
const timeAt = (clientX, track) => {
  const { left, width } = track.getBoundingClientRect();
  const share = width > 0 ? Math.min(1, Math.max(0, (clientX - left) / width)) : 1;
  return view.value.start + share * viewLength();
};
// Whether the first finger has moved the time, for a pinch to put it back.
let movedTime = false;
const onPointerDown = (event) => {
  // Only the main button: a right-click is for the menu.
  if (event.button > 0) return;
  const onHandle = event.target instanceof HTMLInputElement;
  pointers.set(event.pointerId, { x: event.clientX, onHandle });
  if (pointers.size === 1) {
    onPress(event);
    movedTime = onHandle;
    // The keys zoom and step the track as soon as it is touched.
    if (!onHandle)
      event.currentTarget.querySelector('input')?.focus({ preventScroll: true });
  }
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    if (movedTime) restore();
    gesture = {
      kind: 'pinch',
      spread: Math.abs(a.x - b.x),
      length: viewLength(),
    };
    return;
  }
  if (onHandle || pointers.size !== 1) return;
  // The drag goes on past the track's ends; without the capture, to them.
  try {
    event.currentTarget.setPointerCapture?.(event.pointerId);
  } catch {
    // A pointer the page no longer knows of drags no further than the track.
  }
  gesture = { kind: 'press', x: event.clientX, end: view.value.end };
};
const onPointerMove = (event) => {
  const pointer = pointers.get(event.pointerId);
  if (!pointer) return;
  pointer.x = event.clientX;
  if (!gesture) return;
  const track = event.currentTarget;
  if (gesture.kind === 'pinch') {
    const [a, b] = [...pointers.values()];
    const spreadNow = Math.abs(a.x - b.x);
    if (spreadNow > 0) zoomTo((gesture.length * gesture.spread) / spreadNow);
    return;
  }
  if (gesture.kind === 'press') {
    if (Math.abs(event.clientX - gesture.x) < DRAG_PX) return;
    gesture.kind = zoom.value ? 'pan' : 'scrub';
    movedTime = gesture.kind === 'scrub';
  }
  if (gesture.kind === 'pan') {
    if (!track.clientWidth) return;
    panned = true;
    const moved = ((gesture.x - event.clientX) / track.clientWidth) * viewLength();
    showView(zoom.value.length, gesture.end + moved);
  } else store.scrub(timeAt(event.clientX, track), viewLength());
};
const onPointerUp = (event) => {
  if (!pointers.delete(event.pointerId)) return;
  if (gesture?.kind === 'press' && event.type === 'pointerup')
    store.scrub(timeAt(event.clientX, event.currentTarget), viewLength());
  // A finger lifted from a pinch ends it; the other one moves nothing.
  gesture = null;
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
const handleOff = computed(() => at.value !== shown.value);
const scrub = (event) => {
  // A pinch only zooms; the input goes back to the handle.
  if (gesture?.kind === 'pinch') {
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
    else if (event.key === '0') showWhole();
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
    /><div class="world-timeline-track" :class="{ 'is-zoomed': zoomed }" :title="t('Scroll or pinch to zoom, drag to move along · double-click to see it all')" @wheel="onWheel" @dblclick="showAll" @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerUp" @pointercancel="onPointerUp"
      ><time class="world-timeline-time" :class="{ 'is-waiting': waiting }" :style="{ '--at': place(shown) / 100 }" :datetime="new Date(time.timeMs).toISOString()" aria-live="off"
        ><span v-if="waiting" class="world-timeline-spinner" aria-hidden="true"></span>{{ bubble }}</time
      ><span v-for="(left, index) in ticks" :key="index" class="world-timeline-tick" :style="{ left }" aria-hidden="true"></span
      ><span class="world-timeline-fill" :style="{ width: `${place(shown)}%` }" aria-hidden="true"></span
      ><input
        class="world-timeline-scrub"
        :class="{ 'is-off-view': handleOff }"
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
