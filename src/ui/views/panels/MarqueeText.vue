<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { getLocale } from '../../../i18n/index.js';

// A name on one line that, cut off, scrolls slowly to show the rest: it
// waits at the start, moves across, waits at the end and comes back, and
// so on. A CSS animation does the moving (entity-card.css), driven by the
// distance and time measured here, so nothing runs per frame and a hidden
// one costs nothing. It fades at its edges, pauses while its card is
// hovered or holds focus, scrolls the other way right to left, and with
// reduced motion keeps the ellipsis. Measured again when the text changes
// or the box resizes. Locale switches also update its direction.
const props = defineProps({
  text: { type: String, default: '' },
  /** Off where the holder carries its own tooltip. */
  titled: { type: Boolean, default: true },
});

/** Pixels a second, and the shortest round trip (so each end waits ~2 s). */
const SPEED = 30;
const MIN_SECONDS = 10;

const box = ref(null);
const moving = ref(false);
const vars = ref({});
let resize = null;
let motion = null;

const reduced = () => Boolean(motion?.matches);
function measure() {
  const el = box.value;
  if (!el) return;
  const distance = Math.ceil((el.scrollWidth || 0) - (el.clientWidth || 0));
  if (distance <= 1 || reduced()) {
    moving.value = false;
    vars.value = {};
    return;
  }
  const rtl = globalThis.getComputedStyle?.(el)?.direction === 'rtl';
  const seconds = Math.max(MIN_SECONDS, Math.round(((distance / SPEED) * 10) / 3));
  const next = { '--marquee-shift': `${rtl ? distance : -distance}px`, '--marquee-duration': `${seconds}s` };
  if (next['--marquee-shift'] !== vars.value['--marquee-shift'] || next['--marquee-duration'] !== vars.value['--marquee-duration']) vars.value = next;
  moving.value = true;
}

watch(getLocale, measure, { flush: 'post' });

// A new name starts again from the start, measured once it is in place.
watch(
  () => props.text,
  () => {
    moving.value = false;
    vars.value = {};
    void nextTick(measure);
  },
  { flush: 'post' },
);
onMounted(() => {
  motion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)') || null;
  motion?.addEventListener?.('change', measure);
  if (typeof ResizeObserver === 'function' && box.value) {
    resize = new ResizeObserver(() => measure());
    resize.observe(box.value);
  }
  measure();
});
onBeforeUnmount(() => {
  motion?.removeEventListener?.('change', measure);
  motion = null;
  resize?.disconnect();
  resize = null;
});
</script>

<template>
  <span ref="box" class="marquee" :class="{ 'is-moving': moving }" :style="vars" :title="titled ? text : undefined">
    <span class="marquee__text">{{ text }}</span>
  </span>
</template>
