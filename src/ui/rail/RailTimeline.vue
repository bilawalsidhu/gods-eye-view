<script setup>
import { computed, onBeforeUnmount, shallowRef, watch } from 'vue';
import { formatUtcDayMonth, t } from '../../i18n/index.js';
import { utcClock } from './utcClock.js';
import UiSlider from '../kit/UiSlider.js';

// Stable native transport with local preview and a coalesced 150 ms drag
// commit. While the handle is dragged the slider keeps the ticks it was
// dragged over; the owner's updates apply once the drag ends.
const props = defineProps({
  state: { type: Object, required: true },
  sliderClassName: { type: String, default: '' },
  heading: { type: Boolean, default: true },
  onCommit: { type: Function, default: () => {} },
  onPreview: { type: Function, default: () => {} },
  onStep: { type: Function, default: () => {} },
  onLatest: { type: Function, default: () => {} },
  onPlay: { type: Function, default: () => {} },
});

const utc = (tick) =>
  Number.isFinite(Date.parse(tick))
    ? `${formatUtcDayMonth(tick)} ${utcClock(tick)}`
    : '';

// What the slider shows: the owner's ticks, index and readout, frozen while
// dragging.
const shown = shallowRef({ ticks: [], index: 0, readout: '' });
let dragging = false;
let timer = null;
let pending = null;
let live = true;

const cancel = () => {
  if (timer !== null) clearTimeout(timer);
  timer = null;
};
const sync = () => {
  if (dragging) return;
  const ticks = [...props.state.ticks];
  shown.value = {
    ticks,
    index: Math.max(0, Math.min(props.state.index, ticks.length - 1)),
    readout: props.state.readout || '',
  };
};
watch(
  () => props.state,
  (state) => {
    if (state.disabled) {
      cancel();
      pending = null;
      dragging = false;
    }
    sync();
  },
  { immediate: true, flush: 'sync' },
);
onBeforeUnmount(() => {
  live = false;
  cancel();
});

const disabled = computed(() => Boolean(props.state.disabled));
const latestActive = computed(() => props.state.mode === 'latest');
const playing = computed(() => Boolean(props.state.playing));

function commit() {
  cancel();
  const value = pending;
  pending = null;
  if (live && value && !props.state.disabled)
    props.onCommit(value.tick, value.index);
}
function preview(event) {
  if (props.state.disabled) return;
  dragging = true;
  const index = Number(event.target.value);
  const tick = shown.value.ticks[index];
  if (!tick) return;
  pending = { tick, index };
  // Shown before the owner hears of it: an update from inside onPreview
  // must not move the handle back.
  shown.value = { ...shown.value, index };
  const readout = props.onPreview(tick, index);
  // The owner may have ended the drag (disabled) from inside onPreview.
  if (!dragging) return;
  if (typeof readout === 'string') shown.value = { ...shown.value, readout };
  if (timer === null) timer = setTimeout(commit, 150);
}
// The handle shows the shown index again. A drag that ends where it began
// (an input and a cancel, or a refused commit, before the next render)
// leaves the slider's model unchanged, so it would not render.
const place = (input) => {
  const index = String(shown.value.index);
  if (input && input.value !== index) input.value = index;
};
function change(event) {
  if (props.state.disabled) return;
  const index = Number(event.target.value);
  pending = { tick: shown.value.ticks[index], index };
  dragging = false;
  commit();
  sync();
  place(event.target);
}
function reset(event) {
  cancel();
  pending = null;
  dragging = false;
  sync();
  place(event?.target);
}
function blur(event) {
  if (dragging) change(event);
}
const act = (fn) => {
  reset();
  if (live && !props.state.disabled) fn();
};
</script>

<template>
  <section class="rail-timeline"
    ><div v-if="heading" class="panel-title">{{ t('Observed history') }}</div
    ><div class="rail-timeline-track"
      ><button
        type="button"
        class="data-toggle-chip"
        :title="t('Earlier observation')"
        :disabled="disabled || state.index <= 0"
        @click="act(() => onStep(-1))"
        >‹</button
      ><UiSlider
        :class="sliderClassName || undefined"
        min="0"
        :max="String(Math.max(0, shown.ticks.length - 1))"
        step="1"
        :model-value="String(shown.index)"
        :disabled="disabled"
        :aria-label="t('Observed history')"
        :aria-valuetext="utc(shown.ticks[shown.index])"
        @input="preview"
        @change="change"
        @pointercancel="reset"
        @blur="blur"
      /><button
        type="button"
        class="data-toggle-chip"
        :title="t('Later observation')"
        :disabled="disabled || state.index >= state.ticks.length - 1"
        @click="act(() => onStep(1))"
        >›</button
      ><div class="rail-timeline-endpoints"
        ><span>{{ utcClock(shown.ticks[0]) }}</span
        ><span>{{ utcClock(shown.ticks.at(-1)) }}</span></div
      ></div
    ><div class="rail-timeline-controls"
      ><button
        type="button"
        :class="`data-toggle-chip${latestActive ? ' active' : ''}`"
        :title="t('Newest frame per product')"
        :disabled="disabled"
        :aria-pressed="String(latestActive)"
        @click="act(onLatest)"
        >{{ t('Latest') }}</button
      ><button
        type="button"
        :class="`data-toggle-chip${playing ? ' active' : ''}`"
        :title="t('Replay observed history')"
        :disabled="disabled"
        :aria-pressed="String(playing)"
        @click="act(onPlay)"
        >{{ playing ? t('Pause') : t('Play') }}</button
      ><span class="rail-timeline-readout">{{ shown.readout }}</span></div
    ></section
  >
</template>
