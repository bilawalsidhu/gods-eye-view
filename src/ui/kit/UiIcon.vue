<script setup>
/** A Material Symbols glyph; the name must be in index.html's `icon_names`. */
defineProps({
  name: { type: String, required: true },
  size: { type: Number, default: 18 },
});
</script>

<template>
  <span
    class="ui-icon material-symbols-outlined"
    :style="{ fontSize: `${size}px` }"
    aria-hidden="true"
    >{{ name }}</span
  >
</template>
