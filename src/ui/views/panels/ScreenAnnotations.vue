<script setup>
import { storeToRefs } from 'pinia';
import { useScreenAnnotationsStore } from '../../stores/screenAnnotations.js';

// The screen-space annotation board over the page, as the screen annotation
// renderer (src/annotations/screenAnnotationRenderer.js) presents it.
const { board, controls } = storeToRefs(useScreenAnnotationsStore());

// Each element goes to the renderer it was rendered for, which measures it.
const vAnnoElement = {
  mounted(el, { value }) {
    controls.value?.attach(value.owner, value.key, value.kind, el);
  },
  beforeUnmount(el, { value }) {
    controls.value?.attach(value.owner, value.key, value.kind, null);
  },
};
// The draw-on stroke reads solid once its dashoffset transition ends.
const onTransitionEnd = (owner, key) => (event) => {
  if (event.propertyName === 'stroke-dashoffset')
    controls.value?.drawn(owner, key);
};
const display = (value) => (value ? { display: value } : undefined);
const drawStyle = (mark, child) =>
  mark.drawn && child.attrs.class?.includes('gev-draw')
    ? { strokeDasharray: 'none', ...display(child.display) }
    : display(child.display);
</script>

<template>
  <Teleport v-if="board" to="body">
    <div class="gev-screen-whiteboard"><svg class="gev-screen-whiteboard-svg" preserveAspectRatio="none" :viewBox="board.viewBox ?? undefined"><defs><filter id="gev-sketch" x="-20%" y="-20%" width="140%" height="140%"><feTurbulence type="fractalNoise" baseFrequency="0.014" numOctaves="2" seed="7" result="n" /><feDisplacementMap in="SourceGraphic" in2="n" scale="2.2" xChannelSelector="R" yChannelSelector="G" /></filter><marker v-for="marker in board.markers" :id="`gev-arrow-${marker.key}`" :key="marker.key" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" :fill="marker.fill" /></marker></defs><g v-for="mark in board.marks" :key="mark.key" v-anno-element="{ owner: board.owner, key: mark.key, kind: 'group' }" :class="mark.className" :opacity="mark.opacity" :style="display(mark.display)" :onTransitionend="onTransitionEnd(board.owner, mark.key)"><template v-for="child in mark.children" :key="child.key"><polygon v-if="child.tag === 'polygon'" v-bind="child.attrs" :style="drawStyle(mark, child)" /><polyline v-else-if="child.tag === 'polyline'" v-bind="child.attrs" :style="drawStyle(mark, child)" /><path v-else-if="child.tag === 'path'" v-bind="child.attrs" :style="drawStyle(mark, child)" /><circle v-else-if="child.tag === 'circle'" v-bind="child.attrs" :style="display(child.display)" /><line v-else-if="child.tag === 'line'" v-bind="child.attrs" :style="display(child.display)" /><g v-else-if="child.tag === 'callout'" class="gev-anno-callout" :transform="child.transform ?? undefined"><rect rx="5" class="gev-anno-card" v-bind="child.card" /><rect class="gev-anno-accent" width="3" rx="1.5" :fill="child.fill" v-bind="child.accent" /><text v-anno-element="{ owner: board.owner, key: mark.key, kind: 'text' }" class="gev-anno-text" x="9" y="16">{{ child.text }}</text></g></template></g></svg></div>
  </Teleport>
</template>
