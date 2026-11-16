<script setup>
import { storeToRefs } from 'pinia';
import { useImagerySplitStore } from '../../stores/imagerySplit.js';

// The before/after imagery dividers, as their splits (src/ui/imagerySplit.js)
// present them. Each line is a direct child of the body, above the rails; its
// handle reports pointer and keyboard input back to its split.
const { splits } = storeToRefs(useImagerySplitStore());
const optional = (value) => value ?? undefined;
</script>

<template>
  <Teleport to="body">
    <div v-for="split in splits" :key="split.key" :id="optional(split.view.id)" :hidden="split.view.hidden"><span class="before" :title="optional(split.view.beforeTitle)">{{ split.view.beforeLabel }}</span><button type="button" :class="optional(split.view.handleClass)" role="slider" :aria-label="optional(split.view.ariaLabel)" aria-valuemin="0" aria-valuemax="100" aria-orientation="horizontal" :aria-valuenow="split.view.valueNow" :aria-valuetext="split.view.valueText" @pointerdown="split.controls.pointerdown($event)" @pointermove="split.controls.pointermove($event)" @pointerup="split.controls.pointerup($event)" @pointercancel="split.controls.pointerup($event)" @keydown="split.controls.keydown($event)">↔</button><span class="after" :title="optional(split.view.afterTitle)">{{ split.view.afterLabel }}</span></div>
  </Teleport>
</template>
