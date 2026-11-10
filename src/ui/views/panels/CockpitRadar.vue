<script setup>
import { storeToRefs } from 'pinia';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { formatNumber, t, tn } from '../../../i18n/index.js';
import { useCockpitStore } from '../../stores/cockpit.js';

// The bridge radar: a heading-up scope of nearby AIS vessels, with a line
// where the bridge view looks when it is turned off the bow. The Cockpit
// controller presents them as positions on the range circle and keeps the
// range button's listener; this view draws them. The sweep and each
// contact's afterglow are compositor animations sharing one clock, so a
// contact brightens as the sweep crosses its bearing without a frame loop.

/** One sweep turn, in milliseconds. */
const SWEEP_MS = 4000;
/** Relative bearings of the rim ticks. */
const RIM_TICKS = Array.from({ length: 12 }, (_, index) => index * 30);
const SWEEP_FRAMES = [
  { transform: 'rotate(0turn)' },
  { transform: 'rotate(1turn)' },
];
const GLOW_FRAMES = [
  { opacity: 1, offset: 0 },
  { opacity: 0.6, offset: 0.2 },
  { opacity: 0.25, offset: 1 },
];

const { radar, instruments } = storeToRefs(useCockpitStore());

// The bridge view's look line: the yaw the view is turned to off the bow,
// kept unwrapped so its turn eases the short way across astern. Unwrapping
// needs the last angle shown, so it is state a watch keeps, not a computed.
const lookDeg = ref(null);
watch(
  () => {
    const look = instruments.value?.look;
    return look?.offset && look.yawDeg !== 0 ? look.yawDeg : null;
  },
  (yawDeg) => {
    if (yawDeg === null) {
      lookDeg.value = null;
      return;
    }
    const from = lookDeg.value ?? 0;
    lookDeg.value = from + ((((yawDeg - from) % 360) + 540) % 360) - 180;
  },
  { immediate: true },
);

const motionQuery =
  typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;
const reducedMotion = ref(Boolean(motionQuery?.matches));
const onMotionChange = (event) => {
  reducedMotion.value = event.matches;
};
motionQuery?.addEventListener?.('change', onMotionChange);
onBeforeUnmount(() =>
  motionQuery?.removeEventListener?.('change', onMotionChange),
);

/**
 * Run an element's sweep-phased animation, or stop it (`phaseMs` null).
 * Each animation starts on the document timeline at its phase, so every
 * one keeps time with the sweep however late it was created.
 */
function phase(el, frames, phaseMs) {
  if (phaseMs === null || typeof el.animate !== 'function') {
    el._radarAnimation?.cancel();
    el._radarAnimation = null;
    return;
  }
  if (!el._radarAnimation) {
    el._radarAnimation = el.animate(frames, {
      duration: SWEEP_MS,
      iterations: Infinity,
      easing: 'linear',
    });
    // Cancelling on unmount rejects `finished`; nothing waits on it.
    el._radarAnimation.finished?.catch(() => {});
  }
  // Before zero, so the animation is already running at page start.
  const startTime = phaseMs - SWEEP_MS;
  if (el._radarAnimation.startTime !== startTime)
    el._radarAnimation.startTime = startTime;
}

const vSweep = {
  mounted: (el) => phase(el, SWEEP_FRAMES, 0),
  unmounted: (el) => phase(el, SWEEP_FRAMES, null),
};

const vAfterglow = {
  mounted: (el, { value }) => phase(el, GLOW_FRAMES, value),
  updated: (el, { value }) => phase(el, GLOW_FRAMES, value),
  unmounted: (el) => phase(el, GLOW_FRAMES, null),
};

/** When in the sweep's turn a bearing is crossed, or null when steady. */
function glowPhase(relativeBearingDeg) {
  if (reducedMotion.value) return null;
  const clockwise = (((relativeBearingDeg % 360) + 360) % 360) / 360;
  return Math.round(clockwise * SWEEP_MS);
}

const percent = (fraction) => `${(fraction * 100).toFixed(2)}%`;
const contactStyle = (contact) => ({
  left: percent(0.5 + contact.x / 2),
  top: percent(0.5 - contact.y / 2),
  '--radar-contact-color': contact.color || undefined,
});
const rotate = (deg) => ({ transform: `rotate(${deg}deg)` });

const rangeLabel = computed(() => radar.value?.rangeLabel ?? '');
const ringFractions = computed(() =>
  radar.value
    ? radar.value.ringsNm.map((ring) => ring / radar.value.rangeNm)
    : [],
);
const ringLabel = computed(() =>
  radar.value?.ringsNm.length
    ? t('RINGS {spacing} NM', {
        spacing: formatNumber(radar.value.ringsNm[0]),
      })
    : '',
);
const countLabel = computed(() => {
  const count = radar.value?.contacts.length ?? 0;
  return tn(count, '{count} CONTACT', '{count} CONTACTS', {
    count: formatNumber(count),
  });
});
const rangeAction = computed(() =>
  t('Radar range {range}. Select for the next range.', {
    range: rangeLabel.value,
  }),
);
</script>

<template>
  <section id="cockpit-radar" class="cockpit-radar" :aria-label="t('Bridge radar')" :hidden="!radar">
    <div class="cockpit-radar-scope" aria-hidden="true">
      <template v-if="radar">
        <span v-for="fraction in ringFractions" :key="fraction" class="cockpit-radar-ring" :style="{ width: percent(fraction), height: percent(fraction) }"></span>
        <span v-for="tick in RIM_TICKS" :key="tick" class="cockpit-radar-tick" :class="{ 'cockpit-radar-tick-major': tick % 90 === 0 }" :style="rotate(tick)"></span>
        <span v-if="!reducedMotion" v-sweep class="cockpit-radar-sweep"></span>
        <span class="cockpit-radar-heading-line"></span>
        <span v-if="lookDeg !== null" class="cockpit-radar-look" :style="rotate(lookDeg)"></span>
        <span v-for="contact in radar.contacts" :key="contact.id" v-afterglow="glowPhase(contact.relativeBearingDeg)" class="cockpit-radar-contact" :class="{ 'cockpit-radar-contact-stale': contact.stale }" :style="contactStyle(contact)">
          <span v-if="contact.relativeCourseDeg !== null" class="cockpit-radar-vector" :style="rotate(contact.relativeCourseDeg)"></span>
        </span>
        <span class="cockpit-radar-own">
          <span v-if="radar.ownRelativeCourseDeg !== null && radar.ownRelativeCourseDeg !== undefined" class="cockpit-radar-vector cockpit-radar-own-vector" :style="rotate(radar.ownRelativeCourseDeg)"></span>
        </span>
      </template>
    </div>
    <div class="cockpit-radar-readout">
      <button id="cockpit-radar-range" type="button" class="cockpit-radar-range" :aria-label="rangeAction" :title="rangeAction">{{ rangeLabel }}</button>
      <span class="cockpit-radar-rings">{{ ringLabel }}</span>
      <span class="cockpit-radar-count">{{ countLabel }}</span>
    </div>
  </section>
</template>
