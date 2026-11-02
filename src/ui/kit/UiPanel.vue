<script setup>
import { vClassToggle } from '../rail/classToggle.js';
import UiPanelToggle from './UiPanelToggle.vue';

// Core's panel, with a name, title, slots and v-model:collapsed. It draws Core's panel markup
// (glow, inner, a header with the title, badges, divider, actions and the
// collapse button, then the body) and keeps Core's classes beside the kit's.
// `collapsed` does not hide the body: the root's classes
// stay as rendered, and whatever owns the panel's state writes its
// `collapsed` class at once (PanelChrome, through vPanelState), because the
// rails measure a panel in the task that opens it. `collapsed` drives the
// button and the kit's `ui-panel--collapsed`, toggled without a re-render.
// There is no Close: Core's panels collapse.
const props = defineProps({
  /** The root's id, its inner's class (`{id}-inner`) and the button's target. */
  id: { type: String, required: true },
  /** The heading, already translated; also the button's "Expand {name}". */
  title: { type: String, required: true },
  /** The heading's tip. */
  hint: { type: String, default: undefined },
  tag: { type: String, default: 'div' },
  collapsible: { type: Boolean, default: false },
  collapsed: { type: Boolean, default: false },
  /** A right-rail panel opens and closes sideways: ◀ / ▶, not + / −. */
  sideways: { type: Boolean, default: false },
  /** Words that replace "Expand/Collapse {title}" on the button. */
  toggleWords: { type: Object, default: null },
  glow: { type: Boolean, default: true },
  /** The inner scrolls with Core's scroll bar. */
  scroll: { type: Boolean, default: false },
  /** The inner is a scroller the right rail keeps in view. */
  railScroller: { type: Boolean, default: false },
});
const emit = defineEmits(['update:collapsed']);
</script>

<template>
  <component
    :is="props.tag"
    :id="props.id"
    v-class-toggle="{
      'ui-panel--collapsed': props.collapsible && props.collapsed,
    }"
    class="ui-panel panel-collapsible"
  >
    <div v-if="props.glow" class="panel-glow"></div>
    <div
      :class="[`${props.id}-inner`, { 'ui-scroll': props.scroll }]"
      :data-rail-scroller="props.railScroller ? '' : undefined"
    >
      <div class="ui-panel__head panel-header">
        <slot name="title">
          <span class="ui-panel__title panel-title" :title="props.hint">{{
            props.title
          }}</span>
        </slot>
        <slot name="badge" />
        <span class="panel-divider"></span>
        <slot name="actions" />
        <UiPanelToggle
          v-if="props.collapsible"
          :target="props.id"
          :name="props.title"
          :collapsed="props.collapsed"
          :sideways="props.sideways"
          :words="props.toggleWords"
          @update:collapsed="emit('update:collapsed', $event)"
        />
      </div>
      <slot />
    </div>
  </component>
</template>
