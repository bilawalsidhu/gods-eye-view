<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { cardMapLayout, cardMapTheme, drawCardMap } from '../../cardMap.js';
import { getLocale, onLocaleChange } from '../../../i18n/index.js';

// A card's map on one canvas, drawn from OpenFreeMap's vector tiles in the
// card map's style (cardMap.js): paint each tile as it loads, then its
// names in the current view and language. Without a frame it is the 3 by 3
// block of tiles round the spot, placed from the spot (its parent centres
// it); with one, a canvas centred on the spot, sized by its parent's rules
// (the frame is its size until it has one). Taken down, it stops its
// requests and frees its canvas. A lazy one (a pin in a scrolling grid)
// reads its tiles only once it scrolls into view, and stops a drawing
// still loading when it leaves.
const props = defineProps({
  lat: { type: Number, required: true },
  lon: { type: Number, required: true },
  zoom: { type: Number, required: true },
  /** `{width, height}` in CSS pixels, or none for the block of tiles. */
  frame: { type: Object, default: null },
  active: { type: Boolean, default: true },
  /** Draw only while the canvas is in view. */
  lazy: { type: Boolean, default: false },
  /**
   * For the block: what of it shows, `{width, height, clearTop, clearBottom}` in CSS
   * pixels round the spot (a strip `clearBottom` high at the foot kept free
   * of names), read when it draws; null while unknown.
   */
  measure: { type: Function, default: null },
  /** The viewport and caption to observe when the canvas covers a tile block. */
  resizeTargets: { type: Array, default: null },
  /** For a frame: a strip this high at its foot kept free of names. */
  clearBottom: { type: Number, default: 0 },
});
const emit = defineEmits(['state', 'entered']);

// A block shown in a hero of unknown size keeps its names within a 16:9
// view round the spot.
const UNMEASURED = Object.freeze({ width: 400, height: 225, clearBottom: 56 });

const canvas = ref(null);
const state = ref('loading');
let drawing = null;
let drawnOptions = '';
let observer = null;
let viewObserver = null;
let settling = 0;
// A resize redraws only once the size has held this long.
const RESIZE_SETTLE_MS = 200;
let inView = true;
let offLocale = null;
let mounted = false;
let alive = true;

// Where the block sits round the spot. It moves with the pixels it is for:
// only once a drawing's frame is on the canvas, so a frame kept through a
// redraw, or after one fails, stays aligned with the marker.
const placeOf = (lat, lon, zoom) => {
  const { left, top, width, height } = cardMapLayout(lat, lon, zoom);
  return { width: `${width}px`, height: `${height}px`, transform: `translate(${left}px, ${top}px)` };
};
const placement = ref(placeOf(props.lat, props.lon, props.zoom));
const placed = computed(() => (props.frame ? undefined : placement.value));

function where() {
  // A frame is drawn at its own fixed size and scaled by CSS, so resizing
  // the panel never redraws it.
  if (props.frame) return { frame: props.frame, view: null, clearBottom: props.clearBottom };
  const raw = props.measure?.();
  // Whole pixels: a sub-pixel change in layout is no reason to redraw.
  const measured = raw && {
    width: Math.round(raw.width),
    height: Math.round(raw.height),
    clearTop: Math.round(raw.clearTop ?? 0),
    clearBottom: Math.round(raw.clearBottom ?? 0),
  };
  const shown = measured?.width > 0 && measured?.height > 0 ? measured : UNMEASURED;
  const clearTop = Math.min(shown.height, Math.max(0, shown.clearTop ?? 0));
  return {
    frame: null,
    view: { left: -shown.width / 2, top: clearTop - shown.height / 2, width: shown.width, height: shown.height - clearTop },
    clearBottom: shown.clearBottom ?? 0,
  };
}

// Drop a drawing that has not finished, so the next draw starts afresh.
function stopLoading() {
  if (state.value === 'ready' || !drawing) return;
  drawing.destroy();
  drawing = null;
  drawnOptions = '';
}

function draw() {
  if (!canvas.value || !mounted || !props.active || !inView) return;
  const options = {
    lat: props.lat,
    lon: props.lon,
    zoom: props.zoom,
    locale: getLocale(),
    theme: cardMapTheme.value,
    ...where(),
  };
  // Observing the frame can report its first size and the same size again
  // after a redraw. Keep the current paint when the inputs still match.
  const key = JSON.stringify(options);
  if (key === drawnOptions) return;
  drawnOptions = key;
  drawing?.destroy();
  const next = placeOf(options.lat, options.lon, options.zoom);
  drawing = drawCardMap(canvas.value, {
    ...options,
    onFrame: () => {
      placement.value = next;
    },
    onState: (next) => {
      // A failed map is drawn again the next time it is asked for.
      if (next === 'failed') drawnOptions = '';
      state.value = next;
      emit('state', next);
    },
  });
}

// Resizes come in bursts (an animated panel, a drag): redraw once they settle.
function drawSoon() {
  clearTimeout(settling);
  settling = setTimeout(() => {
    settling = 0;
    draw();
  }, RESIZE_SETTLE_MS);
}

// Observe the real viewport and caption of a tile block. A framed pin is
// drawn at its fixed frame and needs no observing.
onMounted(async () => {
  await nextTick();
  if (!alive) return;
  mounted = true;
  if (props.lazy && typeof IntersectionObserver === 'function') {
    inView = false;
    viewObserver = new IntersectionObserver((entries) => {
      inView = entries.some((entry) => entry.isIntersecting);
      if (inView) draw();
      else stopLoading();
    });
    viewObserver.observe(canvas.value);
  }
  offLocale = onLocaleChange(() => void nextTick(draw));
  if (props.frame) {
    // Fixed size: nothing to observe.
  } else if (typeof ResizeObserver === 'function') {
    observer = new ResizeObserver(drawSoon);
    for (const target of props.resizeTargets ?? [canvas.value])
      if (target) observer.observe(target);
  } else globalThis.window?.addEventListener('resize', drawSoon);
  draw();
});
watch(
  () => [
    props.active, props.lat, props.lon, props.zoom,
    props.frame?.width, props.frame?.height, props.clearBottom, cardMapTheme.value,
  ],
  ([active], [wasActive]) => {
    if (!active) stopLoading();
    draw();
    // A return to a kept map starts with its current drawing state.
    if (active && !wasActive) emit('entered', state.value);
  },
  { flush: 'post' },
);
onBeforeUnmount(() => {
  alive = false;
  mounted = false;
  observer?.disconnect();
  viewObserver?.disconnect();
  clearTimeout(settling);
  settling = 0;
  offLocale?.();
  globalThis.window?.removeEventListener('resize', drawSoon);
  drawing?.destroy();
  drawing = null;
  if (canvas.value) canvas.value.width = canvas.value.height = 0;
});
</script>

<template>
  <canvas ref="canvas" class="card-map" :data-state="state" :style="placed" aria-hidden="true"></canvas>
</template>
