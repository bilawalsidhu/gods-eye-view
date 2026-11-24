<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { VOICE_VISUALIZER_BARS } from '../../../voice/control.js';
import { useVoiceStore } from '../../stores/voice.js';

// The dock waveform. Its bars change every animation frame while voice is
// live, so they render here alone, not with the rest of the control.
const { bars, view } = storeToRefs(useVoiceStore());
const barStyle = (index) => ({
  '--bar': index,
  ...(bars.value?.[index] && {
    '--audio-level': bars.value[index].level,
    '--audio-opacity': bars.value[index].opacity,
  }),
});

// The same levels drawn as a wave: a smooth line through the bars, swinging
// above and below the middle by each bar's height, with two fainter traces
// at different amplitudes. Layouts that want bars hide it; the command bar
// shows the wave instead. While it is hidden (it then has no size) no path
// is computed, though the bars still change every frame.
const voiceMode = computed(() => view.value?.root?.assistantMode === 'voice');
const waveEl = ref(null);
const waveShown = ref(false);
let sizeObserver = null;
watch(waveEl, (element) => {
  sizeObserver?.disconnect();
  sizeObserver = null;
  waveShown.value = false;
  if (!element || typeof ResizeObserver !== 'function') return;
  sizeObserver = new ResizeObserver(([entry]) => {
    waveShown.value = entry.contentRect.width > 0 && entry.contentRect.height > 0;
  });
  sizeObserver.observe(element);
});
onBeforeUnmount(() => sizeObserver?.disconnect());
const W = 300;
const H = 40;
const MID = H / 2;
const levelPx = (index) => {
  const raw = Number.parseFloat(bars.value?.[index]?.level);
  return Number.isFinite(raw) ? raw : 5;
};
function wavePath(phase, amplitude = 1) {
  const n = VOICE_VISUALIZER_BARS;
  const step = W / (n + 1);
  const points = [{ x: 0, y: MID }];
  for (let i = 0; i < n; i++) {
    // A 5px standby bar is a flat line; louder bars swing further.
    const swing = Math.min(MID - 2, Math.max(0, levelPx(i) - 5) * 0.6 + 1.2);
    const sign = (i + phase) % 2 === 0 ? -1 : 1;
    points.push({ x: step * (i + 1), y: MID + sign * swing * amplitude });
  }
  points.push({ x: W, y: MID });
  // Smooth through the points with quadratic curves via their midpoints.
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const mx = (points[i].x + points[i + 1].x) / 2;
    const my = (points[i].y + points[i + 1].y) / 2;
    d += ` Q ${points[i].x.toFixed(1)} ${points[i].y.toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
  }
  return `${d} L ${W} ${MID}`;
}
const FLAT = `M 0 ${MID} L ${W} ${MID}`;
const wave = computed(() =>
  waveShown.value
    ? { main: wavePath(0), echo: wavePath(1), soft: wavePath(0, 0.45) }
    : { main: FLAT, echo: FLAT, soft: FLAT },
);
</script>

<template>
  <div class="gev-voice-visualizer" aria-hidden="true">
        <span v-for="index in VOICE_VISUALIZER_BARS" :key="index" :style="barStyle(index - 1)"></span>
        <svg v-if="voiceMode" ref="waveEl" class="gev-voice-wave" :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none">
          <path class="gev-voice-wave__soft" :d="wave.soft" />
          <path class="gev-voice-wave__echo" :d="wave.echo" />
          <path class="gev-voice-wave__main" :d="wave.main" />
        </svg>
      </div>
</template>

<style scoped>
.gev-voice-wave { display: none; }
</style>
