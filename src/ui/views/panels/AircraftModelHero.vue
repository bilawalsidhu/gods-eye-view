<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { aircraftModelSpec, fleetModelSet, fleetModelSetLoading } from '../../../data/fleetModels.js';
import { t } from '../../../i18n/index.js';
import { useEntityCardStore } from '../../stores/entityCard.js';
import PreviewHud from './PreviewHud.vue';

// The selected aircraft's own model, turning slowly at the top of its card:
// the same fleet model the globe draws for its type, from the bytes loaded at
// startup, so nothing is fetched when a card opens. The renderer draws it in
// a small scene of its own (the `cardPreviews` hook); this tile lays the
// callouts and HUD over it. As it turns it changes look: a whole rotation as
// it is, then a short wireframe scan, then round again.
//
// While it turns, one callout at a time sits in the frame's top-left corner,
// HUD-style, telling something worked out about the flight (phase, flight
// level, Mach, what its squawk means, signal age). Each runs three states:
//   enter 0-2.3 s  the label and value slide in;
//   hold  2.3-5.2 s a thin timer under the value fills;
//   exit  5.2-6.2 s the text fades; a short gap, then the next one.
const props = defineProps({
  /** `{typeCode, category, callsign}`: what picks the aircraft's fleet model. */
  aircraft: { type: Object, default: null },
  /** The aircraft's heading, so the turntable starts facing its way. */
  heading: { type: Number, default: 0 },
  /** `[{label, value}]` figures to call out, in order. */
  callouts: { type: Array, default: () => [] },
  /** Whether the tile is the one showing; a hidden one stops drawing. */
  active: { type: Boolean, default: true },
});
const emit = defineEmits(['failed', 'cycle']);
const store = useEntityCardStore();

const host = ref(null);
const failed = ref(false);
watch(failed, (now) => now && emit('failed'));
const phase = ref('plain');
let preview = null;

// One callout's whole life: enter 2.3 s + hold 2.9 s + exit 1.0 s + 0.3 s gap.
const CYCLE_MS = 6500;
const CALLOUT_TIMING = { enter: 2300, leave: 1000 };
const page = ref(0);
let cycle = null;
const shown = computed(() => {
  const list = props.callouts;
  if (!list.length) return null;
  const index = page.value % list.length;
  return { ...list[index], index, total: list.length };
});
const pad = (n) => String(n).padStart(2, '0');

/** The fleet model's spec and bytes, or null when it has none. */
function fleetModel(set, aircraft) {
  if (!set || !aircraft) return null;
  const spec = aircraftModelSpec(set, aircraft);
  const gltf = set.bytes.get(spec.model);
  return gltf ? { gltf, basePath: spec.url } : null;
}

let showing = 0;
async function show() {
  preview?.destroy();
  preview = null;
  phase.value = 'plain';
  const asked = ++showing;
  // A card opened before the Flights layer's model set has loaded waits for
  // that load rather than giving up.
  let set = fleetModelSet();
  if (!set) set = await fleetModelSetLoading()?.catch(() => null);
  if (asked !== showing) return;
  const previews = store.previews();
  const model = fleetModel(set, props.aircraft);
  if (!previews?.model || !model || !host.value) {
    failed.value = true;
    return;
  }
  preview = previews.model(
    host.value,
    { ...model, heading: props.heading },
    {
      onPhase: (next) => (phase.value = next),
      onCycle: (ms) => emit('cycle', ms),
      onFailed: () => (failed.value = true),
    },
  );
  preview.setActive(props.active);
}

onMounted(() => {
  show();
  // Under reduced motion the first set of callouts stays.
  const still = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  if (!still) cycle = setInterval(() => page.value++, CYCLE_MS);
});
watch(
  () => {
    const a = props.aircraft;
    return `${a?.typeCode ?? ''}|${a?.category ?? ''}|${a?.callsign ?? ''}`;
  },
  show,
);
watch(
  () => props.active,
  (active) => preview?.setActive(active),
);
onBeforeUnmount(() => {
  showing++;
  clearInterval(cycle);
  preview?.destroy();
  preview = null;
});
</script>

<template>
  <div v-if="!failed" class="aircraft-hero">
    <div ref="host" class="aircraft-hero__scene" aria-hidden="true"></div>
    <PreviewHud variant="model" />
    <Transition name="aircraft-hero-legend">
      <p v-if="phase === 'scan'" class="aircraft-hero__scan" aria-hidden="true">{{ t('Scanning') }}</p>
    </Transition>
    <Transition name="aircraft-hero-callout" mode="out-in" :duration="CALLOUT_TIMING">
      <div v-if="shown" :key="page" class="aircraft-hero__callout">
        <span class="aircraft-hero__label">{{ shown.label }}<em>{{ pad(shown.index + 1) }} / {{ pad(shown.total) }}</em></span>
        <strong class="aircraft-hero__value">{{ shown.value }}</strong>
        <i class="aircraft-hero__timer" aria-hidden="true"></i>
      </div>
    </Transition>
  </div>
</template>
