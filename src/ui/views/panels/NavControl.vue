<script setup>
import { storeToRefs } from 'pinia';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { msg, t } from '../../../i18n/index.js';
import { TILT_SPAN_DEG } from '../../navControl/navMath.js';
import { useNavControlStore } from '../../stores/navControl.js';
import UiSlider from '../../kit/UiSlider.js';
import NavControlButton from './NavControlButton.vue';

// The on-screen map navigation control, at the bottom right: a compass ring
// that shows and drags the heading, a north-up button, a tilt slider with
// up/down and top-down buttons, zoom in/out and a look-around pad. It renders
// the heading, tilt and follow state the navigation owner publishes and sends
// every press, drag and key back through the store; the owner decides what
// the camera does (src/ui/navControl/navControl.js).
const nav = useNavControlStore();
const { view } = storeToRefs(nav);
const dial = ref(null);

const heading = computed(() => view.value?.heading ?? 0);
const resetLabel = computed(() =>
  t('Reset map to north up. Current heading {heading} degrees', {
    heading: heading.value,
  }),
);
const headingText = computed(() =>
  heading.value === 0
    ? t('North, 0 degrees')
    : t('{heading} degrees from north', { heading: heading.value }),
);

const LABELS = {
  'zoom-in': msg('Zoom in'),
  'zoom-out': msg('Zoom out'),
  'tilt-up': msg('Tilt up toward the horizon'),
  'tilt-down': msg('Tilt down toward top-down view'),
  'top-down': msg('Top-down view'),
  'look-left': msg('Look left'),
  'look-right': msg('Look right'),
  'look-up': msg('Look up'),
  'look-down': msg('Look down'),
};

// Button faces that are symbols or the TOP mark, not sentences; each button's
// accessible name is the translated label above.
const GLYPHS = { minus: '\u2212', top: 'TOP' };
const label = (action) => t(LABELS[action]);

// ── compass ring: drag to rotate, arrows turn, Home is north ──────────────
function ringDown(event) {
  if (event.button > 0) return;
  const rect = dial.value?.getBoundingClientRect?.();
  if (!rect?.width) return;
  const started = nav.act('ringStart', {
    centerX: rect.left + rect.width / 2,
    centerY: rect.top + rect.height / 2,
    clientX: event.clientX,
    clientY: event.clientY,
  });
  if (!started) return;
  try {
    dial.value.setPointerCapture?.(event.pointerId);
  } catch {
    /* synthetic pointer */
  }
}
const ringMove = (event) =>
  nav.act('ringMove', { clientX: event.clientX, clientY: event.clientY });
const ringEnd = () => nav.act('ringEnd');
function ringKey(event) {
  if (nav.act('ringKey', event.key)) event.preventDefault?.();
}

// A press held while the window loses focus would never see its release.
const release = () => nav.act('release');
onMounted(() => window.addEventListener('blur', release));
onBeforeUnmount(() => window.removeEventListener('blur', release));
</script>

<template>
  <Teleport to="body">
    <section
      v-if="view"
      id="gev-nav-control"
      class="gev-nav"
      data-gev-nav-control=""
      role="group"
      :aria-label="t('Map navigation')"
      :data-north-up="String(heading === 0)"
      :data-following="String(view.following)"
      :data-dragging="view.dragging ? 'ring' : undefined"
      :style="{ '--gev-nav-heading': `${heading}deg` }"
    >
      <div class="gev-nav-tilt">
        <NavControlButton action="tilt-up" class="gev-nav-btn gev-nav-tilt-up" :label="label('tilt-up')">&#x25B2;</NavControlButton>
        <UiSlider
          hold
          class="gev-nav-slider"
          data-nav="tilt-slider"
          :min="0"
          :max="TILT_SPAN_DEG"
          :step="1"
          :model-value="view.tilt"
          aria-orientation="vertical"
          :aria-label="t('Tilt')"
          :aria-valuetext="t('{tilt} degrees from top-down', { tilt: view.tilt })"
          :title="t('Tilt: top-down (bottom) to near horizon (top)')"
          @update:model-value="nav.act('sliderInput', $event)"
          @pointerdown="nav.act('sliderStart')"
          @pointerup="nav.act('sliderEnd')"
          @pointercancel="nav.act('sliderEnd')"
          @blur="nav.act('sliderEnd')"
        />
        <NavControlButton action="tilt-down" class="gev-nav-btn gev-nav-tilt-down" :label="label('tilt-down')">&#x25BC;</NavControlButton>
      </div>

      <div class="gev-nav-compass">
        <div
          ref="dial"
          class="gev-nav-dial"
          data-nav="ring"
          role="slider"
          tabindex="0"
          :aria-label="t('Map heading. Drag to rotate, arrow keys turn, Home for north')"
          aria-valuemin="0"
          aria-valuemax="359"
          :aria-valuenow="heading"
          :aria-valuetext="headingText"
          @pointerdown="ringDown"
          @pointermove="ringMove"
          @pointerup="ringEnd"
          @pointercancel="ringEnd"
          @lostpointercapture="ringEnd"
          @keydown="ringKey"
        >
          <span class="gev-nav-dial-mark" aria-hidden="true"></span>
        </div>
        <div class="gev-nav-look" role="group" :aria-label="t('Look around')">
          <NavControlButton action="look-up" class="gev-nav-btn gev-nav-look-up" :label="label('look-up')" :disabled="view.following">&#x25B2;</NavControlButton>
          <NavControlButton action="look-left" class="gev-nav-btn gev-nav-look-left" :label="label('look-left')" :disabled="view.following">&#x25C0;</NavControlButton>
          <NavControlButton action="look-right" class="gev-nav-btn gev-nav-look-right" :label="label('look-right')" :disabled="view.following">&#x25B6;</NavControlButton>
          <NavControlButton action="look-down" class="gev-nav-btn gev-nav-look-down" :label="label('look-down')" :disabled="view.following">&#x25BC;</NavControlButton>
        </div>
        <NavControlButton action="north" class="gev-nav-btn gev-nav-north" :label="resetLabel" :title="t('North up')">N</NavControlButton>
      </div>

      <div class="gev-nav-zoom">
        <NavControlButton action="zoom-in" class="gev-nav-btn gev-nav-zoom-in" :label="label('zoom-in')">+</NavControlButton>
        <NavControlButton action="zoom-out" class="gev-nav-btn gev-nav-zoom-out" :label="label('zoom-out')">{{ GLYPHS.minus }}</NavControlButton>
        <NavControlButton action="top-down" class="gev-nav-btn gev-nav-top-down" :label="label('top-down')">{{ GLYPHS.top }}</NavControlButton>
      </div>
    </section>
  </Teleport>
</template>
