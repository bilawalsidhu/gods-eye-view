<script setup>
import { computed, onBeforeUnmount } from 'vue';
import RailCardBlocks from './RailCardBlocks.vue';
import UiBadge from '../kit/UiBadge.vue';

// One keyed card: a disclosure header and its blocks. The owner decides
// which card is open.
const props = defineProps({
  card: { type: Object, required: true },
  cardClassName: { type: String, default: '' },
  badgeClassName: { type: String, default: '' },
  onParams: { type: Function, default: () => {} },
  onOpen: { type: Function, default: () => {} },
});
const bodyId = `rail-card-body-${nextBodyId()}`;
const open = computed(() => props.card.open !== false);
// A removed card's header opens nothing.
let live = true;
onBeforeUnmount(() => {
  live = false;
});
const select = () => live && props.onOpen(props.card.id);
</script>

<script>
let bodies = 0;
const nextBodyId = () => ++bodies;
</script>

<template>
  <article
    :class="`rail-card${cardClassName ? ` ${cardClassName}` : ''}${open ? ' is-open' : ''}`"
    :data-card-id="card.id"
    :data-open="String(open)"
    ><button
      class="rail-card-header"
      type="button"
      :aria-controls="bodyId"
      :aria-expanded="String(open)"
      @click="select"
      ><span class="rail-card-labels"
        ><span class="rail-card-heading"
          ><span class="data-icon" aria-hidden="true" :hidden="!card.icon">{{
            card.icon || ''
          }}</span
          ><span class="rail-card-title rail-card-nowrap" :title="card.title">{{
            card.title
          }}</span></span
        ><UiBadge
          :class="`gev-status-badge--plain rail-card-badge${badgeClassName ? ` ${badgeClassName}` : ''}`"
          :hidden="!card.badge"
          >{{ card.badge || '' }}</UiBadge
        ></span
      ><span class="rail-card-disclosure" aria-hidden="true">{{
        open ? '▾' : '▸'
      }}</span
      ><span
        :class="`rail-card-compact${card.compactStatus ? ' status' : ''}`"
        :hidden="open"
        >{{ card.compact || '' }}</span
      ></button
    ><div :id="bodyId" class="rail-card-body" :hidden="!open"
      ><RailCardBlocks
        :blocks="card.blocks || []"
        :card-id="card.id"
        :on-params="onParams" /></div
  ></article>
</template>
