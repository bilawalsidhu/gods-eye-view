<script setup>
import { computed, onBeforeUnmount } from 'vue';
import { storeToRefs } from 'pinia';
import { useWorldOverlayCardsStore } from '../../stores/worldOverlayCards.js';

// The selected and tracked map cards, drawn as elements. The world overlay
// still solves where each card goes and paints its leader; it publishes the
// card list here and writes every frame's position through `write`, so a
// camera move never re-renders this component.
const store = useWorldOverlayCardsStore();
const { view } = storeToRefs(store);

// The overlay's own tokens, so these cards and its canvas cards match.
const tokens = computed(() => {
  const style = view.value?.style;
  return style
    ? {
        '--overlay-card-bg': style.background,
        '--overlay-card-bg-selected': style.selectedBackground,
        '--overlay-card-border': style.border,
        '--overlay-card-border-selected': style.selectedBorder,
        '--overlay-card-title': style.title,
        '--overlay-card-detail': style.detail,
        '--overlay-card-accent': style.accent,
        '--overlay-card-font-card': style.fontTitle,
        '--overlay-card-font-selected': style.fontSelected,
        '--overlay-card-font-tracked': style.fontTrackedTitle,
        '--overlay-card-font-detail': style.fontDetail,
        '--overlay-card-font-tracked-detail': style.fontTrackedDetail,
      }
    : null;
});

const elements = new Map();
// The last position written for each card, so a card that mounts after its
// first frame is placed at once and an unchanged frame writes nothing.
const placed = new Map();
let stamp = 0;

function apply(element, state) {
  const ratio = globalThis.devicePixelRatio || 1;
  const x = Math.round(state.x * ratio) / ratio;
  const y = Math.round(state.y * ratio) / ratio;
  element.style.transform =
    state.scale === 1
      ? `translate3d(${x}px, ${y}px, 0)`
      : `translate3d(${x}px, ${y}px, 0) scale(${state.scale})`;
  element.style.opacity = String(state.alpha);
}

function write(frames, count) {
  stamp++;
  for (let i = 0; i < count; i++) {
    const frame = frames[i];
    let state = placed.get(frame.key);
    if (!state) {
      state = { x: NaN, y: NaN, scale: NaN, alpha: NaN, stamp: 0 };
      placed.set(frame.key, state);
    }
    state.stamp = stamp;
    if (
      state.x === frame.x &&
      state.y === frame.y &&
      state.scale === frame.scale &&
      state.alpha === frame.alpha
    )
      continue;
    state.x = frame.x;
    state.y = frame.y;
    state.scale = frame.scale;
    state.alpha = frame.alpha;
    const element = elements.get(frame.key);
    if (element) apply(element, state);
  }
  if (placed.size > count)
    for (const [key, state] of placed)
      if (state.stamp !== stamp) placed.delete(key);
}

function bind(key, element) {
  if (!element) {
    elements.delete(key);
    return;
  }
  elements.set(key, element);
  const state = placed.get(key);
  if (state) apply(element, state);
}

const box = (card) => ({
  width: `${card.w}px`,
  height: `${card.h}px`,
  ...(card.accent ? { '--overlay-card-accent': card.accent } : null),
  '--overlay-card-pad-x': `${card.padX}px`,
  '--overlay-card-pad-y': `${card.padY}px`,
  '--overlay-card-title-h': `${card.titleH}px`,
  '--overlay-card-line-h': `${card.lineH}px`,
});

store.connectWriter(write);
onBeforeUnmount(() => store.connectWriter(null));
</script>

<template>
  <div id="world-overlay-cards" :style="tokens">
    <div v-for="card in view?.cards ?? []" :key="card.key" :ref="(element) => bind(card.key, element)" class="world-overlay-card" :class="`is-${card.kind}`" :data-overlay-card="card.key" :style="box(card)">
      <p class="world-overlay-card-title">{{ card.title }}</p>
      <p v-for="(line, index) in card.details" :key="index" class="world-overlay-card-detail">{{ line }}</p>
    </div>
  </div>
</template>

<style scoped>
#world-overlay-cards {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
/* Sized to the rectangle the overlay solved with, so what is drawn is what
   collided. Hidden until the first frame places it. */
.world-overlay-card {
  position: absolute;
  inset-block-start: 0;
  inset-inline-start: 0;
  box-sizing: border-box;
  overflow: hidden;
  padding: calc(var(--overlay-card-pad-y) - 1px) calc(var(--overlay-card-pad-x) - 1px);
  border: 1px solid var(--overlay-card-border);
  border-radius: 4px;
  background: var(--overlay-card-bg);
  opacity: 0;
  transform-origin: 0 0;
  will-change: transform, opacity;
  contain: strict;
  direction: ltr;
  text-align: left;
  white-space: nowrap;
}
.world-overlay-card p {
  margin: 0;
  unicode-bidi: plaintext;
}
.world-overlay-card-title {
  height: var(--overlay-card-title-h);
  color: var(--overlay-card-title);
  font: var(--overlay-card-font-card);
  line-height: var(--overlay-card-title-h);
}
.world-overlay-card-detail {
  height: var(--overlay-card-line-h);
  color: var(--overlay-card-detail);
  font: var(--overlay-card-font-detail);
  line-height: var(--overlay-card-line-h);
}
.world-overlay-card.is-selected {
  border-color: var(--overlay-card-border-selected);
  background: var(--overlay-card-bg-selected);
  box-shadow: 0 4px 18px rgb(0 0 0 / 35%);
}
.world-overlay-card.is-selected .world-overlay-card-title {
  font: var(--overlay-card-font-selected);
  line-height: var(--overlay-card-title-h);
}
.world-overlay-card.is-tracked {
  border-color: color-mix(in srgb, var(--overlay-card-accent) 70%, transparent);
  border-radius: 5px;
  box-shadow: 0 4px 18px rgb(0 0 0 / 35%);
  text-align: center;
}
.world-overlay-card.is-tracked .world-overlay-card-title {
  font: var(--overlay-card-font-tracked);
  line-height: var(--overlay-card-title-h);
}
.world-overlay-card.is-tracked .world-overlay-card-detail {
  font: var(--overlay-card-font-tracked-detail);
  line-height: var(--overlay-card-line-h);
}
</style>
