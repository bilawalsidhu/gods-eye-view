<script setup>
import RailCard from './RailCard.vue';

// Keyed cards in the owner's order; the owner owns the open-card choice.
defineProps({
  cards: { type: Array, default: () => [] },
  cardClassName: { type: String, default: '' },
  badgeClassName: { type: String, default: '' },
  onParams: { type: Function, default: () => {} },
  onOpen: { type: Function, default: () => {} },
});
</script>

<template>
  <RailCard
    v-for="card in cards"
    :key="card.id"
    :card="card"
    :card-class-name="cardClassName"
    :badge-class-name="badgeClassName"
    :on-params="onParams"
    :on-open="onOpen"
  />
</template>
