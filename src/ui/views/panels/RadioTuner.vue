<script setup>
import { storeToRefs } from 'pinia';
import {
  computed,
  onBeforeUnmount,
  onMounted,
  shallowRef,
  useTemplateRef,
} from 'vue';
import { t } from '../../../i18n/index.js';
import { vClassToggle } from '../../rail/classToggle.js';
import { vRangeValue } from '../../rail/rangeValue.js';
import { buildRadioTunerTicks } from '../../radioTunerModel.js';
import { useRadioStore } from '../../stores/radio.js';

// The Radio panel's directory tuner. RadioControls owns the drag and
// publishes the band, the readouts, the slider and where the needle sits;
// until it does, the tuner shows its initial markup. The slider hands its
// pointer, key and value events to RadioControls through the store. The
// tick tape is laid out here against the dial's width. A hidden dial
// measures 0 wide, so the last real width is kept and no ticks are drawn
// before there is one: ticks laid out for no width would slide into place
// when the tuner appears.
const store = useRadioStore();
const { act } = store;
const { tuner } = storeToRefs(store);
const dial = useTemplateRef('dial');
const dialWidth = shallowRef(0);
let resizeObserver = null;
onMounted(() => {
  const measure = () => {
    const width = dial.value?.getBoundingClientRect().width ?? 0;
    if (width > 0) dialWidth.value = width;
  };
  measure();
  if (typeof ResizeObserver !== 'function') return;
  resizeObserver = new ResizeObserver(measure);
  resizeObserver.observe(dial.value);
});
onBeforeUnmount(() => resizeObserver?.disconnect());
const tape = computed(() =>
  tuner.value && dialWidth.value > 0
    ? buildRadioTunerTicks(
        tuner.value.coordinate,
        tuner.value.count,
        dialWidth.value,
      )
    : null,
);
// The drag class comes off only once the snapped needle has been laid out
// with transitions still off, so the needle cannot animate from where the
// drag let go.
const vTunerDragging = {
  mounted(el, { value }) {
    el.classList.toggle('is-dragging', Boolean(value));
  },
  updated(el, { value }) {
    if (!value && el.classList.contains('is-dragging'))
      void el.querySelector('.radio-tuner-needle')?.offsetLeft;
    el.classList.toggle('is-dragging', Boolean(value));
  },
};
</script>

<template>
<div id="radio-tuner" class="radio-tuner" :hidden="tuner ? !tuner.available : true" :style="tuner?.ratio == null ? null : { '--radio-tuner-ratio': String(tuner.ratio) }" v-class-toggle="{ 'is-static': tuner?.static }" v-tuner-dragging="tuner?.dragging">
  <div class="radio-tuner-header">
    <span id="radio-tuner-band-label">{{ tuner?.band ?? t('DIRECTORY BAND') }}</span>
    <output id="radio-tuner-value" for="radio-tuner-slider">{{ tuner?.value ?? t('DRAG TO TUNE') }}</output>
  </div>
  <div ref="dial" class="radio-tuner-dial">
    <div class="radio-tuner-scale" aria-hidden="true" :style="tape && { '--radio-tuner-tick-pitch': `${tape.pitchPx}px` }"><span v-for="(tick, index) in tape?.ticks ?? []" :key="index" class="radio-tuner-tick" :class="{ 'is-current': tick.current }" :style="{ left: `${tick.xPx}px` }" :data-station-index="tick.stationIndex">{{ tick.label }}</span></div>
    <div id="radio-tuner-needle" class="radio-tuner-needle" aria-hidden="true"></div>
    <input id="radio-tuner-slider" type="range" min="0" :max="tuner ? tuner.max : 0" step="1" value="0" v-range-value="tuner ? tuner.slot : 0"
      @pointerdown="act('tunerPointerDown', $event)" @pointermove="act('tunerPointerMove', $event)" @pointerup="act('tunerPointerUp', $event)" @pointercancel="act('tunerPointerCancel', $event)" @lostpointercapture="act('tunerLostPointerCapture', $event)"
      @keydown="act('tunerKeyDown', $event)" @keyup="act('tunerKeyUp', $event)" @input="act('tunerInput')" @change="act('tunerChange')" @blur="act('tunerBlur')"
      :aria-label="t('Tune available internet radio stations')" :aria-valuetext="tuner?.valuetext ?? t('No station available')" :disabled="tuner ? !tuner.available : true" />
  </div>
  <div class="radio-tuner-readout">
    <span id="radio-tuner-station">{{ tuner?.station ?? t('ALL · DRAG THE NEEDLE') }}</span>
    <span>{{ t('SNAPS TO AVAILABLE STATIONS') }}</span>
  </div>
</div>
</template>
