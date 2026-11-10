<script setup>
// The named areas of a Contacts subject or contact, one per line.
defineProps({ names: { type: Object, required: true } });
</script>

<template>
  <details class="military-awareness-names"><summary>{{ names.summary }}</summary><div class="ui-scroll"><template v-for="(name, index) in names.names" :key="index"><br v-if="index">{{ name }}</template></div></details>
</template>
