<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

// Small moving HUD marks laid over a card's preview, for look only: corner
// brackets, a ruler down the right edge with a marker riding it, a tick
// scale crawling along the bottom, a signal meter and a blinking dot at the
// top right, and a slow dashed ring round the centre with its four ticks.
// The ground view instead lays a square grid over the image, with cells lit
// one by one at random, each fading as the next lights, and a scan line
// sweeping down. Nothing here takes the pointer or says
// anything; it all stops under reduced motion.
const props = defineProps({
  /** 'model' over the turning craft, 'ground' over the view beneath. */
  variant: { type: String, default: 'model' },
  /** Whether the preview is showing; the grid scan steps only while it is. */
  running: { type: Boolean, default: true },
});

const CELL = 22;
const STEP_MS = 260;
const TRAIL = 4;

const root = ref(null);
const grid = ref({ cols: 0, rows: 0, left: 0, top: 0 });
const cells = ref([]);
let timer = 0;
let lit = [];
let serial = 0;

function measure() {
  const box = root.value?.getBoundingClientRect();
  if (!box?.width) return false;
  const cols = Math.floor(box.width / CELL);
  const rows = Math.floor(box.height / CELL);
  // The grid is centred in the view.
  grid.value = { cols, rows, left: (box.width - cols * CELL) / 2, top: (box.height - rows * CELL) / 2 };
  return cols > 0 && rows > 0;
}

// Each step lights a random cell (never the one just lit) and dims the
// ones before it, so a few faint cells fade out behind the newest.
function step() {
  if (!grid.value.cols && !measure()) return;
  const { cols, rows, left, top } = grid.value;
  let col;
  let row;
  do {
    col = Math.floor(Math.random() * cols);
    row = Math.floor(Math.random() * rows);
  } while (cols * rows > 1 && lit[0]?.col === col && lit[0]?.row === row);
  lit = [{ key: ++serial, col, row }, ...lit].slice(0, TRAIL);
  cells.value = lit.map((cell, back) => ({
    key: cell.key,
    x: left + cell.col * CELL,
    y: top + cell.row * CELL,
    fade: 1 - back / TRAIL,
  }));
}

function sync() {
  clearInterval(timer);
  timer = 0;
  const still = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  if (props.variant === 'ground' && props.running && !still) {
    measure();
    timer = setInterval(step, STEP_MS);
  }
}
onMounted(sync);
watch(() => props.running, sync);
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <div ref="root" class="preview-hud" :class="`preview-hud--${variant}`" aria-hidden="true">
    <template v-if="variant === 'ground'">
      <span class="preview-hud__grid" :style="{ left: `${grid.left}px`, top: `${grid.top}px`, width: `${grid.cols * CELL}px`, height: `${grid.rows * CELL}px` }"></span>
      <i v-for="cell in cells" :key="cell.key" class="preview-hud__cell" :style="{ transform: `translate(${cell.x}px, ${cell.y}px)`, opacity: cell.fade }"></i>
    </template>
    <i class="preview-hud__corner preview-hud__corner--tl"></i>
    <i class="preview-hud__corner preview-hud__corner--tr"></i>
    <i class="preview-hud__corner preview-hud__corner--bl"></i>
    <i class="preview-hud__corner preview-hud__corner--br"></i>
    <span class="preview-hud__ruler"><i></i></span>
    <span class="preview-hud__scale"></span>
    <span class="preview-hud__meter"><i></i><i></i><i></i><i></i><b></b></span>
    <svg class="preview-hud__ring" viewBox="-100 -100 200 200">
      <circle r="92" class="preview-hud__dash" />
      <path d="M0 -100 V-90 M0 90 V100 M-100 0 H-90 M90 0 H100" class="preview-hud__ticks" />
    </svg>
    <span v-if="variant === 'ground'" class="preview-hud__sweep"></span>
  </div>
</template>
