<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { msg, t } from '../../../i18n/index.js';
import { useEntityCardStore } from '../../stores/entityCard.js';

// A flight's route on a small globe of its own at the top of its card: the
// great circle from origin to destination, solid where it has flown and
// dashed ahead, the two airports marked with their codes, and a plane where
// the craft is now, pointing at the destination. The renderer draws it (the
// `cardPreviews` hook); this tile lays the compass over it. The card names
// the airports' cities under its progress bar.
const props = defineProps({
  /** `{code, lat, lon}` of the origin airport. */
  from: { type: Object, required: true },
  /** `{code, lat, lon}` of the destination airport. */
  to: { type: Object, required: true },
  /** The craft's position now. */
  at: { type: Object, default: null },
  shown: { type: Boolean, default: true },
  /** Whether the visible tile is playing. */
  active: { type: Boolean, default: true },
});
const emit = defineEmits(['failed', 'ready']);
const store = useEntityCardStore();

const host = ref(null);
const failed = ref(false);
let preview = null;
// A globe that cannot draw tells the card, which then shows another view.
watch(failed, (now) => {
  if (!now) return;
  preview?.destroy();
  preview = null;
  emit('failed');
});

const place = (p) => ({ code: p?.code || '', lat: Number(p?.lat), lon: Number(p?.lon) });
const at = () =>
  props.at && Number.isFinite(props.at.lat) && Number.isFinite(props.at.lon) ? { lat: props.at.lat, lon: props.at.lon } : null;
const route = () => ({ from: place(props.from), to: place(props.to), at: at() });

/** The initial bearing (degrees from north) of the great circle a → b. */
function bearing(a, b) {
  const rad = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * rad) * Math.cos(b.lat * rad);
  const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lon - a.lon) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
}
// The compass: the view is north up, so N sits at the top; a cyan needle
// shows the course to the destination, with its bearing in degrees.
const course = computed(() => Math.round(bearing(at() || props.from, props.to)) % 360);
const POINTS = [msg('N'), msg('NE'), msg('E'), msg('SE'), msg('S'), msg('SW'), msg('W'), msg('NW')];
const courseLabel = computed(() => `${String(course.value).padStart(3, '0')}° ${t(POINTS[Math.round(course.value / 45) % 8])}`);

onMounted(() => {
  const previews = store.previews();
  if (!previews?.route || !host.value) {
    failed.value = true;
    return;
  }
  preview = previews.route(host.value, route(), { onReady: () => emit('ready'), onFailed: () => (failed.value = true) });
  preview.setActive(props.active);
  preview.setShown?.(props.shown);
});
watch(() => props.shown, (shown) => preview?.setShown?.(shown));
// Watched as strings: a fresh object each card refresh would count as a
// change every two seconds.
watch(
  () => `${props.from?.code}|${props.to?.code}|${props.at?.lat?.toFixed?.(4)}|${props.at?.lon?.toFixed?.(4)}`,
  () => preview?.update(route()),
);
watch(
  () => props.active,
  (active) => preview?.setActive(active),
);
onBeforeUnmount(() => {
  preview?.destroy();
  preview = null;
});
</script>

<template>
  <div v-if="!failed" class="route-globe">
    <div ref="host" class="route-globe__scene" aria-hidden="true"></div>
    <div class="route-globe__compass" :title="t('Course to {code}: {course}', { code: to.code, course: courseLabel })">
      <svg viewBox="-24 -24 48 48" aria-hidden="true">
        <circle r="19" class="route-globe__compass-ring" />
        <g class="route-globe__compass-ticks">
          <line v-for="deg in [0, 45, 90, 135, 180, 225, 270, 315]" :key="deg" :transform="`rotate(${deg})`" y1="-19" :y2="deg % 90 ? -16.5 : -15" />
        </g>
        <text y="-9.5" class="route-globe__compass-n">{{ t('N') }}</text>
        <g :transform="`rotate(${course})`" class="route-globe__compass-needle">
          <path d="M0 -14 L3 2 L0 0 L-3 2 Z" />
        </g>
        <circle r="1.6" class="route-globe__compass-hub" />
      </svg>
      <span>{{ courseLabel }}</span>
    </div>
  </div>
</template>
