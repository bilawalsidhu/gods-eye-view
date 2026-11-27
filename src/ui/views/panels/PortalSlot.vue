<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';

const props = defineProps({
  portal: { type: Object, required: true },
  name: { type: String, required: true },
  shown: { type: Function, default: () => true },
  fallback: { type: Function, default: null },
});
const slot = ref(null);
let offer;
onMounted(() => {
  offer = props.portal.offer(props.name, slot.value, {
    shown: () => props.shown(),
    fallback: () => props.fallback?.() ?? null,
  });
});
onBeforeUnmount(() => props.portal.withdraw(offer));
</script>

<template><div ref="slot"></div></template>
